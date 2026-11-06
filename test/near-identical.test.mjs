// Families (XPMP2_related.dat) are gone: how alike two aircraft are decides, not a list. Airliners with the requested (verified) airline and a
// similarity of 80 % or more beat an exact ICAO type of another airline; GA, helicopters, balloons and gliders keep "exact type first".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as proximityModule from '../src/proximity.js';
import { proximity, buildIndex, physicalSimilarity, nearIdenticalBonus, NEAR_FROM, NEAR_MAX } from '../src/proximity.js';
import * as matcherModule from '../src/joinfs-matcher.js';
import { createMatcher, makeReference, makeDoc8643, makeAirlines } from '../src/joinfs-matcher.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const json = name => JSON.parse(read(name));
const data = json('aircraft-specs.json').aircraft;
const by = Object.fromEntries(data.slice().reverse().map(a => [a.icao, a]));

const matcher = createMatcher({ reference: makeReference(data), doc8643: makeDoc8643(json('doc8643.json')), airlines: makeAirlines(json('airlines.json')) });
const world = json('test/fixtures/MatchScenarioModels.json').worlds.msfs2024;
const model = (tag, airline) => {
  const found = world.find(m => m.tag === tag && m.airline === airline);
  assert.ok(found, `${tag}/${airline} is in the golden world`);
  return { ...found, title: `FSLTL_${tag}_${airline}` }; // one model per type and airline, with a title the tests can name
};
const pick = (models, request) => matcher.match(matcher.prepareModels(models), request);

// ---- the family file is not used any more ----------------------------------------------------------------------------------------------------------

test('no code reads related groups any more', () => {
  assert.equal(proximityModule.parseRelated, undefined);
  assert.equal(matcherModule.makeRelated, undefined);
  const sim = proximity(by.A320, by.A20N);
  assert.equal('relatedBonus' in sim, false);
});

test('the neighbour index does not depend on a family argument', () => {
  const a = buildIndex(data.slice(0, 60));
  const b = buildIndex(data.slice(0, 60), { family: new Map([['C172', 1]]) });
  assert.deepEqual(a.neighbours.map(n => n.map(x => x.icao)), b.neighbours.map(n => n.map(x => x.icao)));
});

// ---- the near-identical bonus -----------------------------------------------------------------------------------------------------------------------

test('near-identical bonus: nothing below 80 %, rising, at most NEAR_MAX, scaled by confidence', () => {
  assert.equal(NEAR_FROM, 0.8);
  assert.equal(nearIdenticalBonus({ score: 0.79, confidence: 1 }), 0);
  assert.equal(nearIdenticalBonus({ score: 0.8, confidence: 1 }), 0);
  assert.equal(nearIdenticalBonus({ score: 1, confidence: 1 }), NEAR_MAX);
  let last = 0;
  for (let s = 0.8; s <= 1.0001; s += 0.02) {
    const bonus = nearIdenticalBonus({ score: Math.min(1, s), confidence: 1 });
    assert.ok(bonus >= last, `monotonic at ${s}`);
    last = bonus;
  }
  assert.equal(nearIdenticalBonus({ score: 1, confidence: 0.8 }), Math.round(NEAR_MAX * 0.8));
  assert.equal(nearIdenticalBonus({ score: 1, confidence: 0.73 }), 0, 'too little is known to call two aircraft identical');
  assert.equal(nearIdenticalBonus({ score: 1, confidence: 0 }), 0);
});

test('look-alikes of one family still rank each other first, without any list', () => {
  const index = buildIndex(data);
  const top = (icao, n = 6) => index.neighbours[data.findIndex(a => a.icao === icao)].slice(0, n).map(x => x.icao);
  assert.ok(top('A320').includes('A20N') && top('A320', 8).includes('A321'));
  assert.ok(top('B744').includes('B748'));
  assert.ok(top('B748', 10).includes('A388'), `A388 is a close neighbour of the B748: ${top('B748', 10).join(' ')}`);
});

test('proximity is symmetric and a pair only counts when the gate lets it pass', () => {
  assert.equal(proximity(by.C172, by.P28A).total, proximity(by.P28A, by.C172).total);
  const rotorVsWing = proximity(by.R44, by.C172);
  assert.ok(rotorVsWing.excluded && !rotorVsWing.accepted && rotorVsWing.nearIdenticalBonus === 0);
  assert.ok(proximity(by.A320, by.A20N).accepted);
  assert.ok(physicalSimilarity(by.A320, by.A20N).score >= 0.9);
});

// ---- airliners: verified airline + 80 % similarity beats an exact type of another airline -------------------------------------------------------------

test('B748 UAE: a UAE A388 beats the exact B748 of another airline (livery first, airliners)', () => {
  const models = [model('B748', 'DLH'), model('A388', 'UAE')];
  assert.equal(pick(models, { icaoType: 'B748', icaoAirline: 'UAE' }).model.title, 'FSLTL_A388_UAE');
});

test('B748 UAE: a UAE B744 still beats a UAE A388 (more alike), and the B744 of another airline loses to the A388', () => {
  assert.equal(pick([model('B744', 'BAW'), model('A388', 'UAE')], { icaoType: 'B748', icaoAirline: 'UAE' }).model.title, 'FSLTL_A388_UAE');
  const b744Uae = { ...model('B744', 'BAW'), title: 'FSLTL_B744_UAE', variation: 'UAE', airline: 'UAE' };
  assert.equal(pick([b744Uae, model('A388', 'UAE')], { icaoType: 'B748', icaoAirline: 'UAE' }).model.title, 'FSLTL_B744_UAE');
});

