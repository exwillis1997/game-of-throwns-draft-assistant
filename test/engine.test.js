import test from "node:test";
import assert from "node:assert/strict";
import "../extension/lib/engine.js";

const engine = globalThis.DraftAssistantEngine;

test("chooses an inclusive, bounded auto-draft trigger", () => {
  assert.equal(engine.chooseTriggerSeconds(5, 55, 0), 5);
  assert.equal(engine.chooseTriggerSeconds(5, 55, 0.999999), 25);
  assert.equal(engine.chooseTriggerSeconds(20, 10, 0.5), 20);
  assert.equal(engine.chooseTriggerSeconds(1, 99, 0.999999), 25);
});

test("guards the wall-clock window for a background auto-draft", () => {
  const deadlineAt = 60_000;
  const fireAt = 35_000;
  assert.equal(engine.autoDraftWindowStatus(34_000, fireAt, deadlineAt, 5), "early");
  assert.equal(engine.autoDraftWindowStatus(35_000, fireAt, deadlineAt, 5), "ready");
  assert.equal(engine.autoDraftWindowStatus(56_000, fireAt, deadlineAt, 5), "late");
  assert.equal(engine.autoDraftWindowStatus(NaN, fireAt, deadlineAt, 5), "invalid");
});

test("allows only one bounded retry before the auto-draft safety cutoff", () => {
  assert.equal(engine.autoDraftRetryAt(35_000, 60_000, 10, 1, 2, 1500), 36_500);
  assert.equal(engine.autoDraftRetryAt(50_000, 60_000, 10, 1, 2, 1500), null);
  assert.equal(engine.autoDraftRetryAt(35_000, 60_000, 10, 2, 2, 1500), null);
});

test("uses ESPN-compatible defense search names", () => {
  assert.equal(engine.espnSearchTerm({ name: "Houston Texans", position: "DST" }), "Texans");
  assert.equal(engine.espnSearchTerm({ name: "San Francisco 49ers", position: "D/ST" }), "49ers");
  assert.equal(engine.espnSearchTerm({ name: "Jahmyr Gibbs", position: "RB" }), "Jahmyr Gibbs");
});

test("honors the configured FantasyPros and Vegas source weights", () => {
  const players = [
    { name: "ECR Favorite", position: "RB", fantasyProsRank: 1, fantasyProsPositionRank: 1, vegasPoints: 100 },
    { name: "Vegas Favorite", position: "RB", fantasyProsRank: 200, fantasyProsPositionRank: 2, vegasPoints: 300 },
    ...Array.from({ length: 6 }, (_, index) => ({
      name: `Filler ${index}`,
      position: "RB",
      fantasyProsRank: 210 + index,
      fantasyProsPositionRank: 3 + index,
      vegasPoints: 90 - index,
    })),
  ];
  const state = { currentPick: 1 };
  const backup = { teams: 1, draftSlot: 1, rankingModel: "balanced-v04" };
  assert.equal(engine.rankPlayers(players, state, { ...backup, ecrWeight: 1, vegasWeight: 0 })[0].name, "ECR Favorite");
  assert.equal(engine.rankPlayers(players, state, { ...backup, ecrWeight: 0, vegasWeight: 1 })[0].name, "Vegas Favorite");
});

test("uses DraftSharks as the primary signal in the sharp-value model", () => {
  const players = [
    { name: "DraftSharks Favorite", position: "WR", draftSharks3dValue: 95, fantasyProsRank: 80, vegasPoints: 150, espnAdp: 40 },
    { name: "Other Favorite", position: "WR", draftSharks3dValue: 40, fantasyProsRank: 1, vegasPoints: 220, espnAdp: 40 },
    ...Array.from({ length: 6 }, (_, index) => ({
      name: `Replacement ${index}`,
      position: "WR",
      draftSharks3dValue: 10,
      fantasyProsRank: 200 + index,
      vegasPoints: 100 - index,
      espnAdp: 200 + index,
    })),
  ];
  const result = engine.rankPlayers(players, { currentPick: 1 }, { teams: 1, draftSlot: 1, rankingModel: "sharp-value" });
  assert.equal(result[0].name, "DraftSharks Favorite");
  assert.match(result[0].reason, /DraftSharks 3D value 95/);
});

