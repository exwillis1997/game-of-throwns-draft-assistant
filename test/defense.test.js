import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/lib/engine.js';
import '../extension/lib/espn-detector.js';
const engine=globalThis.DraftAssistantEngine;
test('matches ESPN mascot defense labels to full ranking names',()=>{
  for(const [full,mascot] of [['Houston Texans','Texans'],['Los Angeles Rams','Rams'],['New York Jets','Jets'],['New York Giants','Giants'],['San Francisco 49ers','49ers']]){
    for(const name of [mascot,`${mascot} D/ST`,`${mascot} DST`,`${full} D/ST`]) assert.equal(engine.normalizeName(name),engine.normalizeName(full));
  }
  assert.notEqual(engine.normalizeName('New York Jets'),engine.normalizeName('New York Giants'));
});
test('drafted ESPN defense disappears from every ranking model',()=>{
  const players=[{name:'Houston Texans',position:'DST',fantasyProsRank:155},{name:'Denver Broncos',position:'DST',fantasyProsRank:164}];
  for(const rankingModel of ['fantasypros-ecr','sharp-value','think-rmv','vegas-only','vegas-sharks-80','balanced-v04']) {
    const ranked=engine.rankPlayers(players,{currentPick:144,draftedNames:['Texans D/ST']},{rankingModel});
    assert.deepEqual(ranked.map(p=>p.name),['Denver Broncos']);
  }
});
test('history and board labels for the same defense count as one drafted player',()=>{
  const root={querySelectorAll(selector){
    if(selector.includes('.pick-message__container'))return [{textContent:'Texans D/ST'}];
    return [{querySelector(selector){return {textContent:selector==='.playerFirstName'?'Houston':'Texans'};}}];
  }};
  assert.equal(globalThis.EspnDraftDetector.draftedNames(root).length,1);
});
