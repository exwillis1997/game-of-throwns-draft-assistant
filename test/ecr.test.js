import test from "node:test";
import assert from "node:assert/strict";
import "../extension/lib/engine.js";
const engine = globalThis.DraftAssistantEngine;
test("rankings-only mode ignores unrelated projections and keeps consensus order within a position", () => {
  const players = [
    {name:"First", position:"WR", fantasyProsRank:1},
    {name:"Second", position:"WR", fantasyProsRank:2, vegasPoints:1000, espnAdp:1},
    {name:"Unranked", position:"WR"},
  ];
  const ranked=engine.rankPlayers(players, {}, {rankingModel:"fantasypros-ecr"});
  assert.deepEqual(ranked.map(p=>p.name), ["First","Second"]);
  assert.match(ranked[0].reason, /consensus #1/);
  assert.equal(ranked[0].goneProbability, undefined);
  assert.deepEqual(engine.rankPlayers(players,{draftedNames:["First"]},{rankingModel:"fantasypros-ecr"}).map(p=>p.name),["Second"]);
});
test("rankings-only mode completes the configured lineup and stops at 13 players", () => {
  const players=["QB","RB","WR","TE","DST","K"].flatMap((position,j)=>Array.from({length:20},(_,i)=>({name:`${position} ${i}`,position,fantasyProsRank:i*6+j+1})));
  const roster=[];
  for(let round=1;round<=13;round++){
    const best=engine.rankPlayers(players,{roster,draftedNames:roster.map(p=>p.name),currentPick:engine.overallPickFor(round,1,12)},{rankingModel:"fantasypros-ecr"})[0];
    assert.ok(best);
    roster.push(best);
  }
  const counts=roster.reduce((out,p)=>({...out,[p.position]:(out[p.position]||0)+1}),{});
  assert.equal(engine.maxStarterAssignments(counts,engine.DEFAULT_CONFIG),9);
  assert.equal(engine.rankPlayers(players,{roster},{rankingModel:"fantasypros-ecr"}).length,0);
});
