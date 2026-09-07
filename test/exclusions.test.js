import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/lib/engine.js';
const e = globalThis.DraftAssistantEngine;
const players = ['Josh Jacobs','Other Runner','Third Runner'].map((name,i) => ({name,position:'RB',fantasyProsRank:i+1,fantasyProsPositionRank:i+1,fantasyProsProjection:300-i*50,vegasPoints:300-i*50}));
test('exclusion migration persists an explicit removal', () => {
  assert.deepEqual(e.loadConfig({}).excludedPlayers,['Josh Jacobs']);
  assert.deepEqual(e.loadConfig({excludedPlayers:[]}).excludedPlayers,[]);
  assert.ok(e.isPlayerExcluded('Josh Jacobs',{excludedPlayers:['JOSH JACOBS']}));
});
test('every model excludes the blocked player without marking him drafted', () => {
  for (const rankingModel of ['fantasypros-ecr','think-rmv','sharp-value','vegas-sharks-80','vegas-only','balanced-v04']) {
    const state = {currentPick:1,draftedNames:[]};
    const ranked = e.rankPlayers(players,state,{rankingModel});
    assert.ok(ranked.length);
    assert.ok(ranked.every(p=>p.name!=='Josh Jacobs'));
    assert.deepEqual(state.draftedNames,[]);
    assert.ok(e.rankPlayers(players,state,{rankingModel,excludedPlayers:[]}).some(p=>p.name==='Josh Jacobs'));
  }
});
test('turn plans filter stale first choices and blocked second choices', () => {
  const state={currentPick:24,roster:[],draftedNames:[]};
  const config={rankingModel:'think-rmv',draftSlot:1};
  const stale=e.rankPlayers(players,state,{...config,excludedPlayers:[]});
  const plan=e.planTurn(players,state,config,stale);
  assert.ok(plan);
  assert.notEqual(plan.first.name,'Josh Jacobs');
  assert.notEqual(plan.second.name,'Josh Jacobs');
});
test('excluding the entire pool leaves no recommendation', () => {
  assert.deepEqual(e.rankPlayers(players,{}, {rankingModel:'think-rmv',excludedPlayers:players.map(p=>p.name)}),[]);
});
