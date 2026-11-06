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
  assert.deepEqual(order, [{ node: 7, score: 80 }, { node: 5, score: 60 }]);
  assert.deepEqual(matcherOrder(ranking, b, c2 => node[c2.model.source.n], 1), [{ node: 7, score: 80 }]);
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
  assert.ok(order.length < 2 || order[0].score > order[1].score);
});
