import test from "node:test";
import assert from "node:assert/strict";
import "../extension/lib/engine.js";
const engine = globalThis.DraftAssistantEngine;

test("slot one has the 1/24/25 turn and exactly thirteen picks", () => {
  assert.deepEqual(Array.from({length: 13}, (_, i) => engine.overallPickFor(i + 1, 1, 12)), [1,24,25,48,49,72,73,96,97,120,121,144,145]);
  assert.equal(engine.nextPickAfter(1, 1), 24);
  assert.equal(engine.nextPickAfter(24, 1), 25);
  assert.equal(engine.opponentPicksUntilNext(24, 1), 0);
  assert.equal(engine.opponentPicksUntilNext(25, 1), 22);
  assert.equal(engine.ownPicksBefore(145, 1), 12);
  assert.equal(engine.ownPicksBefore(157, 1), 13);
});

test("migrates upstream settings without retaining its lineup or armed state", () => {
  const config = engine.loadConfig({ teams: 10, rounds: 17, rosterSize: 17, benchSlots: 7, starterSlots: {RB_WR: 1}, draftSlot: 7, autoDraftEnabled: true, autoDraftMinSeconds: 50, autoDraftMaxSeconds: 55, rankingModel: "think-rmv" });
  assert.equal(config.teams, 12);
  assert.equal(config.rounds, 13);
  assert.equal(config.rosterSize, 13);
  assert.equal(config.benchSlots, 4);
  assert.equal(config.starterSlots.RB_WR, undefined);
  assert.equal(config.draftSlot, 1);
  assert.equal(config.autoDraftEnabled, false);
  assert.equal(config.autoDraftMaxSeconds, 25);
  assert.equal(config.autoDraftMinSeconds, 25);
  assert.equal(config.rankingModel, "think-rmv");
  assert.equal(engine.loadConfig({...config, draftSlot: 12, autoDraftEnabled: true}).autoDraftEnabled, true);
  assert.equal(engine.loadConfig({...config, draftSlot: 12}).draftSlot, 12);
});

test("rejects half-PPR, unlabelled, empty, and synthetic ranking boards", () => {
  const dataset = {meta: {scoring: "ppr", leagueTeams: 12}, players: [{name: "Test RB", position: "RB"}]};
  assert.equal(engine.validateDataset(dataset), null);
  for (const meta of [{}, {scoring: "half-ppr", leagueTeams: 12}, {scoring:"ppr", leagueTeams:10}, {...dataset.meta, example: true}]) {
    assert.ok(engine.validateDataset({...dataset, meta}));
  }
  assert.ok(engine.validateDataset({...dataset, players: []}));
});

const players = ["QB", "RB", "WR", "TE", "DST", "K"].flatMap((position) => Array.from({length: 20}, (_, i) => ({
  name: `${position} ${i}`, position, vegasPoints: 300 - i * 9, draftSharks3dValue: 100 - i * 3,
  fantasyProsRank: i * 6 + 1, fantasyProsPositionRank: i + 1, espnAdp: i * 6 + 1,
})));

test("all five models finish a legal 13-player roster in a simulated slot-one draft", () => {
  for (const rankingModel of ["think-rmv", "sharp-value", "vegas-sharks-80", "vegas-only", "balanced-v04"]) {
    const roster = [];
    for (let round = 1; round <= 13; round++) {
      const choices = engine.rankPlayers(players, {currentPick: engine.overallPickFor(round, 1, 12), roster, draftedNames: roster.map(p => p.name)}, {rankingModel});
      assert.ok(choices.length, `${rankingModel}: round ${round} has legal choices`);
      assert.ok(Number.isFinite(choices[0].score));
      roster.push(choices[0]);
    }
    const counts = roster.reduce((out, p) => ({...out, [p.position]: (out[p.position] || 0) + 1}), {});
    assert.equal(engine.maxStarterAssignments(counts, engine.DEFAULT_CONFIG), 9, rankingModel);
    assert.equal(engine.rankPlayers(players, {currentPick: 157, roster}, {rankingModel}).length, 0);
  }
});

test("Think model recognizes seven offensive starters with only one FLEX", () => {
  const roster = [players.find(p => p.position === "QB"), ...players.filter(p => p.position === "RB").slice(0,3), ...players.filter(p => p.position === "WR").slice(0,2), players.find(p => p.position === "TE")];
  const ranked = engine.rankPlayers(players, {currentPick: 96, roster, draftedNames: roster.map(p=>p.name)}, {rankingModel:"think-rmv"});
  assert.ok(ranked.some(p => p.position === "RB" && p.benchValue > 0));
  assert.ok(ranked.every(p=>Number.isFinite(p.score)));
});