test("uses an 80% Vegas and 20% DraftSharks blend with RB/WR priority", () => {
  const players = [
    { name: "Vegas RB", position: "RB", vegasPoints: 260, draftSharks3dValue: 40, espnAdp: 5 },
    { name: "Sharks RB", position: "RB", vegasPoints: 190, draftSharks3dValue: 100, espnAdp: 5 },
    { name: "Similar QB", position: "QB", vegasPoints: 340, draftSharks3dValue: 95, espnAdp: 5 },
    ...Array.from({ length: 12 }, (_, index) => ({
      name: `Replacement RB ${index}`,
      position: "RB",
      vegasPoints: 180 - index,
      draftSharks3dValue: 10,
      espnAdp: 200 + index,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      name: `Replacement QB ${index}`,
      position: "QB",
      vegasPoints: 300 - index * 5,
      draftSharks3dValue: 10,
      espnAdp: 200 + index,
    })),
  ];
  const result = engine.rankPlayers(players, { currentPick: 1 }, { teams: 1, draftSlot: 1, rankingModel: "vegas-sharks-80" });
  assert.equal(result[0].name, "Vegas RB");
  assert.ok(result.find((player) => player.name === "Vegas RB").score > result.find((player) => player.name === "Similar QB").score);
  assert.match(result[0].reason, /Vegas/);
});

test("uses Vegas as the only player-data signal in the Vegas-only model", () => {
  const players = [
    { name: "Vegas Favorite", position: "RB", vegasPoints: 260, draftSharks3dValue: 1, fantasyProsRank: 200 },
    { name: "Other Source Favorite", position: "RB", vegasPoints: 190, draftSharks3dValue: 100, fantasyProsRank: 1 },
    { name: "Same Vegas Bad Sources", position: "WR", vegasPoints: 220, draftSharks3dValue: 1, fantasyProsRank: 200 },
    { name: "Same Vegas Good Sources", position: "WR", vegasPoints: 220, draftSharks3dValue: 100, fantasyProsRank: 1 },
    ...Array.from({ length: 12 }, (_, index) => ({ name: `RB Replacement ${index}`, position: "RB", vegasPoints: 180 - index })),
    ...Array.from({ length: 12 }, (_, index) => ({ name: `WR Replacement ${index}`, position: "WR", vegasPoints: 170 - index })),
  ];
  const result = engine.rankPlayers(players, { currentPick: 1 }, { teams: 1, draftSlot: 1, rankingModel: "vegas-only" });
  assert.equal(result[0].name, "Vegas Favorite");
  assert.equal(
    result.find((player) => player.name === "Same Vegas Bad Sources").score,
    result.find((player) => player.name === "Same Vegas Good Sources").score,
  );
  assert.match(result[0].reason, /Vegas/);
});

test("normalizes ESPN and source name variants", () => {
  assert.equal(engine.normalizeName("James Cook III"), engine.normalizeName("James Cook"));
  assert.equal(engine.normalizeName("Ja’Marr Chase"), engine.normalizeName("Ja'Marr Chase"));
  assert.equal(engine.normalizeName("Ja'Marr Chase"), engine.normalizeName("JaMarr Chase"));
  assert.equal(engine.normalizeName("D.J. Moore"), engine.normalizeName("DJ Moore"));
  assert.equal(engine.normalizeName("Cameron Ward"), engine.normalizeName("Cam Ward"));
});

test("calculates the next snake pick for slot three", () => {
  assert.equal(engine.nextPickAfter(18, 3, 10, 17), 23);
  assert.equal(engine.nextPickAfter(23, 3, 10, 17), 38);
});

test("counts zero intervening opponents at a snake turn", () => {
  assert.equal(engine.opponentPicksUntilNext(10, 10, 10, 17), 0);
  assert.equal(engine.opponentPicksUntilNext(11, 10, 10, 17), 18);
  assert.equal(engine.ownPicksBefore(11, 10, 10, 17), 1);
});

test("does not add disappearance urgency between consecutive turn picks", () => {
  const players = [
    { name: "Turn Player A", position: "RB", fantasyProsRank: 10, vegasPoints: 220, sleeperAdp: 11 },
    { name: "Turn Player B", position: "WR", fantasyProsRank: 11, vegasPoints: 215, sleeperAdp: 40 },
  ];
  const result = engine.rankPlayers(players, { currentPick: 10, draftedNames: [] }, { teams: 10, draftSlot: 10 });
  assert.equal(result[0].goneProbability, 0);
  assert.equal(result[1].goneProbability, 0);
});

test("prefers ESPN ADP over Sleeper ADP for disappearance timing", () => {
  const players = [
    { name: "ESPN Early", position: "RB", fantasyProsRank: 20, vegasPoints: 200, espnAdp: 15, sleeperAdp: 100 },
    { name: "ESPN Late", position: "WR", fantasyProsRank: 21, vegasPoints: 200, espnAdp: 100, sleeperAdp: 15 },
  ];
  const result = engine.rankPlayers(players, { currentPick: 5, draftedNames: [] }, { draftSlot: 5 });
  const early = result.find((player) => player.name === "ESPN Early");
  const late = result.find((player) => player.name === "ESPN Late");
  assert.ok(early.goneProbability > late.goneProbability);
});

