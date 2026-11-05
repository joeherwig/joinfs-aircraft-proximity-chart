import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { proximity, buildIndex, physicalSimilarity, isImplausible, MAX_POINTS } from '../src/proximity.js';

const data = JSON.parse(readFileSync(new URL('../aircraft-specs.json', import.meta.url), 'utf8')).aircraft;
const by = Object.fromEntries(data.slice().reverse().map(a => [a.icao, a])); // the first row of a designator is its default

const mk = (o = {}) => ({ icao: 'T', manufacturer: 'X', wing: 'low', spanM: 10, lengthM: 8, mtowKg: 1000, engines: 1, engineType: 'piston', cruiseKt: 120, gear: 'tricycle', ...o });

test('rows are unique by designator and name (several rows may share a folded designator such as GLID)', () => {
  assert.equal(new Set(data.map(a => `${a.icao}${a.name}`)).size, data.length);
});

test('identical specs give full physical similarity', () => {
  const p = physicalSimilarity(mk(), mk());
  assert.equal(p.score, 1);
  assert.equal(p.confidence, 1);
});

test('weight distance saturates at factor 4', () => {
  const p = physicalSimilarity(mk({ mtowKg: 1000 }), mk({ mtowKg: 4000 }));
  assert.equal(p.parts.find(x => x.feature === 'mtow').distance, 1);
  const q = physicalSimilarity(mk({ mtowKg: 1000 }), mk({ mtowKg: 2000 }));
  assert.ok(Math.abs(q.parts.find(x => x.feature === 'mtow').distance - 0.5) < 1e-9);
});

test('engine type, wing and gear distance tables', () => {
  const d = (k, a, b) => physicalSimilarity(mk({ [k]: a }), mk({ [k]: b })).parts.find(x => x.feature === (k === 'engines' ? 'engineCount' : k)).distance;
  assert.equal(d('engineType', 'piston', 'turboprop'), 0.5);
  assert.equal(d('engineType', 'turboshaft', 'turboprop'), 0.4);
  assert.equal(d('engineType', 'jet', 'turboshaft'), 0.9);
  assert.equal(d('engineType', 'jet', 'piston'), 1);
  assert.equal(d('engines', 1, 2), 0.6);
  assert.equal(d('engines', 1, 3), 1);
  assert.equal(d('wing', 'mid', 'low'), 0.5);
  assert.equal(d('wing', 'high', 'low'), 1);
  assert.equal(d('gear', 'tricycle', 'taildragger'), 0.6);
  assert.equal(d('gear', 'floats', 'tricycle'), 0.8);
  assert.equal(d('gear', 'skids', 'tricycle'), 1);
});

test('missing values are skipped, not penalised', () => {
  const p = physicalSimilarity(mk({ cruiseKt: null }), mk({ cruiseKt: 300 }));
  assert.equal(p.score, 1);
  assert.ok(p.confidence < 1 && Math.abs(p.confidence - 13 / 15) < 1e-9);
});

test('without size features confidence is measured against engines + gear', () => {
  const nul = { mtowKg: null, spanM: null, lengthM: null };
  const p = physicalSimilarity(mk(nul), mk(nul));
  assert.equal(p.confidence, 1);
});

test('gate: rotor vs fixed wing and weight ratio above 8', () => {
  assert.ok(isImplausible(by.R44, by.C172));
  assert.ok(isImplausible(by.C172, by.B744));
  assert.ok(!isImplausible(by.C172, by.P28A));
  const p = proximity(by.R44, by.C172);
  assert.ok(p.excluded && !p.accepted && p.manufacturerBonus === 0 && p.nearIdenticalBonus === 0);
});

test('same-manufacturer bonus needs similar size', () => {
  assert.equal(proximity(by.R22, by.R44).manufacturerBonus, 40);
  assert.equal(proximity(mk({ mtowKg: 1000 }), mk({ mtowKg: 3000 })).manufacturerBonus, 0); // factor 3 > 2.5
  assert.equal(proximity(mk({ manufacturer: '-' }), mk({ manufacturer: '-' })).manufacturerBonus, 0);
});

test('near identical bonus and acceptance (no family list)', () => {
  const p = proximity(by.A320, by.A20N);
  assert.ok(p.nearIdenticalBonus > 0 && p.nearIdenticalBonus <= 60);
  assert.ok(p.accepted);
  assert.ok(p.total <= MAX_POINTS);
  assert.equal(proximity(by.C172, by.B744).nearIdenticalBonus, 0);
});

test('proximity is symmetric', () => {
  const ab = proximity(by.C172, by.P28A);
  const ba = proximity(by.P28A, by.C172);
  assert.equal(ab.total, ba.total);
});

test('plausible neighbours for well known types', () => {
  const idx = buildIndex(data);
  const top = icao => idx.neighbours[data.findIndex(a => a.icao === icao)].slice(0, 6).map(n => n.icao);
  console.log('C172', top('C172').join(' '));
  console.log('A320', top('A320').join(' '));
  console.log('B744', top('B744').join(' '));
  console.log('R44 ', top('R44').join(' '));
  assert.ok(top('A320').includes('A20N') && top('A320').includes('A319'));
  assert.ok(top('B744').includes('B748'));
  assert.ok(!top('R44').some(i => !by[i].rotor));
  assert.ok(top('C172').every(i => by[i].mtowKg < 5000));
});

// ---- the matched aircraft is always in the list, with its real position ----

import { neighbourOf } from '../src/proximity.js';

test('neighbourOf gives the real position of an aircraft among all others, accepted or not', () => {
  const index = buildIndex(data.slice(0, 80), null);
  const i = 0;
  const accepted = index.neighbours[i][3];
  const known = neighbourOf(index, i, accepted.index);
  assert.equal(known.rank, 4);                       // its place in the accepted list
  assert.equal(known.index, accepted.index);

  const acceptedSet = new Set(index.neighbours[i].map(n => n.index));
  const farOff = index.aircraft.findIndex((a, j) => j !== i && !acceptedSet.has(j));
  const far = neighbourOf(index, i, farOff);
  assert.ok(far.rank > index.neighbours[i].length);  // behind every accepted neighbour
  assert.ok(far.rank <= 80 - 1);
  assert.ok(far.p.percent >= 0 && far.p.percent <= 1);
  assert.equal(neighbourOf(index, i, i), null);      // an aircraft is not its own neighbour
});
