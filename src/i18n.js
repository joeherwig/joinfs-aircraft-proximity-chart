// Localisation: English is built in, every other language is <component>-<locale>.json next to the script.

export const COMPONENT = 'joinfs-proximity-chart';
export const LOCALES = ['de', 'es', 'fr', 'it', 'ko', 'nl', 'pt', 'uk'];

// Captured while the script first runs; later (async) code cannot rely on document.currentScript.
export const SCRIPT_URL = (() => {
  const own = document.currentScript?.src;
  if (own) return own;
  const tag = [...document.querySelectorAll('script[src]')].find(s => s.src.includes(COMPONENT));
  return tag ? tag.src : document.baseURI;
})();

export const EN = {
  'chart.aria': 'Aircraft proximity chart',
  'chart.hint': 'Click an aircraft to see the most similar types. Scroll to zoom, drag to pan.',
  'status.loading': 'Loading aircraft data…',
  'status.error': 'Could not load the aircraft data from {url}.',
  'status.errorFile': 'Browsers block loading data files from file:// pages. Please serve this page over http(s).',
  'status.count': 'Aircraft shown: {shown} of {total}',
  'toolbar.search': 'Search',
  'toolbar.searchPlaceholder': 'ICAO type, alias, name, manufacturer…',
  'toolbar.colorBy': 'Colour by',
  'toolbar.neighbours': 'Neighbours per aircraft: {n}',
  'toolbar.minProximity': 'Minimum proximity: {n}%',
  'toolbar.filters': 'Filters & view',
  'toolbar.callsign': 'Callsign',
  'toolbar.callsignPlaceholder': 'e.g. DLH123 or Lufthansa',
  'toolbar.title': 'Aircraft title',
  'toolbar.titlePlaceholder': 'e.g. Grunau Baby or ASK 21',
  'toolbar.titleResolved': 'Title matches: {row}',
  'toolbar.titleNeedsType': 'Select an aircraft type first (e.g. GLID)',
  'toolbar.titleSingleRow': '{icao} has only one entry - the title does not change it',
  'toolbar.airlineResolved': 'Airline: {code}',
  'toolbar.callsignInTitle': 'Livery found by callsign',
  'toolbar.airlineUnknown': 'Airline not in the models list',
  'toolbar.reset': 'Reset',
  'toolbar.loadModels': 'Load installed models…',
  'toolbar.loadModelsHint': 'Choose the JoinFS models list "models - <simulator>.txt". It is usually in the folder %LocalAppData%\\JoinFS-<simulator>, e.g. %LocalAppData%\\JoinFS-FS2024\\models - Microsoft Flight Simulator 2024.txt',
  'toolbar.clearModels': 'Remove model list',
  'toolbar.modelsLoaded': 'Models: {n} in {types} aircraft types',
  'toolbar.modelsInvalid': 'This file is not a JoinFS models list.',
  'filter.all': 'All',
  'filter.engineType': 'Engine type',
  'filter.engines': 'Engines',
  'filter.wing': 'Wing',
  'filter.gear': 'Landing gear',
  'filter.manufacturer': 'Manufacturer',
  'legend.other': 'Other',
  'legend.size': 'Bubble size: take-off weight',
  'detail.empty': 'Select an aircraft to see which types are most similar to it.',
  'detail.close': 'Close',
  'detail.manufacturer': 'Manufacturer',
  'detail.noManufacturer': 'None',
  'detail.span': 'Wing span',
  'detail.length': 'Length',
  'detail.mtow': 'Maximum take-off weight',
  'detail.cruise': 'Cruise speed',
  'detail.engines': 'Engines',
  'detail.engineType': 'Engine type',
  'detail.wing': 'Wing',
  'detail.gear': 'Landing gear',
  'detail.aliases': 'Also used as type tag:',
  'detail.titleHints': 'Recognised in titles:',
  'detail.similar': 'Most similar aircraft',
  'detail.none': 'No similar aircraft found.',
  'detail.why': 'Why is it similar?',
  'detail.installed': 'Installed',
  'detail.notInstalled': 'Not installed',
  'detail.parametersFrom': 'Parameters from: {line}',
  'detail.airlineMatch': 'Matches the airline of the callsign',
  'detail.livery': 'Livery',
  'detail.liveriesAndWhy': 'Liveries and similarity details',
  'detail.liveries': 'Installed liveries: {n}',
  'detail.rank': 'Preferred position: {n}',
  'detail.proximity': 'Proximity: {n}%',
  'detail.points': 'Points: {n}',
  'detail.bonusManufacturer': 'Same manufacturer and similar size',
  'detail.bonusRelated': 'Related type (visually similar)',
  'feature.mtow': 'Weight',
  'feature.span': 'Wing span',
  'feature.length': 'Length',
  'feature.cruise': 'Cruise speed',
  'feature.engineCount': 'Engine count',
  'feature.engineType': 'Engine type',
  'feature.wing': 'Wing position',
  'feature.gear': 'Landing gear',
  'unit.m': '{n} m',
  'unit.kg': '{n} kg',
  'unit.kt': '{n} kt',
  'enum.engineType.jet': 'Jet',
  'enum.engineType.piston': 'Piston',
  'enum.engineType.turboprop': 'Turboprop',
  'enum.engineType.turboshaft': 'Turboshaft',
  'enum.engineType.electric': 'Electric',
  'enum.engineType.none': 'None',
  'enum.wing.low': 'Low wing',
  'enum.wing.mid': 'Mid wing',
  'enum.wing.high': 'High wing',
  'enum.wing.rotor': 'Rotor',
  'enum.wing.biplane': 'Biplane',
  'enum.gear.tricycle': 'Tricycle',
  'enum.gear.taildragger': 'Taildragger',
  'enum.gear.skids': 'Skids',
  'enum.gear.floats': 'Floats',
};

/** Language selection: lang attribute, else navigator.languages, else en. Regional tags reduce to the primary subtag. */
export function pickLanguage(attr) {
  const candidates = [attr, ...(navigator.languages?.length ? navigator.languages : [navigator.language])];
  for (const c of candidates) {
    if (!c) continue;
    const primary = String(c).toLowerCase().split(/[-_]/)[0];
    if (primary === 'en') return 'en';
    if (LOCALES.includes(primary)) return primary; // an unsupported language falls through to the next candidate
  }
  return 'en';
}

const cache = new Map(); // locale -> Promise<dict>

/** Fetches <component>-<locale>.json relative to the script, once per language. Falls back to {} (English) with a warning. */
export function loadLocale(lang) {
  if (lang === 'en') return Promise.resolve({});
  if (!cache.has(lang)) {
    const url = new URL(`${COMPONENT}-${lang}.json`, SCRIPT_URL).href;
    cache.set(lang, fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .catch(err => {
        console.warn(`[${COMPONENT}] Could not load language file ${url}: ${err.message ?? err}. Continuing in English.`);
        return {};
      }));
  }
  return cache.get(lang);
}

export function makeTranslator(dict) {
  const t = (key, params) => {
    const text = dict[key] ?? EN[key] ?? key;
    return params ? text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m)) : text;
  };
  // Raw enum-like values fall back to the value itself.
  t.enum = (group, value) => {
    const key = `enum.${group}.${value}`;
    return dict[key] ?? EN[key] ?? String(value);
  };
  return t;
}