test("removes drafted players from recommendations", () => {
  const players = [
    { name: "Jahmyr Gibbs", position: "RB", fantasyProsRank: 1, vegasPoints: 292, sleeperAdp: 2 },
    { name: "Bijan Robinson", position: "RB", fantasyProsRank: 2, vegasPoints: 274, sleeperAdp: 1 },
  ];
  const result = engine.rankPlayers(players, { currentPick: 2, draftedNames: ["Jahmyr Gibbs"] }, { draftSlot: 3 });
  assert.deepEqual(result.map((player) => player.name), ["Bijan Robinson"]);
});

test("does not let raw quarterback points overwhelm early flex value", () => {
  const players = [
    { name: "Elite WR", position: "WR", fantasyProsRank: 4, vegasPoints: 250, sleeperAdp: 5 },
    { name: "Replacement WR", position: "WR", fantasyProsRank: 90, vegasPoints: 150, sleeperAdp: 90 },
    { name: "Elite QB", position: "QB", fantasyProsRank: 26, vegasPoints: 340, sleeperAdp: 28 },
    { name: "Replacement QB", position: "QB", fantasyProsRank: 100, vegasPoints: 285, sleeperAdp: 100 },
  ];
  const result = engine.rankPlayers(players, { currentPick: 4, draftedNames: [] }, { draftSlot: 4, replacementRanks: { QB: 2, WR: 2 } });
  assert.equal(result[0].name, "Elite WR");
});

test("forces a required starter when drafting another bench player would be illegal", () => {
  const roster = [
    ...Array.from({ length: 2 }, (_, index) => ({ name: `QB ${index}`, position: "QB" })),
    ...Array.from({ length: 4 }, (_, index) => ({ name: `RB ${index}`, position: "RB" })),
    ...Array.from({ length: 3 }, (_, index) => ({ name: `WR ${index}`, position: "WR" })),
    ...Array.from({ length: 2 }, (_, index) => ({ name: `TE ${index}`, position: "TE" })),
  ];
  const players = [
    { name: "High Ranked RB", position: "RB", fantasyProsRank: 1, vegasPoints: 300, sleeperAdp: 1 },
    { name: "Available Defense", position: "DST", fantasyProsRank: 220, sleeperAdp: 160 },
    { name: "Available Kicker", position: "K", fantasyProsRank: 230, sleeperAdp: 165 },
  ];
  const result = engine.rankPlayers(players, { currentPick: 144, draftedNames: [], roster }, { draftSlot: 1 });
  assert.deepEqual(result.map((player) => player.position).sort(), ["DST", "K"]);
});

test("allows only kicker when the bench and every other starter slot are full", () => {
  const roster = [
    ...Array.from({ length: 2 }, (_, index) => ({ name: `QB ${index}`, position: "QB" })),
    ...Array.from({ length: 4 }, (_, index) => ({ name: `RB ${index}`, position: "RB" })),
    ...Array.from({ length: 3 }, (_, index) => ({ name: `WR ${index}`, position: "WR" })),
    ...Array.from({ length: 2 }, (_, index) => ({ name: `TE ${index}`, position: "TE" })),
    { name: "Rostered Defense", position: "DST" },
  ];
  const players = [
    { name: "High Ranked WR", position: "WR", fantasyProsRank: 1, vegasPoints: 300, sleeperAdp: 1 },
    { name: "Second Defense", position: "DST", fantasyProsRank: 220, sleeperAdp: 160 },
    { name: "Available Kicker", position: "K", fantasyProsRank: 230, sleeperAdp: 165 },
  ];
  const result = engine.rankPlayers(players, { currentPick: 145, draftedNames: [], roster }, { draftSlot: 1 });
  assert.deepEqual(result.map((player) => player.name), ["Available Kicker"]);
});

test("hard-blocks players at the league position maximum", () => {
  const roster = [
    { name: "QB One", position: "QB" },
    { name: "QB Two", position: "QB" },
    { name: "QB Three", position: "QB" },
    { name: "QB Four", position: "QB" },
  ];
  const players = [
    { name: "QB Five", position: "QB", fantasyProsRank: 1, vegasPoints: 400, sleeperAdp: 1 },
    { name: "Legal Running Back", position: "RB", fantasyProsRank: 50, vegasPoints: 180, sleeperAdp: 50 },
  ];
  const result = engine.rankPlayers(players, { currentPick: 21, draftedNames: [], roster }, { draftSlot: 1 });
  assert.deepEqual(result.map((player) => player.name), ["Legal Running Back"]);
});

