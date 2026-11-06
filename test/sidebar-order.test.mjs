// The "most similar aircraft" list follows the matcher's ranking when a models list is loaded: an A400 shows the C130 JoinFS picks first,
// not every Airbus (which only has the same-manufacturer bonus).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matcherOrder } from '../src/sidebar-order.js';
import { createMatcher, makeReference, makeDoc8643, makeAirlines } from '../src/joinfs-matcher.js';

const json = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const data = json('aircraft-specs.json').aircraft;
const matcher = createMatcher({ reference: makeReference(data), doc8643: makeDoc8643(json('doc8643.json')), airlines: makeAirlines(json('airlines.json')) });
const world = json('test/fixtures/MatchScenarioModels.json').worlds.msfs2024;

test('matcherOrder keeps the matcher order, one entry per type, and skips what ranks before the winner', () => {
  const m = n => ({ source: { n } });
  const [a, b, c, d] = [m(1), m(2), m(3), m(4)];
  const ranking = [{ model: a, total: 90 }, { model: b, total: 80 }, { model: c, total: 70 }, { model: d, total: 60 }];
  const node = { 1: -1, 2: 7, 3: 7, 4: 5 };
  const order = matcherOrder(ranking, b, c2 => node[c2.model.source.n], 10);
  assert.deepEqual(order.map(({ node, total }) => ({ node, total })), [{ node: 7, total: 80 }, { node: 5, total: 60 }]);
  assert.deepEqual(matcherOrder(ranking, b, c2 => node[c2.model.source.n], 1).map(o => o.node), [7]);
  assert.deepEqual(matcherOrder(ranking, { source: {} }, () => 1, 5), []);
});

test('for an A400 the first installed type is the matcher\'s choice, whatever the manufacturer bonus says', () => {
  const airbus = world.find(x => x.tag === 'A306') ?? world.find(x => /^A3/.test(x.tag));
  const c130 = world.find(x => x.tag === 'C130');
  assert.ok(airbus && c130);
  const prepared = matcher.prepareModels([airbus, c130]);
  const found = matcher.match(prepared, { icaoType: 'A400', title: '' });
  const order = matcherOrder(found.ranking, found.model, c => (c.model.icaoType === 'C130' ? 1 : 2), 10);
  assert.equal(found.model.icaoType, 'C130');
  assert.equal(order[0].node, 1);
  assert.ok(order.length < 2 || order[0].total > order[1].total);
});

// ---- the shown score: parts add up, never rises down the list -------------------------------------------------------------------------------------

import { withScores, maxScore, identityParts, SCORE_MAX } from '../src/sidebar-order.js';

const entry = (node, total, extra = {}) => ({ node, total, identity: 0, similarity: 0, near: 0, manufacturer: 0, liveryFirst: false, ...extra });

test('the score of a row never rises down the list, and the shown parts add up to it', () => {
  const order = [entry(1, 230, { identity: 155, similarity: 75 }), entry(2, 220, { identity: 115, similarity: 65, manufacturer: 40 }), entry(3, 185, { identity: 55, similarity: 84, manufacturer: 40, near: 6 })];
  const unranked = [{ index: 9, p: { total: 150, physical: { points: 60 }, nearIdenticalBonus: 0, manufacturerBonus: 40 } }, { index: 8, p: { total: 90, physical: { points: 90 }, nearIdenticalBonus: 0, manufacturerBonus: 0 } }];
  const rows = withScores(order, unranked);
  assert.deepEqual(rows.map(r => r.score), [230, 220, 185, 150, 90]);
  for (const r of rows.slice(0, 3)) assert.equal(r.identity + r.similarity + r.near + r.manufacturer + r.livery, r.score);
  assert.ok(rows.every((r, i) => i === 0 || r.score <= rows[i - 1].score));
});

test('a livery-first row is lifted to the best score below it and says so; the order stays the matcher\'s', () => {
  const order = [entry(1, 185, { identity: 55, similarity: 90, near: 40, liveryFirst: true }), entry(2, 340, { identity: 240, similarity: 100 })];
  const rows = withScores(order, []);
  assert.deepEqual(rows.map(r => r.node), [1, 2]);
  assert.deepEqual(rows.map(r => r.score), [340, 340]);
  assert.equal(rows[0].livery, 155);
  assert.equal(rows[0].identity + rows[0].similarity + rows[0].near + rows[0].livery, rows[0].score);
});

test('an unranked neighbour never shows more than the row above it', () => {
  const rows = withScores([entry(1, 100)], [{ index: 5, p: { total: 160, physical: { points: 100 }, nearIdenticalBonus: 20, manufacturerBonus: 40 } }]);
  assert.equal(rows[1].score, 100);
});

test('the maximum is what a perfect candidate earns; an airline in the request adds its 100 points', () => {
  assert.equal(maxScore(false), SCORE_MAX);
  assert.equal(maxScore(true), SCORE_MAX + 100);
});

test('the identity points are listed by reason, the rest is the shared title words', () => {
  const parts = identityParts({ identity: 170, attrs: { ClassCode: 100, Wtc: 40, Typerole: 15 } });
  assert.deepEqual(parts, [{ reason: 'ClassCode', points: 100 }, { reason: 'Wtc', points: 40 }, { reason: 'Typerole', points: 15 }, { reason: 'Title', points: 15 }]);
  assert.deepEqual(identityParts({ identity: 0, attrs: {} }), []);
  assert.deepEqual(identityParts({ identity: 200, attrs: { IcaoType: 200 } }), [{ reason: 'IcaoType', points: 200 }]);
});

test('a type without a matcher score is placed by its own points among the rows, never before the choice of the matcher', () => {
  const order = [entry(1, 230), entry(2, 150)];
  const unranked = [{ index: 9, p: { total: 200, physical: { points: 100 }, nearIdenticalBonus: 0, manufacturerBonus: 0 } }, { index: 8, p: { total: 40, physical: { points: 40 }, nearIdenticalBonus: 0, manufacturerBonus: 0 } }];
  const rows = withScores(order, unranked);
  assert.deepEqual(rows.map(r => r.node), [1, 9, 2, 8]);
  assert.deepEqual(rows.map(r => r.score), [230, 200, 150, 40]);
  const high = withScores([entry(1, 100)], [{ index: 7, p: { total: 300, physical: { points: 100 }, nearIdenticalBonus: 0, manufacturerBonus: 0 } }]);
  assert.deepEqual(high.map(r => r.node), [1, 7]);
  assert.equal(high[1].score, 100);
});
