import test from "node:test";
import assert from "node:assert/strict";
import "../extension/lib/scoring.js";
import "../extension/lib/engine.js";
const scoring = globalThis.DraftAssistantScoring;

test("September 7 rushing bonuses score explicit counters without inferring long TDs", () => {
  assert.equal(scoring.scoreStats({RTD40:1}, "RB"), 2);
  assert.equal(scoring.scoreStats({RTD50:1}, "QB"), 3);
  assert.equal(scoring.scoreStats({RY:1000,RTD:10}, "RB"), 160);
  const dataset = {players:[{position:"RB",statProjections:{fantasyProsProjection:{RY:1000,RTD:10,RTD40:2,RTD50:1}}}]};
  const prepared = scoring.prepareDataset(dataset);
  assert.equal(prepared.players[0].fantasyProsProjection, 167);
  assert.equal(scoring.prepareDataset(prepared).players[0].fantasyProsProjection, 167);
});

test("scores full PPR and the exact passing/receiving bonus counters", () => {
  assert.equal(scoring.scoreStats({ REC: 80, REY: 1000, RETD: 8, RETD40: 2, RETD50: 1 }, "WR"), 235);
  assert.equal(scoring.scoreStats({ PY: 300, PTD: 3, PTD40: 1, PTD50: 1, INT: 2, "2PC": 1, RY: 20, RTD: 1, FUML: 1 }, "QB"), 33);
});

test("keeps interceptions and kicking penalties in their correct scoring groups", () => {
  assert.equal(scoring.scoreStats({ INT: 1 }, "QB"), -2);
  assert.equal(scoring.scoreStats({ INT: 1, SK: 2, FR: 1, FF: 1, PA0: 1, YA100: 1 }, "DST"), 17);
  assert.equal(scoring.scoreStats({ PAT: 2, FG0: 1, FG40: 1, FG50: 1, FG60: 1, FGM: 2, FGM0: 1, FGM40: 1 }, "K"), 15);
});

test("raw projections replace totals exactly once and feed the ranking engine", () => {
  const dataset = { players: [
    { name: "Pass catcher", position: "RB", vegasPoints: 1, statProjections: { vegasPoints: { REC: 80, RY: 1000 } } },
    { name: "Runner", position: "RB", vegasPoints: 170 },
    { name: "Replacement", position: "RB", vegasPoints: 100 },
  ] };
  const prepared = scoring.prepareDataset(dataset);
  assert.equal(prepared.players[0].vegasPoints, 180);
  assert.equal(dataset.players[0].vegasPoints, 1);
  assert.equal(scoring.prepareDataset(prepared).players[0].vegasPoints, 180);
  assert.equal(globalThis.DraftAssistantEngine.rankPlayers(prepared.players, {currentPick: 1}, {rankingModel: "vegas-only"})[0].name, "Pass catcher");
});

test("refuses mistyped categories and invalid projections", () => {
  for (const stats of [{ RECEPTIONS: 80 }, { REC: -1 }, { REC: "80" }, { REC: NaN }, {}]) {
    assert.throws(() => scoring.scoreStats(stats, "WR"));
  }
  assert.throws(() => scoring.prepareDataset({players: [{position: "WR", statProjections: {fantasyProsRank: {REC:80}}}]}));
});
