// Copies and derives the data files from the JoinFS repository next to the component.
// Usage: npm run sync-data [-- <path to JoinFS/JoinFS/Resources>]
//   aircraft-specs.json                      copied
//   doc8643.json                             designator -> [class code, wake, majority manufacturer, collapsed] from XPMP2_Doc8643.dat
//   airlines.json                            [icao, iata, name] rows from ICAO_Airlines.dat
//   test/fixtures/MatchScenarios*.json       JoinFS' golden answers (JoinFS.Tests), when that folder is next to the Resources folder
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(process.argv[2] ?? resolve(root, '../JoinFS/JoinFS/Resources'));

for (const [from, to] of [['aircraft-specs.json', 'aircraft-specs.json']]) {
  copyFileSync(resolve(src, from), resolve(root, to));
  console.log(`copied ${from}`);
}

const lines = file => readFileSync(resolve(src, file), 'utf8').split(/\r?\n/);

/** Doc8643.FromLines: five tab separated columns, the first row of a designator gives class and wake, the most frequent manufacturer is "the" manufacturer. */
export function doc8643Table(rows) {
  const byIcao = new Map();
  for (const line of rows) {
    const p = line.split('\t');
    if (p.length !== 5) continue;
    const icao = p[2];
    if (!icao || icao === 'ZZZZ') continue;
    const key = icao.toUpperCase();
    if (!byIcao.has(key)) byIcao.set(key, []);
    byIcao.get(key).push({ maker: p[0], cls: p[3], wtc: p[4] });
  }
  const table = {};
  for (const [key, list] of [...byIcao.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const counts = new Map(); // case-insensitive group, first spelling kept
    for (const r of list) {
      const k = r.maker.toLowerCase();
      if (!counts.has(k)) counts.set(k, { name: r.maker, n: 0 });
      counts.get(k).n++;
    }
    const major = [...counts.values()].sort((a, b) => b.n - a.n || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0))[0].name;
    table[key] = [list[0].cls, list[0].wtc, major, list.every(r => r.maker === '(ANY)') ? 1 : 0];
  }
  return table;
}

/** AirlineDirectory.FromLines: ICAO (3 letters), optional IATA, name. */
export function airlineRows(rows) {
  const out = [];
  for (const line of rows) {
    const p = line.split('\t');
    if (p.length < 3) continue;
    const icao = p[0].trim().toUpperCase(), iata = p[1].trim().toUpperCase(), name = p[2].trim();
    if (icao.length !== 3 || !name) continue;
    out.push([icao, iata, name]);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const table = doc8643Table(lines('XPMP2_Doc8643.dat'));
  writeFileSync(resolve(root, 'doc8643.json'), JSON.stringify(table) + '\n');
  console.log(`wrote doc8643.json (${Object.keys(table).length} designators)`);
  const airlines = airlineRows(lines('ICAO_Airlines.dat'));
  writeFileSync(resolve(root, 'airlines.json'), JSON.stringify(airlines) + '\n');
  console.log(`wrote airlines.json (${airlines.length} airlines)`);

  const tests = resolve(src, '../../JoinFS.Tests');
  if (existsSync(tests)) {
    mkdirSync(resolve(root, 'test/fixtures'), { recursive: true });
    for (const f of ['MatchScenarios.json', 'MatchScenarioModels.json']) {
      if (existsSync(resolve(tests, f))) { copyFileSync(resolve(tests, f), resolve(root, 'test/fixtures', f)); console.log(`copied ${f} to test/fixtures`); }
    }
  }
}
