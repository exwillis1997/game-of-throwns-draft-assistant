(function attachLeagueScoring(root) {
  "use strict";

  // ESPN scoring categories verified against the league screenshots on 2026-09-07.
  // Inputs are projected category counts, not touchdown lengths or season yardage
  // to be bucketed. Overlapping categories must follow the provider's ESPN counts.
  const miscellaneous = { KRTD: 6, PRTD: 6, FTD: 6, FUML: -2, INTTD: 6, FRTD: 6, BLKKRTD: 6, "2PTRET": 2, "1PSF": 1 };
  const offense = {
    PY: 0.04, PTD: 4, PTD40: 2, PTD50: 3, INT: -2, "2PC": 2,
    RY: 0.1, RTD: 6, RTD40: 2, RTD50: 3, "2PR": 2,
    REY: 0.1, REC: 1, RETD: 6, RETD40: 2, RETD50: 3, "2PRE": 2,
    ...miscellaneous,
  };
  const kicking = { ...miscellaneous, PAT: 1, FGM: -1, FG0: 3, FG40: 4, FGM0: -2, FGM40: -1, FG50: 5, FG60: 6 };
  const defense = {
    KRTD: 6, PRTD: 6, INTTD: 6, FRTD: 6, BLKKRTD: 6, "2PTRET": 2, "1PSF": 1,
    SK: 1, BLKK: 2, INT: 2, FR: 2, FF: 1, SF: 2,
    PA0: 5, PA1: 4, PA7: 3, PA14: 1, PA28: -1, PA35: -3, PA46: -5,
    YA100: 5, YA199: 3, YA299: 2, YA399: -1, YA449: -3, YA499: -5, YA549: -6, YA550: -7,
  };
  const rules = Object.freeze({ offense: Object.freeze(offense), kicking: Object.freeze(kicking), defense: Object.freeze(defense) });

  function scoreStats(stats, position) {
    const weights = ["DST", "D/ST", "DEF"].includes(position) ? rules.defense : position === "K" ? rules.kicking : rules.offense;
    if (!stats || typeof stats !== "object" || Array.isArray(stats) || !Object.keys(stats).length) throw new Error("Stat projections must contain ESPN category counts.");
    let total = 0;
    for (const [category, count] of Object.entries(stats)) {
      if (!Object.hasOwn(weights, category)) throw new Error(`Unsupported scoring category: ${category}`);
      if (!Number.isFinite(count) || (count < 0 && !["PY", "RY", "REY"].includes(category))) throw new Error(`Invalid projected count: ${category}`);
      total += weights[category] * count;
    }
    return total;
  }

  function prepareDataset(dataset) {
    return { ...dataset, players: dataset.players.map(player => {
      if (!player.statProjections) return player;
      const prepared = { ...player };
      // Keep each source independent; never add bonuses again to a scored total.
      for (const [source, stats] of Object.entries(player.statProjections)) {
        if (!["fantasyProsProjection", "vegasPoints", "draftSharksProjection", "draftSharksConsensusProjection"].includes(source)) throw new Error(`Unsupported projection source: ${source}`);
        prepared[source] = scoreStats(stats, player.position);
      }
      return prepared;
    }) };
  }

  root.DraftAssistantScoring = { rules, scoreStats, prepareDataset };
})(globalThis);
