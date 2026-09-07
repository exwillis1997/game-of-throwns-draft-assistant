import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCsv, projectionRows} from '../scripts/import-fantasypros.mjs';
const engine = globalThis.DraftAssistantEngine;
const scoring = globalThis.DraftAssistantScoring;

test('CSV preserves quoted commas and distinct rushing/receiving columns', () => {
  assert.deepEqual(parseCsv('"a,b","c""d"\r\n'), [['a,b','c"d']]);
  const [row] = projectionRows('Player,Team,ATT,YDS,TDS,REC,YDS,TDS,FL,FPTS\nTest,SEA,200,900,8,50,400,2,1,0\n', 'RB');
  assert.equal(scoring.scoreStats(row.stats, 'RB'), 238);
  assert.throws(() => projectionRows('Player,Team,YDS\nTest,SEA,100', 'RB'));
});
test('negative rushing yardage is valid but negative receptions are not', () => {
  assert.equal(scoring.scoreStats({RY:-3,REC:1}, 'WR'), 0.7);
  assert.throws(() => scoring.scoreStats({REC:-1}, 'WR'));
});
test('FantasyPros remains an independent source and is scored once', () => {
  const original = {players:[{name:'Test',position:'WR',statProjections:{fantasyProsProjection:{REC:100,REY:1000,RETD:10}}}]};
  const prepared = scoring.prepareDataset(original);
  assert.equal(prepared.players[0].fantasyProsProjection, 260);
  assert.equal(prepared.players[0].vegasPoints, undefined);
  assert.equal(scoring.prepareDataset(prepared).players[0].fantasyProsProjection, 260);
  assert.equal(original.players[0].fantasyProsProjection, undefined);
});
const players = ['QB','RB','WR','TE','DST','K'].flatMap((position) => Array.from({length:16}, (_,i) => ({
  name:`${position} ${i}`, position, fantasyProsProjection:['DST','K'].includes(position)?undefined:300-i*12,
  fantasyProsRank:i*6+1, fantasyProsPositionRank:i+1, espnAdp:i*10+1,
})));
test('turn planning only runs on our consecutive picks and uses distinct legal players', () => {
  const config = {rankingModel:'think-rmv',draftSlot:1};
  assert.equal(engine.planTurn(players,{currentPick:23},config), null);
  assert.equal(engine.planTurn(players,{currentPick:25},config), null);
  const state = {currentPick:24, roster:[], draftedNames:['RB 0']};
  const plan = engine.planTurn(players,state,config);
  assert.ok(plan);
  assert.notEqual(plan.first.name, plan.second.name);
  assert.notEqual(plan.first.name, 'RB 0');
  assert.notEqual(plan.second.name, 'RB 0');
  assert.equal(plan.first.waitLoss, 0);
  assert.equal(state.draftedNames.length, 1);
});
test('raw QB point totals do not override roster needs', () => {
  const ranked = engine.rankPlayers(players,{currentPick:49,roster:[{name:'QB 0',position:'QB'}],draftedNames:['QB 0']},{rankingModel:'think-rmv',draftSlot:1});
  assert.notEqual(ranked[0].position, 'QB');
});
