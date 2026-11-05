// Parity check: every locale file must have exactly the keys and {placeholders} of the English dictionary in src/i18n.js.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.document = { currentScript: null, querySelectorAll: () => [], baseURI: 'http://localhost/' };
const { EN, LOCALES } = await import(pathToFileURL(resolve(root, 'src/i18n.js')).href);

const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
let errors = 0;
const fail = msg => { console.error(msg); errors++; };

const files = readdirSync(root).filter(f => /^joinfs-proximity-chart-[a-z]{2}\.json$/.test(f));
for (const l of LOCALES) if (!files.includes(`joinfs-proximity-chart-${l}.json`)) fail(`missing locale file for ${l}`);
for (const f of files) {
  const lang = f.match(/-([a-z]{2})\.json$/)[1];
  if (!LOCALES.includes(lang)) fail(`${f}: unexpected locale (JoinFS locales + uk only, never ru)`);
  const dict = JSON.parse(readFileSync(resolve(root, f), 'utf8'));
  for (const k of Object.keys(EN)) {
    if (!(k in dict)) fail(`${f}: missing key ${k}`);
    else if (placeholders(dict[k]) !== placeholders(EN[k])) fail(`${f}: placeholders differ for ${k}`);
  }
  for (const k of Object.keys(dict)) if (!(k in EN)) fail(`${f}: unknown key ${k}`);
}
if (errors) { console.error(`${errors} problem(s)`); process.exit(1); }
console.log(`${files.length} locale files match the ${Object.keys(EN).length} English keys`);
