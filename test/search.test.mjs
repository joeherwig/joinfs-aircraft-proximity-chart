// The search box never falls back to "everything": a text nothing fits selects nothing (it used to select the first aircraft of the alphabet, the A10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchTier, bestSearchTier, isSearchHit, NO_MATCH } from '../src/search.js';

const data = JSON.parse(readFileSync(new URL('../aircraft-specs.json', import.meta.url), 'utf8')).aircraft;
const hits = search => { const best = bestSearchTier(data, search); return data.filter(a => isSearchHit(a, search, best)); };

test('a search that no aircraft fits has no hits at all', () => {
  for (const q of ['ZZZQQ', 'B22X9', 'not an aircraft', 'Q9Q9']) {
    assert.equal(bestSearchTier(data, q), NO_MATCH, q);
    assert.deepEqual(hits(q).map(a => a.icao), [], q);
  }
});

test('an empty search hits every aircraft', () => {
  assert.equal(hits('').length, data.length);
  assert.equal(hits('   ').length, data.length);
});

test('a type that is in the data is found, and only by the best tier', () => {
  assert.deepEqual(hits('C177').map(a => a.icao), ['C177']);
  assert.equal(searchTier(data.find(a => a.icao === 'C177'), 'c-177'), 1);
  assert.ok(hits('A321').some(a => a.icao === 'A321'));
});

test('the new helicopters of the add-ons are found by their designators and names', () => {
  for (const q of ['B222', 'B22U', 'ALO3', 'LAMA', 'AS65', 'Alouette III', 'HH-65']) assert.ok(hits(q).length > 0, q);
});
