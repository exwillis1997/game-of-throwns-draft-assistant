(function attachDraftAssistantEngine(root) {
  "use strict";

  const DEFAULT_CONFIG = Object.freeze({
    profileVersion: 1,
    scoring: "ppr",
    secondsPerPick: 30,
    teams: 12,
    rounds: 13,
    rosterSize: 13,
    benchSlots: 4,
    draftSlot: 1,
    rankingModel: "sharp-value",
    suggestionPosition: "ALL",
    rbPreference: 1,
    earlyQbTeBlockEnabled: false,
    earlyQbTeOneTotalEnabled: false,
    ecrWeight: 0.55,
    vegasWeight: 0.45,
    autoDraftEnabled: false,
    autoDraftMinSeconds: 5,
    autoDraftMaxSeconds: 25,
    replacementRanks: { QB: 13, RB: 31, WR: 31, TE: 13 },
    rosterMax: { QB: 4, RB: 8, WR: 8, TE: 3, DST: 3, K: 3 },
    starterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1, K: 1 },
  });

  // Apply this fork's league rules even when storage contains the upstream preset.
  function loadConfig(stored = {}) {
    const current = stored.profileVersion === DEFAULT_CONFIG.profileVersion;
    const config = { ...DEFAULT_CONFIG, ...stored };
    for (const key of ["profileVersion", "scoring", "secondsPerPick", "teams", "rounds", "rosterSize", "benchSlots", "starterSlots", "rosterMax", "replacementRanks"]) {
      config[key] = typeof DEFAULT_CONFIG[key] === "object" ? { ...DEFAULT_CONFIG[key] } : DEFAULT_CONFIG[key];
    }
    if (!current) {
      config.draftSlot = DEFAULT_CONFIG.draftSlot;
      config.autoDraftEnabled = false;
    }
    if (!Number.isInteger(config.draftSlot) || config.draftSlot < 1 || config.draftSlot > config.teams) config.draftSlot = DEFAULT_CONFIG.draftSlot;
    config.autoDraftMinSeconds = Math.min(25, Math.max(5, Math.round(Number(config.autoDraftMinSeconds) || 5)));
    config.autoDraftMaxSeconds = Math.min(25, Math.max(config.autoDraftMinSeconds, Math.round(Number(config.autoDraftMaxSeconds) || 25)));
    if (config.earlyQbTeBlockEnabled) config.earlyQbTeOneTotalEnabled = false;
    return config;
  }

  function validateDataset(dataset) {
    if (!Array.isArray(dataset?.players) || !dataset.players.length) return "Rankings must contain a nonempty players array.";
    if (dataset.meta?.example) return "The example rankings are synthetic. Supply a real full-PPR rankings file.";
    if (dataset.meta?.scoring !== "ppr") return "Rankings must be full-PPR (meta.scoring: ppr). Half-PPR totals and ranks cannot be relabeled or converted without source data.";
    if (dataset.meta?.leagueTeams !== 12) return "Rankings must be prepared for 12 teams (meta.leagueTeams: 12).";
    if (dataset.players.some(player => !player || typeof player.name !== "string" || !player.name.trim() || !Object.hasOwn(DEFAULT_CONFIG.rosterMax, positionKey(player.position)))) return "Each player needs a name and a supported position.";
    return null;
  }

  // ESPN uses mascot + D/ST while rankings use full franchise names.
  const DEFENSE_NAMES = ["Houston Texans","Denver Broncos","Los Angeles Rams","Seattle Seahawks","Philadelphia Eagles","Pittsburgh Steelers","Minnesota Vikings","New England Patriots","Jacksonville Jaguars","Los Angeles Chargers","Baltimore Ravens","Kansas City Chiefs","Green Bay Packers","Detroit Lions","Buffalo Bills","Cleveland Browns","San Francisco 49ers","New Orleans Saints","Atlanta Falcons","Indianapolis Colts","Chicago Bears","Dallas Cowboys","New York Giants","Carolina Panthers","Tampa Bay Buccaneers","Tennessee Titans","Cincinnati Bengals","Las Vegas Raiders","Washington Commanders","Miami Dolphins","New York Jets","Arizona Cardinals"];
  const DEFENSE_ALIASES = new Map();
  for (const name of DEFENSE_NAMES) {
    const canonical = name.toLowerCase();
    const mascot = canonical.split(" ").at(-1);
    for (const base of [canonical, mascot]) {
      for (const suffix of ["", " d st", " dst", " defense", " def"]) DEFENSE_ALIASES.set(base + suffix, canonical);
    }
  }

  const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

  function normalizeName(value) {
    const parts = String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    while (parts.length && SUFFIXES.has(parts[parts.length - 1])) parts.pop();
    const collapsed = [];
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index].length === 1) {
        let initials = parts[index];
        while (parts[index + 1]?.length === 1) initials += parts[++index];
        collapsed.push(initials);
      } else collapsed.push(parts[index]);
    }
    const normalized = collapsed.join(" ");
    if (DEFENSE_ALIASES.has(normalized)) return DEFENSE_ALIASES.get(normalized);
    return ({
      "cameron skattebo": "cam skattebo",
      "cameron ward": "cam ward",
      "chigoziem okonkwo": "chig okonkwo",
      "kenneth gainwell": "kenny gainwell",
      "marquise brown": "hollywood brown",
      "nathaniel dell": "tank dell",
    })[normalized] || normalized;
  }

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function autoDraftWindowStatus(now, fireAt, deadlineAt, minimumSeconds) {
    if (![now, fireAt, deadlineAt, minimumSeconds].every(Number.isFinite)) return "invalid";
    if (now + 250 < fireAt) return "early";
    if (now > deadlineAt - minimumSeconds * 1000) return "late";
    return "ready";
  }

  function autoDraftRetryAt(now, deadlineAt, minimumSeconds, attemptCount, maximumAttempts = 2, delayMs = 1500) {
    if (![now, deadlineAt, minimumSeconds, attemptCount, maximumAttempts, delayMs].every(Number.isFinite)) return null;
    if (attemptCount >= maximumAttempts) return null;
    const retryAt = now + Math.max(0, delayMs);
    return retryAt < deadlineAt - minimumSeconds * 1000 ? retryAt : null;
  }

  function positionKey(position) {
    if (position === "D/ST" || position === "DEF") return "DST";
    return position;
  }

  function rbPriorityAdjustment(positionValue, rankingModel, strength = 1) {
    if (positionKey(positionValue) !== "RB") return 0;
    const boundedStrength = Math.max(0, Number(strength) || 0);
    return (rankingModel === "think-rmv" ? 1.5 : 0.025) * boundedStrength;
  }

  function pickInRound(overallPick, teams) {
    return ((overallPick - 1) % teams) + 1;
  }

  function roundForPick(overallPick, teams) {
    return Math.floor((overallPick - 1) / teams) + 1;
  }

  function overallPickFor(round, slot, teams) {
    return (round - 1) * teams + (round % 2 === 1 ? slot : teams - slot + 1);
  }

  function nextPickAfter(currentPick, slot, teams = DEFAULT_CONFIG.teams, rounds = DEFAULT_CONFIG.rounds) {
    if (!slot) return currentPick + teams;
    for (let round = 1; round <= rounds; round += 1) {
      const pick = overallPickFor(round, slot, teams);
      if (pick > currentPick) return pick;
    }
    return teams * rounds;
  }

  function opponentPicksUntilNext(currentPick, slot, teams = DEFAULT_CONFIG.teams, rounds = DEFAULT_CONFIG.rounds) {
    return Math.max(0, nextPickAfter(currentPick, slot, teams, rounds) - currentPick - 1);
  }

  function ownPicksBefore(currentPick, slot, teams = DEFAULT_CONFIG.teams, rounds = DEFAULT_CONFIG.rounds) {
    if (!slot) return null;
    let count = 0;
    for (let round = 1; round <= rounds; round += 1) {
      if (overallPickFor(round, slot, teams) < currentPick) count += 1;
    }
    return count;
  }

  function chooseTriggerSeconds(minimum, maximum, randomUnit = Math.random()) {
    const min = Math.min(25, Math.max(5, Math.round(Number(minimum) || 5)));
    const max = Math.min(25, Math.max(min, Math.round(Number(maximum) || 25)));
    const unit = Math.min(0.999999999, Math.max(0, Number(randomUnit) || 0));
    return min + Math.floor(unit * (max - min + 1));
  }

  function espnSearchTerm(player) {
    const name = String(player?.name || "").trim();
    if (positionKey(player?.position) !== "DST") return name;
    return name.split(/\s+/).at(-1) || name;
  }

  function countRoster(roster) {
    return roster.reduce((counts, player) => {
      const position = positionKey(player.position);
      counts[position] = (counts[position] || 0) + 1;
      return counts;
    }, {});
  }

  function maxStarterAssignments(rosterCounts, config) {
    const slots = config.starterSlots;
    const qb = Math.min(rosterCounts.QB || 0, slots.QB || 0);
    const dst = Math.min(rosterCounts.DST || 0, slots.DST || 0);
    const kicker = Math.min(rosterCounts.K || 0, slots.K || 0);
    const rb = Math.min(rosterCounts.RB || 0, slots.RB || 0);
    const wr = Math.min(rosterCounts.WR || 0, slots.WR || 0);
    const te = Math.min(rosterCounts.TE || 0, slots.TE || 0);
    const remainingRbWr = Math.max(0, (rosterCounts.RB || 0) - rb) + Math.max(0, (rosterCounts.WR || 0) - wr);
    const rbWr = Math.min(remainingRbWr, slots.RB_WR || 0);
    const remainingFlex = remainingRbWr - rbWr + Math.max(0, (rosterCounts.TE || 0) - te);
    const flex = Math.min(remainingFlex, slots.FLEX || 0);
    return qb + dst + kicker + rb + wr + te + rbWr + flex;
  }

  function canDraftPosition(positionValue, rosterCounts, config) {
    const position = positionKey(positionValue);
    if (!Object.hasOwn(config.rosterMax, position)) return false;
    const currentAtPosition = rosterCounts[position] || 0;
    if (currentAtPosition >= config.rosterMax[position]) return false;
    const rostered = Object.values(rosterCounts).reduce((total, count) => total + count, 0);
    if (rostered >= config.rosterSize) return false;
    const nextCounts = { ...rosterCounts, [position]: currentAtPosition + 1 };
    const benchNeeded = rostered + 1 - maxStarterAssignments(nextCounts, config);
    return benchNeeded <= config.benchSlots;
  }

  function isEarlyQbTeBlocked(positionValue, round, config, rosterCounts = {}) {
    if (round > 8) return false;
    const position = positionKey(positionValue);
    if (position !== "QB" && position !== "TE") return false;
    if (config.earlyQbTeBlockEnabled) return true;
    return Boolean(config.earlyQbTeOneTotalEnabled && (rosterCounts.QB || 0) + (rosterCounts.TE || 0) >= 1);
  }

  function replacementPoints(players, config) {
    const eligible = players.filter((player) => Number.isFinite(player.vegasPoints));
    const selected = new Set();
    const take = (positions, count) => {
      const candidates = eligible
        .filter((player) => positions.includes(positionKey(player.position)) && !selected.has(player))
        .sort((a, b) => b.vegasPoints - a.vegasPoints)
        .slice(0, count);
      for (const player of candidates) selected.add(player);
    };
    take(["QB"], config.teams * (config.starterSlots.QB || 0));
    take(["RB"], config.teams * (config.starterSlots.RB || 0));
    take(["WR"], config.teams * (config.starterSlots.WR || 0));
    take(["TE"], config.teams * (config.starterSlots.TE || 0));
    take(["RB", "WR"], config.teams * (config.starterSlots.RB_WR || 0));
    take(["RB", "WR", "TE"], config.teams * (config.starterSlots.FLEX || 0));

    const output = {};
    for (const position of ["QB", "RB", "WR", "TE"]) {
      output[position] = eligible
        .filter((player) => positionKey(player.position) === position && !selected.has(player))
        .sort((a, b) => b.vegasPoints - a.vegasPoints)[0]?.vegasPoints ?? null;
    }
    return output;
  }

  function rosterAdjustment(player, rosterCounts, round, config) {
    const position = positionKey(player.position);
    const count = rosterCounts[position] || 0;
    const max = config.rosterMax[position];
    if (max && count >= max) return -1;
    if (position === "DST" || position === "K") return round < config.rounds - 1 ? -0.6 : 0.03;
    if (position === "QB") {
      if (count >= 1) return round < 12 ? -0.34 : -0.12;
      if (round <= 2) return -0.14;
      return round >= 7 ? 0.04 : 0;
    }
    if (position === "TE") {
      if (count >= 1) return round < 10 ? -0.22 : -0.07;
      return 0;
    }
    const rbWr = (rosterCounts.RB || 0) + (rosterCounts.WR || 0);
    if ((position === "RB" || position === "WR") && rbWr < 6) return 0.07;
    return 0;
  }

  function sharpRosterAdjustment(player, rosterCounts, round, config) {
    let adjustment = rosterAdjustment(player, rosterCounts, round, config);
    const position = positionKey(player.position);
    if (position !== "RB" && position !== "WR") return adjustment;
    const same = rosterCounts[position] || 0;
    const other = rosterCounts[position === "RB" ? "WR" : "RB"] || 0;
    if (same >= 6) adjustment -= 0.24;
    else if (same >= 5 && same - other >= 2) adjustment -= 0.14;
    else if (same - other >= 3) adjustment -= 0.08;
    return adjustment;
  }

  function explain(player, context) {
    const reasons = [];
    if (context.vorp !== null && context.vorp >= 35) reasons.push(`+${Math.round(context.vorp)} pts over ${player.position} replacement`);
    if (Number.isFinite(player.sleeperAdp) && context.goneProbability >= 0.72) reasons.push("unlikely to reach your next pick");
    if (player.fantasyProsTier && player.fantasyProsTier <= 3) reasons.push(`FantasyPros tier ${player.fantasyProsTier}`);
    if ((player.position === "RB" || player.position === "WR") && context.rbWrCount < 6) reasons.push("fills a high-demand RB/WR slot");
    if (player.position === "QB" && context.round <= 2) reasons.push("QB depth keeps the early-round price high");
    return reasons.slice(0, 2).join("; ") || "best blended value among available players";
  }

  function explainSharp(player, context) {
    const reasons = [];
    if (Number.isFinite(player.draftSharks3dValue)) reasons.push(`DraftSharks 3D value ${Math.round(player.draftSharks3dValue)}`);
    if (Number.isFinite(context.timingAdp) && context.timingAdp - context.currentPick >= 12) reasons.push(`ESPN price near pick ${Math.round(context.timingAdp)}`);
    if (Number.isFinite(player.draftSharksCeiling) && Number.isFinite(player.draftSharksProjection) && player.draftSharksCeiling - player.draftSharksProjection >= 45) reasons.push("strong ceiling above median projection");
    if (context.goneProbability >= 0.72) reasons.push("unlikely to reach your next pick");
    if (context.vorp !== null && context.vorp >= 35) reasons.push(`Vegas +${Math.round(context.vorp)} over replacement`);
    return reasons.slice(0, 2).join("; ") || "best projection value at an efficient ESPN price";
  }

  function explainVegasSharks(player, context) {
    const reasons = [];
    if (context.vorp !== null) reasons.push(`Vegas ${context.vorp >= 0 ? "+" : ""}${Math.round(context.vorp)} over replacement`);
    if (Number.isFinite(player.draftSharks3dValue)) reasons.push(`DraftSharks 3D value ${Math.round(player.draftSharks3dValue)}`);
    if ((player.position === "RB" || player.position === "WR") && context.rbWrCount < 6) reasons.push("RB/WR scarcity priority");
    if (context.goneProbability >= 0.72) reasons.push("unlikely to reach your next pick");
    return reasons.slice(0, 2).join("; ") || "best Vegas-led value among available players";
  }

  function explainVegasOnly(player, context) {
    if (context.vorp !== null) return `Vegas ${context.vorp >= 0 ? "+" : ""}${Math.round(context.vorp)} points over ${player.position} replacement`;
    return "required roster position; no Vegas projection is available";
  }

  function offensiveSlots(config) {
    return Object.entries(config.starterSlots).filter(([slot]) => slot !== "DST" && slot !== "K")
      .flatMap(([slot, count]) => Array(count).fill(slot));
  }

  function eligibleForSlot(positionValue, slot) {
    const position = positionKey(positionValue);
    if (slot === position) return true;
    if (slot === "RB_WR") return position === "RB" || position === "WR";
    return slot === "FLEX" && (position === "RB" || position === "WR" || position === "TE");
  }

  function thinkProjection(player) {
    const vegas = Number.isFinite(player.vegasPoints) ? player.vegasPoints : null;
    const consensus = Number.isFinite(player.draftSharksConsensusProjection)
      ? player.draftSharksConsensusProjection
      : Number.isFinite(player.draftSharksProjection)
        ? player.draftSharksProjection
        : null;
    if (vegas !== null && consensus !== null) return 0.65 * vegas + 0.35 * consensus;
    return vegas ?? consensus;
  }

  function thinkProjectionMap(players) {
    const bases = new Map(players.map((player) => [normalizeName(player.name), thinkProjection(player)]));
    const adjusted = new Map();
    for (const position of ["QB", "RB", "WR", "TE"]) {
      const positionPlayers = players
        .filter((player) => positionKey(player.position) === position && Number.isFinite(bases.get(normalizeName(player.name))))
        .sort((a, b) => bases.get(normalizeName(b.name)) - bases.get(normalizeName(a.name)));
      const curve = positionPlayers.map((player) => bases.get(normalizeName(player.name)));
      for (const player of positionPlayers) {
        const key = normalizeName(player.name);
        const base = bases.get(key);
        let adjustment = 0;
        if (Number.isFinite(player.fantasyProsPositionRank) && curve.length) {
          const target = curve[Math.min(curve.length - 1, Math.max(0, player.fantasyProsPositionRank - 1))];
          const deviation = Number(player.fantasyProsStdDev);
          const reliability = !Number.isFinite(deviation) ? 0.55 : deviation <= 3 ? 1 : deviation <= 6 ? 0.8 : deviation <= 10 ? 0.55 : 0.35;
          adjustment = Math.max(-8, Math.min(8, 0.20 * reliability * (target - base)));
        }
        adjusted.set(key, { base, adjustment, value: base + adjustment });
      }
    }
    return adjusted;
  }

  function consumeDraftedSlots(players, drafted, config) {
    const slots = {
      QB: config.teams * (config.starterSlots.QB || 0),
      RB: config.teams * (config.starterSlots.RB || 0),
      WR: config.teams * (config.starterSlots.WR || 0),
      TE: config.teams * (config.starterSlots.TE || 0),
      RB_WR: config.teams * (config.starterSlots.RB_WR || 0),
      FLEX: config.teams * (config.starterSlots.FLEX || 0),
    };
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const player of players) {
      const position = positionKey(player.position);
      if (drafted.has(normalizeName(player.name)) && Object.hasOwn(counts, position)) counts[position] += 1;
    }
    const surplus = {};
    for (const position of ["QB", "RB", "WR", "TE"]) {
      const used = Math.min(slots[position], counts[position]);
      slots[position] -= used;
      surplus[position] = counts[position] - used;
    }
    const rbWrUsed = Math.min(slots.RB_WR, surplus.RB + surplus.WR);
    slots.RB_WR -= rbWrUsed;
    let remainingRbWrSurplus = surplus.RB + surplus.WR - rbWrUsed;
    const flexUsed = Math.min(slots.FLEX, remainingRbWrSurplus + surplus.TE);
    slots.FLEX -= flexUsed;
    return slots;
  }

  function dynamicFrontiers(players, drafted, projectionMap, config) {
    const slots = consumeDraftedSlots(players, drafted, config);
    const available = players
      .filter((player) => !drafted.has(normalizeName(player.name)))
      .filter((player) => Number.isFinite(projectionMap.get(normalizeName(player.name))?.value))
      .map((player) => ({ player, value: projectionMap.get(normalizeName(player.name)).value }))
      .sort((a, b) => b.value - a.value);
    const used = new Set();
    const frontiers = {};
    const take = (slot, positions, count) => {
      const selected = available.filter(({ player }) => positions.includes(positionKey(player.position)) && !used.has(player)).slice(0, count);
      for (const item of selected) used.add(item.player);
      frontiers[slot] = selected.at(-1)?.value ?? available.find(({ player }) => positions.includes(positionKey(player.position)) && !used.has(player))?.value ?? 0;
    };
    take("QB", ["QB"], slots.QB);
    take("RB", ["RB"], slots.RB);
    take("WR", ["WR"], slots.WR);
    take("TE", ["TE"], slots.TE);
    take("RB_WR", ["RB", "WR"], slots.RB_WR);
    take("FLEX", ["RB", "WR", "TE"], slots.FLEX);
    return frontiers;
  }

  function optimizedOffensiveLineupValue(entries, offensiveSlots) {
    let states = new Map([[0, 0]]);
    for (const entry of entries) {
      if (!Number.isFinite(entry.value)) continue;
      const next = new Map(states);
      for (const [mask, total] of states) {
        for (let index = 0; index < offensiveSlots.length; index += 1) {
          if (mask & (1 << index)) continue;
          if (!entry.slots.includes(index)) continue;
          const nextMask = mask | (1 << index);
          const nextValue = total + entry.value;
          if (nextValue > (next.get(nextMask) ?? -Infinity)) next.set(nextMask, nextValue);
        }
      }
      states = next;
    }
    return states.get((1 << offensiveSlots.length) - 1) ?? -Infinity;
  }

  function lineupEntries(roster, playersByName, projectionMap, frontiers, offensiveSlots) {
    const entries = roster.map((rosterPlayer) => {
      const player = playersByName.get(normalizeName(rosterPlayer.name));
      const value = projectionMap.get(normalizeName(rosterPlayer.name))?.value;
      return player && Number.isFinite(value)
        ? { value, slots: offensiveSlots.map((slot, index) => eligibleForSlot(player.position, slot) ? index : -1).filter((index) => index >= 0) }
        : null;
    }).filter(Boolean);
    offensiveSlots.forEach((slot, index) => {
      entries.push({ value: frontiers[slot] ?? 0, slots: [index] });
    });
    return entries;
  }

  function thinkSurvivalCategory(player, currentPick, nextPick, opponentPicks) {
    if (opponentPicks === 0) return "guaranteed through turn";
    if (!Number.isFinite(player.espnAdp)) return "unknown survival";
    if (player.espnAdp <= nextPick - 4) return "likely gone";
    if (player.espnAdp <= nextPick + 6) return "uncertain survival";
    return "likely survives";
  }

  function explainThink(player) {
    const reasons = [];
    if (player.rosterMarginalValue >= 4) reasons.push(`+${player.rosterMarginalValue.toFixed(1)} roster-completion pts`);
    else if (player.fillsOpenStarter) reasons.push(`fills an open ${positionKey(player.position)} starter assignment`);
    else if (player.benchValue > 0) reasons.push(`+${player.benchValue.toFixed(1)} bench optionality`);
    if (Math.abs(player.ecrAdjustmentPoints) >= 0.5) reasons.push(`ECR ${player.ecrAdjustmentPoints > 0 ? "+" : ""}${player.ecrAdjustmentPoints.toFixed(1)} pts`);
    if (player.survivalCategory === "likely gone") reasons.push("likely gone before your next pick");
    if (player.survivalCategory === "guaranteed through turn") reasons.push("no opponents pick before your turn pick");
    return reasons.slice(0, 2).join("; ") || "best flex-aware roster completion value";
  }

  function rankThinkPlayers(players, state, config, drafted, roster, rosterCounts, currentPick, round, nextPick, opponentPicks) {
    const slotsForLeague = offensiveSlots(config);
    const projectionMap = thinkProjectionMap(players);
    const playersByName = new Map(players.map((player) => [normalizeName(player.name), player]));
    const frontiers = dynamicFrontiers(players, drafted, projectionMap, config);
    const waiverBaselines = {};
    for (const position of ["QB", "RB", "WR", "TE"]) {
      const values = players
        .filter((player) => positionKey(player.position) === position)
        .map((player) => projectionMap.get(normalizeName(player.name))?.value)
        .filter(Number.isFinite)
        .sort((a, b) => b - a);
      const expectedRostered = position === "RB" || position === "WR" ? config.teams * 6 : Math.ceil(config.teams * 1.5);
      waiverBaselines[position] = values[Math.min(values.length - 1, expectedRostered - 1)] ?? 0;
    }
    const baselineEntries = lineupEntries(roster, playersByName, projectionMap, frontiers, slotsForLeague);
    const baselineValue = optimizedOffensiveLineupValue(baselineEntries, slotsForLeague);
    const rosterByPosition = countRoster(roster);
    const currentStarterAssignments = maxStarterAssignments(rosterByPosition, config);
    const specialStarterAssignments = Math.min(rosterByPosition.DST || 0, config.starterSlots.DST || 0)
      + Math.min(rosterByPosition.K || 0, config.starterSlots.K || 0);
    const offensiveStarterAssignments = currentStarterAssignments - specialStarterAssignments;
    const offensiveLineupComplete = offensiveStarterAssignments >= slotsForLeague.length;
    const candidates = players
      .filter((player) => !drafted.has(normalizeName(player.name)))
      .filter((player) => canDraftPosition(player.position, rosterCounts, config))
      .filter((player) => !isEarlyQbTeBlocked(player.position, round, config, rosterCounts))
      .map((player) => {
        const position = positionKey(player.position);
        if (position === "K" || position === "DST") {
          const specialScore = round >= config.rounds - 1 ? -10 - (player.fantasyProsPositionRank ?? 30) / 10 : -1000;
          return { ...player, score: specialScore, rankingModel: "think-rmv", rosterMarginalValue: 0, benchValue: 0, ecrAdjustmentPoints: 0, survivalCategory: "late-round only", waitLoss: 0, reason: "reserved for legal late-round lineup completion" };
        }
        const projection = projectionMap.get(normalizeName(player.name));
        if (!projection) return { ...player, score: -2000, rankingModel: "think-rmv", rosterMarginalValue: 0, benchValue: 0, ecrAdjustmentPoints: 0, survivalCategory: "unknown", waitLoss: 0, reason: "missing auditable cardinal projection" };
        const slots = slotsForLeague.map((slot, index) => eligibleForSlot(position, slot) ? index : -1).filter((index) => index >= 0);
        const withCandidate = optimizedOffensiveLineupValue([...baselineEntries, { value: projection.value, slots }], slotsForLeague);
        const rosterMarginalValue = Number.isFinite(baselineValue) && Number.isFinite(withCandidate) ? Math.max(0, withCandidate - baselineValue) : 0;
        const isBenchCandidate = rosterMarginalValue < 0.01;
        const nextCounts = { ...rosterByPosition, [position]: (rosterByPosition[position] || 0) + 1 };
        const candidateAddsStarterAssignment = maxStarterAssignments(nextCounts, config) > currentStarterAssignments;
        const ceilingRatio = Number.isFinite(player.draftSharksCeiling) && Number.isFinite(player.draftSharksProjection) && player.draftSharksProjection > 0
          ? player.draftSharksCeiling / player.draftSharksProjection - 1
          : 0;
        const standaloneBenchValue = clamp((projection.value - (waiverBaselines[position] || 0)) / 60) * 5;
        const ceilingOptionality = clamp((ceilingRatio - 0.35) / 1.5) * 3;
        const marketOptionality = Number.isFinite(player.draftSharks3dValue) ? player.draftSharks3dValue * 0.02 : 0;
        let benchValue = isBenchCandidate && offensiveLineupComplete && (position === "RB" || position === "WR")
          ? Math.min(10, Math.max(0, standaloneBenchValue + ceilingOptionality + marketOptionality))
          : 0;
        if (benchValue > 0) {
          const samePosition = rosterByPosition[position] || 0;
          const otherPosition = rosterByPosition[position === "RB" ? "WR" : "RB"] || 0;
          if (samePosition - otherPosition >= 4) benchValue *= 0.10;
          else if (samePosition - otherPosition >= 2) benchValue *= 0.35;
        }
        if ((position === "QB" || position === "TE") && (rosterByPosition[position] || 0) >= 1) benchValue = Math.min(benchValue, 2);
        const sameByeBackup = (position === "QB" || position === "TE") && roster.some((rosterPlayer) => {
          const canonical = playersByName.get(normalizeName(rosterPlayer.name));
          return canonical && positionKey(canonical.position) === position && canonical.byeWeek && canonical.byeWeek === player.byeWeek;
        });
        const byePenalty = sameByeBackup ? 2 : 0;
        const rbPriority = rbPriorityAdjustment(position, "think-rmv", config.rbPreference);
        let utility = rosterMarginalValue + benchValue - byePenalty + rbPriority;
        if (!offensiveLineupComplete && !candidateAddsStarterAssignment) utility = -100;
        if (offensiveLineupComplete && position === "QB" && (rosterByPosition.QB || 0) >= 1 && round < 11) utility -= 30;
        if (offensiveLineupComplete && position === "TE" && (rosterByPosition.TE || 0) >= 1 && round < 10) utility -= 20;
        const survivalCategory = thinkSurvivalCategory(player, currentPick, nextPick, opponentPicks);
        return {
          ...player,
          score: utility,
          utility,
          rankingModel: "think-rmv",
          projectionMean: projection.base,
          adjustedProjection: projection.value,
          ecrAdjustmentPoints: projection.adjustment,
          rosterMarginalValue,
          benchValue,
          byePenalty,
          rbPriority,
          fillsOpenStarter: candidateAddsStarterAssignment,
          survivalCategory,
          waitLoss: 0,
        };
      });
    for (const candidate of candidates) {
      if (!["QB", "RB", "WR", "TE"].includes(positionKey(candidate.position)) || !Number.isFinite(candidate.utility)) continue;
      const fallback = candidates
        .filter((other) => other !== candidate && Number.isFinite(other.utility))
        .filter((other) => !Number.isFinite(other.espnAdp) || other.espnAdp > nextPick - 2)
        .reduce((best, other) => Math.max(best, other.utility), 0);
      const factor = candidate.survivalCategory === "likely gone" ? 0.75
        : candidate.survivalCategory === "uncertain survival" ? 0.45
          : candidate.survivalCategory === "likely survives" ? 0.15
            : 0;
      candidate.waitLoss = Math.min(20, factor * Math.max(0, candidate.utility - fallback));
      candidate.score = candidate.utility + candidate.waitLoss;
      candidate.reason = explainThink(candidate);
    }
    return candidates.sort((a, b) => b.score - a.score || (a.espnAdp ?? 999) - (b.espnAdp ?? 999));
  }

  function rankPlayers(players, state = {}, userConfig = {}) {
    const config = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      replacementRanks: { ...DEFAULT_CONFIG.replacementRanks, ...(userConfig.replacementRanks || {}) },
      rosterMax: { ...DEFAULT_CONFIG.rosterMax, ...(userConfig.rosterMax || {}) },
      starterSlots: { ...DEFAULT_CONFIG.starterSlots, ...(userConfig.starterSlots || {}) },
    };
    const drafted = new Set((state.draftedNames || []).map(normalizeName));
    const roster = state.roster || [];
    const rosterCounts = countRoster(roster);
    const currentPick = Math.max(1, Number(state.currentPick) || 1);
    const round = roundForPick(currentPick, config.teams);
    const nextPick = nextPickAfter(currentPick, config.draftSlot, config.teams, config.rounds);
    const opponentPicks = opponentPicksUntilNext(currentPick, config.draftSlot, config.teams, config.rounds);
    if (config.rankingModel === "fantasypros-ecr") {
      const offensiveConfig = { ...config, starterSlots: { ...config.starterSlots, DST: 0, K: 0 } };
      const assigned = maxStarterAssignments(rosterCounts, offensiveConfig);
      const required = Object.values(offensiveConfig.starterSlots).reduce((sum, count) => sum + count, 0);
      return players.filter(player => Number.isFinite(player.fantasyProsRank))
        .filter(player => !drafted.has(normalizeName(player.name)))
        .filter(player => canDraftPosition(player.position, rosterCounts, config))
        .filter(player => !isEarlyQbTeBlocked(player.position, round, config, rosterCounts))
        .filter(player => {
          const position = positionKey(player.position);
          if (assigned >= required || position === "DST" || position === "K") return true;
          // Fill offensive starters before taking offensive bench depth.
          return maxStarterAssignments({ ...rosterCounts, [position]: (rosterCounts[position] || 0) + 1 }, offensiveConfig) > assigned;
        })
        .map(player => ({
          ...player,
          score: -player.fantasyProsRank + 100 * sharpRosterAdjustment(player, rosterCounts, round, config),
          rankingModel: "fantasypros-ecr",
          nextPick,
          reason: `PPR consensus #${player.fantasyProsRank}${player.fantasyProsTier ? ", tier " + player.fantasyProsTier : ""}; adjusted for roster needs`,
        }))
        .sort((a,b) => b.score - a.score || a.fantasyProsRank - b.fantasyProsRank);
    }
    const replacements = replacementPoints(players, config);
    const projectionPositionRanks = new Map();
    for (const position of ["QB", "RB", "WR", "TE"]) {
      players
        .filter((player) => positionKey(player.position) === position && Number.isFinite(player.vegasPoints))
        .sort((a, b) => b.vegasPoints - a.vegasPoints)
        .forEach((player, index) => projectionPositionRanks.set(`${normalizeName(player.name)}|${position}`, index + 1));
    }

    if (config.rankingModel === "think-rmv") {
      return rankThinkPlayers(players, state, config, drafted, roster, rosterCounts, currentPick, round, nextPick, opponentPicks);
    }

    return players
      .filter((player) => !drafted.has(normalizeName(player.name)))
      .filter((player) => canDraftPosition(player.position, rosterCounts, config))
      .filter((player) => !isEarlyQbTeBlocked(player.position, round, config, rosterCounts))
      .map((player) => {
        const position = positionKey(player.position);
        const replacement = replacements[position];
        const vorp = Number.isFinite(player.vegasPoints) && Number.isFinite(replacement) ? player.vegasPoints - replacement : null;
        const vegasScore = vorp === null ? null : clamp((vorp + 12) / 115);
        const ecrScore = Number.isFinite(player.fantasyProsRank)
          ? clamp(1 - (player.fantasyProsRank - 1) / 249)
          : null;
        const isSharpModel = config.rankingModel === "sharp-value";
        const isVegasSharksModel = config.rankingModel === "vegas-sharks-80";
        const isVegasOnlyModel = config.rankingModel === "vegas-only";
        const vegasSourceScore = isVegasOnlyModel && vorp !== null ? (vorp + 12) / 115 : vegasScore;
        const draftSharksScore = Number.isFinite(player.draftSharks3dValue) ? clamp(player.draftSharks3dValue / 100) : null;
        const sourceWeights = isSharpModel
          ? { draftSharks: 0.55, ecr: 0.35, vegas: 0.10 }
          : isVegasSharksModel
            ? { draftSharks: 0.20, ecr: 0, vegas: 0.80 }
            : isVegasOnlyModel
              ? { draftSharks: 0, ecr: 0, vegas: 1 }
              : { draftSharks: 0, ecr: config.ecrWeight, vegas: config.vegasWeight };
        const availableWeight = (draftSharksScore === null ? 0 : sourceWeights.draftSharks)
          + (ecrScore === null ? 0 : sourceWeights.ecr)
          + (vegasSourceScore === null ? 0 : sourceWeights.vegas);
        const sourceScore = availableWeight > 0
          ? ((draftSharksScore ?? 0) * sourceWeights.draftSharks
            + (ecrScore ?? 0) * sourceWeights.ecr
            + (vegasSourceScore ?? 0) * sourceWeights.vegas) / availableWeight
          : isVegasOnlyModel ? -1 : 0;
        const projectionPositionRank = projectionPositionRanks.get(`${normalizeName(player.name)}|${position}`);
        const ecrAdjustment = Number.isFinite(projectionPositionRank) && Number.isFinite(player.fantasyProsPositionRank)
          ? Math.max(-0.08, Math.min(0.08, (projectionPositionRank - player.fantasyProsPositionRank) / 250))
          : 0;
        const timingAdp = Number.isFinite(player.espnAdp)
          ? player.espnAdp
          : (isSharpModel || isVegasSharksModel) && Number.isFinite(player.draftSharksAdp)
            ? player.draftSharksAdp
            : player.sleeperAdp;
        const goneProbability = opponentPicks === 0
          ? 0
          : Number.isFinite(timingAdp)
            ? 1 / (1 + Math.exp((timingAdp - nextPick) / 7))
          : 0.35;
        const urgency = isVegasOnlyModel ? 0 : goneProbability * ((isSharpModel || isVegasSharksModel) ? 0.10 : 0.13);
        const reachAdp = (isSharpModel || isVegasSharksModel) ? timingAdp : player.sleeperAdp;
        const reach = isVegasOnlyModel
          ? 0
          : Number.isFinite(reachAdp) ? clamp((reachAdp - currentPick - 10) / 55) * ((isSharpModel || isVegasSharksModel) ? 0.08 : 0.1) : 0;
        const roster = (isSharpModel || isVegasSharksModel)
          ? sharpRosterAdjustment(player, rosterCounts, round, config)
          : rosterAdjustment(player, rosterCounts, round, config);
        const upside = isSharpModel && Number.isFinite(player.draftSharksCeiling) && Number.isFinite(player.draftSharksProjection)
          ? clamp((player.draftSharksCeiling - player.draftSharksProjection) / 140) * 0.05
          : 0;
        const injuryPenalty = isSharpModel && Number.isFinite(player.draftSharksInjuryRisk)
          ? clamp((player.draftSharksInjuryRisk - 35) / 65) * 0.03
          : 0;
        const positionPriority = isVegasSharksModel
          ? (position === "RB" || position === "WR" ? 0.08 : position === "QB" ? -0.10 : -0.02)
          : 0;
        const rbPriority = rbPriorityAdjustment(position, config.rankingModel, config.rbPreference);
        const score = sourceScore + ((isSharpModel || isVegasSharksModel || isVegasOnlyModel) ? 0 : ecrAdjustment) + urgency + roster + positionPriority + rbPriority + upside - injuryPenalty - reach;
        const context = { vorp, timingAdp, currentPick, goneProbability, round, rbWrCount: (rosterCounts.RB || 0) + (rosterCounts.WR || 0) };
        return {
          ...player,
          score,
          sourceScore,
          draftSharksScore,
          ecrScore,
          vegasScore,
          vorp,
          positionPriority,
          rbPriority,
          ecrAdjustment,
          goneProbability,
          nextPick,
          rankingModel: config.rankingModel,
          reason: isSharpModel
            ? explainSharp(player, context)
            : isVegasSharksModel
              ? explainVegasSharks(player, context)
              : isVegasOnlyModel
                ? explainVegasOnly(player, context)
                : explain(player, context),
        };
      })
      .sort((a, b) => b.score - a.score || (config.rankingModel === "vegas-only"
        ? (b.vegasPoints ?? -Infinity) - (a.vegasPoints ?? -Infinity) || a.name.localeCompare(b.name)
        : (a.fantasyProsRank ?? 999) - (b.fantasyProsRank ?? 999)));
  }

  root.DraftAssistantEngine = {
    DEFAULT_CONFIG,
    loadConfig,
    validateDataset,
    normalizeName,
    nextPickAfter,
    opponentPicksUntilNext,
    ownPicksBefore,
    chooseTriggerSeconds,
    autoDraftWindowStatus,
    autoDraftRetryAt,
    espnSearchTerm,
    overallPickFor,
    pickInRound,
    roundForPick,
    rbPriorityAdjustment,
    maxStarterAssignments,
    canDraftPosition,
    isEarlyQbTeBlocked,
    rankPlayers,
  };
})(globalThis);
