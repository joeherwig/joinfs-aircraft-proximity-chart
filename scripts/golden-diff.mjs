// Runs the matcher over JoinFS' golden scenarios (test/fixtures/MatchScenarios.json = today's JoinFS answers) and lists every scenario whose winner changes.
// Usage: node scripts/golden-diff.mjs [--write]   --write stores the list as test/fixtures/golden-changes.json (the winners the new rules give, once reviewed).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMatcher, makeReference, makeDoc8643, makeAirlines } from '../src/joinfs-matcher.js';

const root = new URL('../', import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));

export function goldenDiff() {
  const matcher = createMatcher({ reference: makeReference(json('aircraft-specs.json').aircraft), doc8643: makeDoc8643(json('doc8643.json')), airlines: makeAirlines(json('airlines.json')) });
  const worlds = Object.fromEntries(Object.entries(json('test/fixtures/MatchScenarioModels.json').worlds).map(([name, models]) => [name, matcher.prepareModels(models)]));
  const changes = [];
  for (const s of json('test/fixtures/MatchScenarios.json').scenarios) {
    const got = matcher.match(worlds[s.world], { icaoType: s.remote.tag, title: s.remote.title, livery: s.remote.livery, icaoAirline: s.remote.airline });
    const same = s.expect ? got && got.model.title === s.expect.title && got.model.variation === s.expect.variation : got === null;
    if (!same) {
      changes.push({
        world: s.world, remote: s.remote,
        before: s.expect ? { title: s.expect.title, variation: s.expect.variation, tag: s.expect.tag, airline: s.expect.airline } : null,
        after: got ? { title: got.model.title, variation: got.model.variation, tag: got.model.icaoType, airline: got.model.icaoAirline } : null,
      });
    }
  }
  return { total: json('test/fixtures/MatchScenarios.json').scenarios.length, changes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { total, changes } = goldenDiff();
  const label = a => (a ? `${a.tag}/${a.airline || '-'} ${a.title}` : 'nothing');
  console.log(`${changes.length} of ${total} scenarios change their winner`);
  for (const c of changes) console.log(`${c.remote.tag}${c.remote.airline ? ':' + c.remote.airline : ''}${c.remote.title ? ' "' + c.remote.title + '"' : ''}${c.remote.livery ? ' [' + c.remote.livery + ']' : ''}\n    before ${label(c.before)}\n    after  ${label(c.after)}`);
  if (process.argv.includes('--write')) writeFileSync(new URL('test/fixtures/golden-changes.json', root), JSON.stringify({ status: 'proposed - to be reviewed', changes }, null, 2) + '\n');
}
