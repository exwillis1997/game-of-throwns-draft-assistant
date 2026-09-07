import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import '../extension/lib/engine.js';
import '../extension/lib/scoring.js';

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if (c === '\n' && !quoted) { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
const layouts = {
  QB: {header: 'Player,Team,ATT,CMP,YDS,TDS,INTS,ATT,YDS,TDS,FL,FPTS', stats: {PY:4,PTD:5,INT:6,RY:8,RTD:9,FUML:10}},
  RB: {header: 'Player,Team,ATT,YDS,TDS,REC,YDS,TDS,FL,FPTS', stats: {RY:3,RTD:4,REC:5,REY:6,RETD:7,FUML:8}},
  WR: {header: 'Player,Team,REC,YDS,TDS,ATT,YDS,TDS,FL,FPTS', stats: {REC:2,REY:3,RETD:4,RY:6,RTD:7,FUML:8}},
  TE: {header: 'Player,Team,REC,YDS,TDS,FL,FPTS', stats: {REC:2,REY:3,RETD:4,FUML:5}},
};
export function projectionRows(csv, position) {
  const [header, ...rows] = parseCsv(csv.replace(/^\uFEFF/, ''));
  const layout = layouts[position];
  if (!layout || header.join(',') !== layout.header) throw new Error(`Unexpected ${position} projection columns`);
  return rows.filter(row => row[0]?.trim()).map(row => {
    const stats = Object.fromEntries(Object.entries(layout.stats).map(([key, index]) => {
      const value = Number(row[index]?.replaceAll(',', ''));
      if (!row[index]?.trim() || !Number.isFinite(value) || (value < 0 && !['PY','RY','REY'].includes(key))) throw new Error(`Invalid ${key} for ${row[0]}`);
      return [key, value];
    }));
    return {name:row[0], team:row[1], position, stats};
  });
}
export function enrich(dataset, directory) {
  const result = structuredClone(dataset);
  for (const player of result.players) {
    delete player.espnAdp;
    delete player.fantasyProsProjection;
    if (player.statProjections) delete player.statProjections.fantasyProsProjection;
  }
  const normalize = globalThis.DraftAssistantEngine.normalizeName;
  const teamKey = team => ({JAC:'JAX',WSH:'WAS'})[team] || team;
  const find = (name, position, team) => result.players.filter(p => normalize(p.name) === normalize(name) && p.position === position && (!team || teamKey(p.team) === teamKey(team)));
  const report = {projections:0, espnAdp:0, unmatched:[]};
  for (const position of Object.keys(layouts)) {
    for (const row of projectionRows(fs.readFileSync(path.join(directory, `FantasyPros_Fantasy_Football_Projections_${position}.csv`), 'utf8'), position)) {
      const matches = find(row.name, position, row.team);
      if (matches.length !== 1) { report.unmatched.push(`${row.name} (${position}, ${row.team})`); continue; }
      matches[0].statProjections = {...matches[0].statProjections, fantasyProsProjection:row.stats};
      report.projections++;
    }
  }
  const [header, ...rows] = parseCsv(fs.readFileSync(path.join(directory, 'FantasyPros_2026_Overall_ADP_Rankings.csv'), 'utf8'));
  const adpIndex = header.indexOf('ESPN');
  if (adpIndex < 0 || header[1] !== 'Player (Bye)' || header[2] !== 'POS') throw new Error('Expected ESPN ADP export');
  for (const row of rows) {
    const match = row[1]?.match(/^(.*?)\s+([A-Z]{2,3})\s+\(\d+\)$/);
    const adp = Number(row[adpIndex]);
    if (!match || !row[adpIndex]?.trim() || !Number.isFinite(adp) || adp <= 0) continue;
    const players = find(match[1].trim(), row[2].replace(/\d/g,''), match[2]);
    if (players.length === 1) { players[0].espnAdp = adp; report.espnAdp++; }
  }
  for (const position of Object.keys(layouts)) {
    if (result.players.filter(p => p.position === position && p.statProjections?.fantasyProsProjection).length < 12) throw new Error(`Insufficient matched ${position} projections`);
  }
  if (report.espnAdp < 100) throw new Error('Insufficient matched ESPN ADP values');
  result.meta = {...result.meta, rankingsOnly:false, supportedModels:['fantasypros-ecr','think-rmv'], projectionImportVersion:1,
    enrichedAt:new Date().toISOString(), sources:{...result.meta.sources, projections:'FantasyPros 2026 season stat projections', espnAdp:'FantasyPros 2026 PPR ADP export, ESPN column'},
    notes:'Base PPR projections; long-TD, two-point and return bonuses unavailable. DST/K use ECR. ADP is a timing heuristic, not a probability.', coverage:report};
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, directory] = process.argv.slice(2);
  if (!input || !directory) throw new Error('Usage: node scripts/import-fantasypros.mjs rankings.json download-directory');
  const result = enrich(JSON.parse(fs.readFileSync(input, 'utf8')), directory);
  fs.writeFileSync(input, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result.meta.coverage));
}