test('without an airline the exact type still wins', () => {
  const models = [model('B748', 'DLH'), model('A388', 'UAE')];
  assert.equal(pick(models, { icaoType: 'B748' }).model.title, 'FSLTL_B748_DLH');
});

test('a guessed airline (found only in the title) never overrides the exact type', () => {
  const models = [model('B748', 'DLH'), model('A388', 'UAE')];
  assert.equal(pick(models, { icaoType: 'B748', title: 'Emirates 747-8' }).model.title, 'FSLTL_B748_DLH');
});

test('an unknown airline code gives no bonus', () => {
  const models = [model('B748', 'DLH'), model('A388', 'UAE')];
  assert.equal(pick(models, { icaoType: 'B748', icaoAirline: 'QQQ' }).model.title, 'FSLTL_B748_DLH');
});

test('a callsign of the form UAE123 is a verified airline, a registration is not', () => {
  const models = [model('B748', 'DLH'), model('A388', 'UAE')];
  assert.equal(pick(models, { icaoType: 'B748', callsign: 'UAE123' }).model.title, 'FSLTL_A388_UAE');
  assert.equal(pick(models, { icaoType: 'B748', callsign: 'N748UA' }).model.title, 'FSLTL_B748_DLH');
  assert.equal(pick(models, { icaoType: 'B748', callsign: 'D-EABC' }).model.title, 'FSLTL_B748_DLH');
});

test('below 80 % similarity the exact type wins even with the airline', () => {
  // a 737 is far less alike to a 747-8 than an A380 is
  const models = [model('B748', 'DLH'), model('B738', 'QFA')];
  assert.equal(pick(models, { icaoType: 'B748', icaoAirline: 'QFA' }).model.title, 'FSLTL_B748_DLH');
});

test('the exact type with the airline beats everything', () => {
  const exactWithAirline = { ...model('B748', 'DLH'), title: 'FSLTL_B748_UAE', variation: 'UAE', airline: 'UAE' };
  const withExact = [model('B748', 'DLH'), model('A388', 'UAE'), exactWithAirline];
  assert.equal(pick(withExact, { icaoType: 'B748', icaoAirline: 'UAE' }).model.title, 'FSLTL_B748_UAE');
});

// ---- not airliners: the exact type keeps outranking the livery ---------------------------------------------------------------------------------------

const ga = (title, tag, airline, extra = {}) => ({ title, manufacturer: 'X', type: tag, variation: airline, role: 'SingleProp', tag, wtc: 'L', airline, classCode: 'L1P', confirmed: true, ...extra });

test('a GA plane with a stray airline callsign is never re-typed', () => {
  const models = [ga('C172 plain', 'C172', 'ZZZZ'), ga('PA28 UAE', 'P28A', 'UAE')];
  assert.equal(pick(models, { icaoType: 'C172', icaoAirline: 'UAE' }).model.title, 'C172 plain');
  assert.equal(pick(models, { icaoType: 'C172', callsign: 'UAE123' }).model.title, 'C172 plain');
});

test('helicopters, gliders and balloons keep exact type before airline', () => {
  const heli = (title, tag, airline) => ({ title, manufacturer: 'ROBINSON', type: tag, variation: airline, role: 'Rotorcraft', tag, wtc: 'L', airline, classCode: 'H1P', confirmed: true });
  const models = [heli('R44 plain', 'R44', 'ZZZZ'), heli('R22 UAE', 'R22', 'UAE')];
  assert.equal(pick(models, { icaoType: 'R44', icaoAirline: 'UAE' }).model.title, 'R44 plain');
});

test('an airliner request never takes a GA model for the livery', () => {
  const models = [model('B748', 'DLH'), ga('C172 UAE', 'C172', 'UAE')];
  assert.equal(pick(models, { icaoType: 'B748', icaoAirline: 'UAE' }).model.title, 'FSLTL_B748_DLH');
});

// ---- a type without reference data ---------------------------------------------------------------------------------------------------------------

test('an AN2 takes the Beaver, not a type whose only data is "1 piston engine"', () => {
  const plain = (title, tag) => ({ title, tag, airline: '', role: 'SingleProp', wtc: 'L', classCode: 'L1P', confirmed: true });
  const found = pick([plain('Jetson One', 'ONE'), plain('DHC-2 Beaver', 'DHC2')], { icaoType: 'AN2', title: '' });
  assert.equal(found.model.title, 'DHC-2 Beaver');
});

test('a type without spec data gets no similarity credit at all (it can still win on its identity)', () => {
  const plain = (title, tag) => ({ title, tag, airline: '', role: 'SingleProp', wtc: 'L', classCode: 'L1P', confirmed: true });
  const found = pick([plain('Jetson One', 'ONE')], { icaoType: 'AN2', title: '' });
  const entry = found.ranking[0];
  assert.equal(entry.similarityPoints, 0);
  assert.equal(entry.similarity.confidence, 0);
  assert.equal(entry.nearPoints, 0);
});
