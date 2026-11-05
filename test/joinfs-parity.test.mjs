// The port of JoinFS' matcher (src/joinfs-matcher.js) against the golden file MatchScenarios.json (JoinFS' answers TODAY, written by
// JoinFS.Tests/MatchScenarioExportTests). This chart is one step ahead of JoinFS: no aircraft families, and an airliner of the requested airline that is
// at least 80 % alike beats an exact type of another airline. Every scenario whose winner changes because of that is listed in
// test/fixtures/golden-changes.json (node scripts/golden-diff.mjs --write) and has to be reviewed; all others must still give JoinFS' answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMatcher, makeReference, makeDoc8643, makeAirlines } from '../src/joinfs-matcher.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const json = name => JSON.parse(read(name));

const matcher = createMatcher({
  reference: makeReference(json('aircraft-specs.json').aircraft),
  doc8643: makeDoc8643(json('doc8643.json')),
  airlines: makeAirlines(json('airlines.json')),
});
const worlds = Object.fromEntries(Object.entries(json('test/fixtures/MatchScenarioModels.json').worlds).map(([name, models]) => [name, matcher.prepareModels(models)]));
const golden = json('test/fixtures/MatchScenarios.json').scenarios;
const changes = json('test/fixtures/golden-changes.json').changes;

const keyOf = (world, remote) => JSON.stringify([world, remote.tag, remote.title, remote.livery, remote.airline]);
const changed = new Map(changes.map(c => [keyOf(c.world, { tag: c.remote.tag, title: c.remote.title, livery: c.remote.livery, airline: c.remote.airline }), c.after]));

const describe = r => (r ? `${r.model.title} / ${r.model.variation} [${r.model.icaoType}/${r.model.icaoAirline}]` : 'nothing');

test(`the port gives JoinFS' answer in the unchanged golden scenarios and the reviewed answer in the ${changes.length} changed ones`, () => {
  const wrong = [];
  for (const s of golden) {
    const got = matcher.match(worlds[s.world], { icaoType: s.remote.tag, title: s.remote.title, livery: s.remote.livery, icaoAirline: s.remote.airline });
    const key = keyOf(s.world, s.remote);
    const expectation = changed.has(key) ? changed.get(key) : s.expect && { title: s.expect.title, variation: s.expect.variation };
    const ok = expectation ? got && got.model.title === expectation.title && got.model.variation === expectation.variation : got === null;
    if (!ok) wrong.push(`${s.remote.tag}${s.remote.airline ? ':' + s.remote.airline : ''}: expected ${expectation ? expectation.title : 'nothing'} | port ${describe(got)}`);
  }
  assert.equal(wrong.length, 0, `${wrong.length} of ${golden.length} differ:\n` + wrong.slice(0, 12).join('\n'));
});

test('the change list only holds airliner-livery cases and nothing for GA, helicopters or gliders', () => {
  const gaTags = new Set(['C172', 'P28A', 'R44', 'R22', 'GLID', 'P51', 'DA40', 'SR22', 'PA28']);
  assert.ok(changes.length > 0);
  assert.deepEqual(changes.filter(c => gaTags.has(c.remote.tag)).map(c => c.remote.tag), []);
});

test('the cases of the issue: the right airline on a look-alike', () => {
  const answer = (tag, airline) => matcher.match(worlds.msfs2024, { icaoType: tag, icaoAirline: airline }).model;
  assert.equal(answer('B739', 'RYR').title, 'FSLTL_B738_RYR');       // B738 of Ryanair beats the B739 of Air Anatolia
  assert.equal(answer('A20N', 'AFR').icaoType, 'A320');              // the A320 of Air France
});
