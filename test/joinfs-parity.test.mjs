// The port of JoinFS' matcher (src/joinfs-matcher.js) must give JoinFS' own answer: winner, its total and the match type, for every scenario of the golden
// file MatchScenarios.json (written by JoinFS.Tests/MatchScenarioExportTests against the installed-model sets of MatchScenarioModels.json).
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

const describe = r => (r ? `${r.model.title} / ${r.model.variation} [${r.model.icaoType}/${r.model.icaoAirline}] ${r.total} ${r.type}` : 'nothing');
const expected = e => (e ? `${e.title} / ${e.variation} [${e.tag}/${e.airline}] ${e.total} ${e.type}` : 'nothing');

test(`the port gives JoinFS' answer in all ${golden.length} golden scenarios`, () => {
  const wrong = [];
  for (const s of golden) {
    const got = matcher.match(worlds[s.world], { icaoType: s.remote.tag, title: s.remote.title, livery: s.remote.livery, icaoAirline: s.remote.airline });
    const ok = s.expect ? got && got.model.title === s.expect.title && got.model.variation === s.expect.variation && got.total === s.expect.total && got.type === s.expect.type : got === null;
    if (!ok) wrong.push(`${s.remote.tag}${s.remote.airline ? ':' + s.remote.airline : ''}${s.remote.title ? ' "' + s.remote.title + '"' : ''}: JoinFS ${expected(s.expect)} | port ${describe(got)}`);
  }
  assert.equal(wrong.length, 0, `${wrong.length} of ${golden.length} differ:\n` + wrong.slice(0, 12).join('\n'));
});

test('the cases of the issue: the right airline on a look-alike, and the livery before the exact type on airliners', () => {
  const answer = (tag, airline) => matcher.match(worlds.msfs2024, { icaoType: tag, icaoAirline: airline }).model;
  assert.equal(answer('B739', 'RYR').title, 'FSLTL_B738_RYR');       // B738 of Ryanair beats the B739 of Air Anatolia
  assert.equal(answer('A20N', 'AFR').icaoType, 'A320');              // the A320 of Air France
  assert.equal(answer('B748', 'UAE').icaoType, 'A343');              // no Emirates 747 installed: an Emirates airliner that is 80 % alike beats the generic B748
});