test("enforces every ESPN league position maximum and permits the final legal slot", () => {
  const config = { ...engine.DEFAULT_CONFIG, benchSlots: 10 }; // Isolate position caps from the stricter four-slot bench.
  for (const [position, maximum] of Object.entries({ QB: 4, RB: 8, WR: 8, TE: 3, DST: 3, K: 3 })) {
    assert.equal(
      engine.canDraftPosition(position, { [position]: maximum - 1 }, config),
      true,
      `${position} should allow roster spot ${maximum}`,
    );
    assert.equal(
      engine.canDraftPosition(position, { [position]: maximum }, config),
      false,
      `${position} should block roster spot ${maximum + 1}`,
    );
  }
});

test("applies a small RB preference across every ranking model", () => {
  for (const model of ["sharp-value", "vegas-sharks-80", "vegas-only", "balanced-v04"]) {
    assert.equal(engine.rbPriorityAdjustment("RB", model), 0.025);
    assert.equal(engine.rbPriorityAdjustment("WR", model), 0);
  }
  assert.equal(engine.rbPriorityAdjustment("RB", "think-rmv"), 1.5);
  assert.equal(engine.rbPriorityAdjustment("WR", "think-rmv"), 0);
  assert.equal(engine.rbPriorityAdjustment("RB", "sharp-value", 0), 0);
});

test("optionally blocks QB and TE through round eight without changing model weights", () => {
  const players = [
    { name: "Quarterback", position: "QB", fantasyProsRank: 1, vegasPoints: 400, draftSharks3dValue: 100 },
    { name: "Tight End", position: "TE", fantasyProsRank: 2, vegasPoints: 250, draftSharks3dValue: 100 },
    { name: "Running Back", position: "RB", fantasyProsRank: 3, vegasPoints: 200, draftSharks3dValue: 80 },
    { name: "Wide Receiver", position: "WR", fantasyProsRank: 4, vegasPoints: 190, draftSharks3dValue: 75 },
  ];
  for (const rankingModel of ["think-rmv", "sharp-value", "vegas-sharks-80", "vegas-only", "balanced-v04"]) {
    const blocked = engine.rankPlayers(players, { currentPick: 71, roster: [] }, {
      teams: 10,
      draftSlot: 1,
      rankingModel,
      earlyQbTeBlockEnabled: true,
    });
    assert.ok(blocked.every((player) => !["QB", "TE"].includes(player.position)), `${rankingModel} should block QB/TE in round 8`);

    const unblocked = engine.rankPlayers(players, { currentPick: 81, roster: [] }, {
      teams: 10,
      draftSlot: 1,
      rankingModel,
      earlyQbTeBlockEnabled: true,
    });
    assert.ok(unblocked.some((player) => player.position === "QB"), `${rankingModel} should restore QB in round 9`);
    assert.ok(unblocked.some((player) => player.position === "TE"), `${rankingModel} should restore TE in round 9`);
  }
});

test("optionally allows only one combined QB or TE through round eight", () => {
  const config = { ...engine.DEFAULT_CONFIG, earlyQbTeOneTotalEnabled: true };
  assert.equal(engine.isEarlyQbTeBlocked("QB", 8, config, {}), false);
  assert.equal(engine.isEarlyQbTeBlocked("TE", 8, config, {}), false);
  assert.equal(engine.isEarlyQbTeBlocked("QB", 8, config, { TE: 1 }), true);
  assert.equal(engine.isEarlyQbTeBlocked("TE", 8, config, { QB: 1 }), true);
  assert.equal(engine.isEarlyQbTeBlocked("QB", 9, config, { TE: 1 }), false);
  assert.equal(engine.isEarlyQbTeBlocked("TE", 9, config, { QB: 1 }), false);

  const players = [
    { name: "Quarterback", position: "QB", fantasyProsRank: 1, vegasPoints: 400, draftSharks3dValue: 100 },
    { name: "Tight End", position: "TE", fantasyProsRank: 2, vegasPoints: 250, draftSharks3dValue: 100 },
    { name: "Running Back", position: "RB", fantasyProsRank: 3, vegasPoints: 200, draftSharks3dValue: 80 },
  ];
  for (const rosterPosition of ["QB", "TE"]) {
    const ranked = engine.rankPlayers(players, {
      currentPick: 71,
      roster: [{ name: `Rostered ${rosterPosition}`, position: rosterPosition }],
    }, { teams: 10, draftSlot: 1, rankingModel: "sharp-value", earlyQbTeOneTotalEnabled: true });
    assert.ok(ranked.every((player) => !["QB", "TE"].includes(player.position)));
  }
});
