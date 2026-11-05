// A port of JoinFS' model-level matcher (JoinFS/Matching: CombinedMatcher, IdentityScorer + Substitution.ScoreCandidate, SpecResolver, ReferenceSpecs,
// SimilarityScorer, AirlineResolver, TypeRole, ManufacturerKey), in the same order and with the same constants, so the map shows the installed model JoinFS
// would inject. Pure functions, no DOM. Parity with JoinFS is pinned by test/fixtures/MatchScenarios.json (written by JoinFS.Tests/MatchScenarioExportTests).
import { titleTokens, sharedTitleWords, titleBonus } from './models.js';
import { nearIdenticalBonus, NEAR_FROM } from './proximity.js';

// ---- roles ---------------------------------------------------------------------------------------------------------------------------------------
export const ROLE = { SingleProp: 1, TwinProp: 2, Airliner: 3, Rotorcraft: 4, Glider: 5, Fighter: 6, Bomber: 7, FourProp: 8, Airship: 9, Balloon: 10 };

/** Substitution.TyperoleFromString: the text of a models list ("Airliner", "SingleProp" ...); anything it does not know is SingleProp, as in JoinFS. */
export function typeroleFromString(text) {
  const t = String(text ?? '');
  const has = s => t.includes(s);
  if (has('Single') && has('Prop')) return ROLE.SingleProp;
  if (has('Twin') && has('Prop')) return ROLE.TwinProp;
  if (has('Four') && has('Prop')) return ROLE.FourProp;
  if (has('Regional') || has('Airliner')) return ROLE.Airliner;
  if (has('Rotorcraft')) return ROLE.Rotorcraft;
  if (has('Glider')) return ROLE.Glider;
  if (has('Balloon') || has('Zeppelin')) return ROLE.Balloon;
  if (has('Airship') || has('Blimp')) return ROLE.Airship;
  if (has('Fighter') || has('Jet')) return ROLE.Fighter;
  if (has('Bomber') || has('Four Engine')) return ROLE.Bomber;
  return ROLE.SingleProp;
}

/** TypeRole.FromIcao / Substitution.TyperoleFromIcao: a role from the designator and its Doc8643 class code; 0 when none can be made. */
export function typeroleFromIcao(icaoType, classCode, wtc) {
  switch (icaoType) {
    case 'SHIP': return ROLE.Airship;
    case 'BALL': return ROLE.Balloon;
    case 'GLID': case 'GLIM': return ROLE.Glider;
    case 'GYRO': case 'UHEL': return ROLE.Rotorcraft;
    case 'ULAC': return ROLE.SingleProp;
    default: break;
  }
  if (classCode.length !== 3) return 0;
  const platform = classCode[0], engineType = classCode[2];
  if (platform === 'H' || platform === 'G') return ROLE.Rotorcraft;
  if (['L1P', 'S1P', 'A1P'].includes(classCode)) return ROLE.SingleProp;
  if (['L2P', 'S2P', 'A2P'].includes(classCode)) return ROLE.TwinProp;
  if (classCode === 'L4P' || classCode === 'L4T') return ROLE.FourProp;
  if (platform === 'L' && engineType === 'J' && ['M', 'H', 'J'].includes(wtc)) return ROLE.Airliner;
  return 0;
}

/** TypeRole.FromClassCode: FromIcao, and for three prop engines TwinProp, five or more FourProp. */
export function typeroleFromClassCode(icaoType, classCode, wtc) {
  const role = typeroleFromIcao(icaoType, classCode, wtc);
  if (role !== 0 || classCode.length !== 3) return role;
  if (['L', 'S', 'A'].includes(classCode[0]) && ['P', 'T'].includes(classCode[2]) && /^\d$/.test(classCode[1])) {
    const engines = Number(classCode[1]);
    return engines >= 5 ? ROLE.FourProp : engines === 3 ? ROLE.TwinProp : 0;
  }
  return 0;
}

// ---- text helpers --------------------------------------------------------------------------------------------------------------------------------
const isLetterOrDigit = ch => /[\p{L}\p{N}]/u.test(ch);
export const alnumOnly = s => String(s ?? '').replace(/[^\p{L}\p{N}]/gu, '');
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Substitution.ContainsToken: needle as a standalone token (not adjacent to a letter or digit), case-insensitive. */
export function containsToken(haystack, needle) {
  const h = String(haystack ?? '').toLowerCase(), n = String(needle ?? '').toLowerCase();
  if (!n) return false;
  let from = 0;
  for (;;) {
    const idx = h.indexOf(n, from);
    if (idx < 0) return false;
    const leftOk = idx === 0 || !isLetterOrDigit(h[idx - 1]);
    const right = idx + n.length;
    const rightOk = right >= h.length || !isLetterOrDigit(h[right]);
    if (leftOk && rightOk) return true;
    from = idx + 1;
  }
}

/** Math.Round (to even on .5), like the C# the points come from. */
function roundEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ---- ManufacturerKey -----------------------------------------------------------------------------------------------------------------------------
const NOISE = new Set(['HELICOPTER', 'HELICOPTERS', 'AIRCRAFT', 'AIRPLANE', 'AIRPLANES', 'AIRCRAFTS', 'CORP', 'CORPORATION', 'COMPANY', 'CO', 'INC', 'LTD', 'LLC',
  'INDUSTRIES', 'INDUSTRIE', 'AVIATION', 'AEROSPACE', 'AEROSPATIALE', 'THE', 'GMBH', 'SA', 'SPA', 'AG']);
const SYNONYMS = { EUROCOPTER: 'AIRBUS', BEECHCRAFT: 'BEECH', HAWKER: 'BEECH' };

export function manufacturerKey(manufacturer) {
  const text = String(manufacturer ?? '');
  if (text.trim() === '' || text.trim() === '(ANY)') return '';
  const words = text.split(/[ \-/,.()]+/).filter(Boolean).map(w => w.toUpperCase()).filter(w => !NOISE.has(w));
  if (!words.length) return '';
  const key = words[0] === 'MCDONNELL' && words.length > 1 ? words[0] + words[1] : words[0];
  return SYNONYMS[key] ?? key;
}

// ---- Doc8643 (compact JSON: designator -> [classCode, wake, majority manufacturer, collapsed]) -----------------------------------------------
export function makeDoc8643(table) {
  const byIcao = new Map(Object.entries(table).map(([k, v]) => [k.toUpperCase(), { classCode: v[0], wtc: v[1], maker: v[2], collapsed: !!v[3] }]));
  return {
    get: icao => (icao ? byIcao.get(String(icao).toUpperCase()) ?? null : null),
    isRecognized: icao => !!icao && byIcao.has(String(icao).toUpperCase()),
    isCollapsed: icao => !!icao && !!byIcao.get(String(icao).toUpperCase())?.collapsed,
    majorityManufacturer: icao => byIcao.get(String(icao ?? '').toUpperCase())?.maker ?? '',
  };
}

// ---- airlines (ICAO_Airlines.dat as [icao, iata, name] rows) + AirlineResolver --------------------------------------------------------------------
const AIRLINE_NOISE = new Set(['air', 'airline', 'airlines', 'airways', 'airway', 'aviation', 'express', 'international', 'intl', 'cargo', 'lines', 'line', 'ltd', 'limited',
  'inc', 'co', 'corp', 'company', 'the', 'of', 'and', 'services', 'service', 'group', 'transport']);
const AIRLINE_SEPARATORS = /[ \-_.,/&'()|]+/;

export function makeAirlines(rows) {
  const namesByIcao = new Map();
  const names = [];
  const byIata = new Map(), byName = new Map();
  const normalize = (text, dropNoise) => {
    let words = String(text).split(AIRLINE_SEPARATORS).filter(Boolean);
    if (dropNoise) { const kept = words.filter(w => !AIRLINE_NOISE.has(w.toLowerCase())); if (kept.length) words = kept; }
    return words.map(alnumOnly).join('').toLowerCase();
  };
  const addTo = (map, key, icao) => { if (!key) return; if (!map.has(key)) map.set(key, new Set()); map.get(key).add(icao); };
  for (const [icao, iata, name] of rows) {
    if (!namesByIcao.has(icao)) namesByIcao.set(icao, name);
    names.push([icao, name]);
    addTo(byIata, String(iata).toUpperCase(), icao);
    addTo(byName, normalize(name, false), icao);
    const core = normalize(name, true);
    if (core.length >= 4) addTo(byName, core, icao);
  }
  const single = (map, key) => (key && map.has(key) && map.get(key).size === 1 ? [...map.get(key)][0] : '');
  const isKnownCode = v => v.length === 3 && namesByIcao.has(v.toUpperCase());
  const singleInFullText = value => {
    const needle = value.trim();
    if (needle.length < 4) return '';
    const hits = new Set();
    for (const [icao, name] of names) { if (containsToken(name, needle)) hits.add(icao); if (hits.size > 1) return ''; }
    return hits.size === 1 ? [...hits][0] : '';
  };
  const findNameInText = texts => {
    let best = '', bestLength = 0;
    for (const text of texts) {
      if (!text || !String(text).trim()) continue;
      const words = String(text).split(AIRLINE_SEPARATORS).filter(Boolean);
      for (let start = 0; start < words.length; start++) {
        let joined = '';
        for (let len = 1; len <= 3 && start + len <= words.length; len++) {
          joined += alnumOnly(words[start + len - 1]).toLowerCase();
          if (joined.length < 4 || joined.length <= bestLength || AIRLINE_NOISE.has(joined)) continue;
          const code = single(byName, joined);
          if (!code) continue;
          best = code; bestLength = joined.length;
        }
      }
    }
    return best;
  };
  return {
    isKnownCode,
    /** AirlineResolver.Resolve: { icao, changed, guessed } */
    resolve(icaoAirline, atcAirline, ...freeText) {
      icaoAirline = String(icaoAirline ?? '').trim();
      atcAirline = String(atcAirline ?? '').trim();
      if (isKnownCode(icaoAirline)) return { icao: icaoAirline.toUpperCase(), changed: false, guessed: false };
      for (const value of [icaoAirline, atcAirline]) {
        if (!value) continue;
        if (isKnownCode(value)) return { icao: value.toUpperCase(), changed: true, guessed: false };
        const viaIata = single(byIata, value.toUpperCase());
        if (viaIata) return { icao: viaIata, changed: true, guessed: false };
        let viaName = single(byName, normalize(value, true));
        if (!viaName) viaName = single(byName, normalize(value, false));
        if (viaName) return { icao: viaName, changed: true, guessed: false };
        const viaText = singleInFullText(value);
        if (viaText) return { icao: viaText, changed: true, guessed: true };
      }
      const fromText = findNameInText(freeText);
      if (fromText) return { icao: fromText, changed: true, guessed: true };
      return { icao: icaoAirline, changed: false, guessed: false };
    },
  };
}

// ---- reference data (aircraft-specs.json) ----------------------------------------------------------------------------------------------------------
const WINGS = new Set(['high', 'mid', 'low', 'biplane', 'rotor']);
const ENGINES = new Set(['piston', 'turboprop', 'jet', 'turboshaft', 'electric', 'none']);
const GEARS = new Set(['tricycle', 'taildragger', 'skids', 'floats', 'skis']);
const num = v => (typeof v === 'number' ? v : null);
const lower = v => String(v ?? '').toLowerCase();

function specsOfRow(r) {
  return {
    name: r.name ?? '', rotor: r.rotor === true,
    wing: WINGS.has(lower(r.wing)) ? lower(r.wing) : '', spanM: num(r.spanM), lengthM: num(r.lengthM), mtowKg: num(r.mtowKg),
    engineCount: num(r.engines), engine: ENGINES.has(lower(r.engineType)) ? lower(r.engineType) : '', cruiseKt: num(r.cruiseKt),
    gear: GEARS.has(lower(r.gear)) ? lower(r.gear) : '', manufacturer: '',
  };
}
const cloneSpecs = s => ({ ...s });

const MAX_MTOW_RATIO_SIMILAR_KIND = 4.0;

export function makeReference(rows) {
  const entries = rows.map(r => ({
    icao: r.icao ?? '', nonIcao: r.nonIcao === true, name: r.name ?? '', manufacturer: r.manufacturer ?? '',
    aliases: r.aliases ?? [], titleHints: r.titleHints ?? [], specs: specsOfRow(r),
  }));
  const byIcao = new Map(), byAlias = new Map(), rowsByIcao = new Map();
  for (const e of entries) {
    const k = e.icao.toUpperCase();
    if (!byIcao.has(k)) byIcao.set(k, e);
    if (!rowsByIcao.has(k)) rowsByIcao.set(k, []);
    rowsByIcao.get(k).push(e);
    for (const a of e.aliases) if (!byAlias.has(a.toUpperCase())) byAlias.set(a.toUpperCase(), e);
  }

  const resolveAlias = code => {
    if (!code) return code ?? '';
    const k = code.toUpperCase();
    if (byAlias.has(k)) return byAlias.get(k).icao;
    if (byIcao.has(k)) return code;
    const compact = alnumOnly(code);
    if (compact && compact !== code) {
      const c = compact.toUpperCase();
      if (byIcao.has(c)) return byIcao.get(c).icao;
      if (byAlias.has(c)) return byAlias.get(c).icao;
    }
    return code;
  };
  const hintsOf = e => [...(e.icao.length >= 3 ? [e.icao] : []), ...(e.name ? [e.name] : []), ...e.titleHints, ...e.aliases.filter(a => a.length >= 4)];
  const bestMatch = (candidates, text, designatorIsAHint = false) => {
    let best = null, bestHint = '';
    if (!String(text ?? '').trim()) return { entry: null, hint: '' };
    for (const e of candidates) {
      for (const hint of hintsOf(e)) {
        if (hint.length > bestHint.length && (designatorIsAHint || hint.toLowerCase() !== e.icao.toLowerCase()) && containsToken(text, hint)) { best = e; bestHint = hint; }
      }
    }
    return { entry: best, hint: bestHint };
  };
  const isSimilarKind = (candidate, defaultRow) => {
    const a = candidate.specs, b = defaultRow.specs;
    if (candidate.icao.toLowerCase() === defaultRow.icao.toLowerCase()) return false;
    if (a.rotor !== b.rotor) return false;
    if (a.engine && b.engine && a.engine !== b.engine) return false;
    if (a.mtowKg !== null && b.mtowKg !== null) return Math.max(a.mtowKg, b.mtowKg) / Math.min(a.mtowKg, b.mtowKg) <= MAX_MTOW_RATIO_SIMILAR_KIND;
    return false;
  };
  const rowCount = code => (code ? rowsByIcao.get(resolveAlias(code).toUpperCase())?.length ?? 0 : 0);
  const findRowMatch = (code, text) => {
    if (!code) return null;
    const icao = resolveAlias(code).toUpperCase();
    const first = byIcao.get(icao);
    if (!first) return null;
    const rowsOf = rowsByIcao.get(icao);
    if (rowsOf.length < 2) return { entry: first, hint: bestMatch([first], text, true).hint };
    const own = bestMatch(rowsOf, text);
    const specific = bestMatch(entries.filter(e => isSimilarKind(e, rowsOf[0])), text, true);
    if (specific.entry && specific.hint.length >= own.hint.length) return { entry: specific.entry, hint: specific.hint };
    return own.entry ? { entry: own.entry, hint: own.hint } : { entry: first, hint: '' };
  };
  return {
    resolveAlias,
    rowCount,
    findRowMatch,
    findForText: (code, text) => { const m = findRowMatch(code, text); return m ? cloneSpecs(m.entry.specs) : null; },
    manufacturerOf: code => (code ? byIcao.get(resolveAlias(code).toUpperCase())?.manufacturer ?? '' : ''),
    inferIcaoFromText(text) {
      if (!String(text ?? '').trim()) return null;
      let best = null, bestLength = 0;
      for (const e of entries) for (const hint of hintsOf(e)) if (hint.length > bestLength && containsToken(text, hint)) { best = e.icao; bestLength = hint.length; }
      return best;
    },
    isStandInFor(folded, candidateIcao) {
      if (!folded || !candidateIcao) return false;
      const rowsOf = rowsByIcao.get(resolveAlias(folded).toUpperCase());
      const candidate = byIcao.get(String(candidateIcao).toUpperCase());
      return !!rowsOf && rowsOf.length > 1 && !!candidate && isSimilarKind(candidate, rowsOf[0]);
    },
    isMemberOfRow(candidateIcao, rowName, folded) {
      if (!candidateIcao || !rowName || !folded) return false;
      const candidate = byIcao.get(String(candidateIcao).toUpperCase());
      const rowsOf = rowsByIcao.get(resolveAlias(folded).toUpperCase());
      if (!candidate || !rowsOf) return false;
      const row = rowsOf.find(r => r.name === rowName);
      if (!row || row === candidate) return false;
      const mine = new Set(candidate.titleHints.map(h => h.toLowerCase()));
      return row.titleHints.some(h => mine.has(h.toLowerCase()));
    },
  };
}

// ---- SimilarityScorer --------------------------------------------------------------------------------------------------------------------------
const W = { mtow: 3.0, span: 2.0, length: 1.5, cruise: 2.0, engineCount: 2.0, engineType: 2.0, wing: 1.0, gear: 1.5 };
const GATE_MTOW_RATIO = 8.0;
const engineDistance = (a, b) => {
  if (a === b) return 0;
  const pair = (x, y) => (a === x && b === y) || (a === y && b === x);
  return pair('piston', 'turboprop') ? 0.5 : pair('turboprop', 'turboshaft') ? 0.4 : pair('turboprop', 'jet') ? 0.6 : pair('piston', 'turboshaft') ? 0.7
    : pair('piston', 'electric') ? 0.4 : pair('jet', 'turboshaft') ? 0.9 : 1.0;
};
const wingDistance = (a, b) => (a === b ? 0 : a === 'rotor' || b === 'rotor' || a === 'biplane' || b === 'biplane' ? 1.0 : a === 'mid' || b === 'mid' ? 0.5 : 1.0);
const gearDistance = (a, b) => {
  if (a === b) return 0;
  const wheels = new Set(['tricycle', 'taildragger']);
  if (wheels.has(a) && wheels.has(b)) return 0.6;
  if ((a === 'floats' && wheels.has(b)) || (b === 'floats' && wheels.has(a))) return 0.8;
  return 1.0;
};

/** SimilarityScorer.Compare on two spec sets: { gated, score, confidence }. */
export function compareSpecs(remote, candidate) {
  const result = { gated: false, score: 0, confidence: 0 };
  if (remote.rotor !== null && candidate.rotor !== null && remote.rotor !== candidate.rotor) { result.gated = true; return finish(result, []); }
  if (remote.mtowKg !== null && candidate.mtowKg !== null && Math.max(remote.mtowKg, candidate.mtowKg) / Math.min(remote.mtowKg, candidate.mtowKg) > GATE_MTOW_RATIO) result.gated = true;
  const features = [];
  const log = (feature, a, b, weight, scale) => { if (a === null || b === null || !(a > 0) || !(b > 0)) return; features.push({ feature, weight, distance: Math.min(1, Math.abs(Math.log(a / b)) / scale) }); };
  log('Mtow', remote.mtowKg, candidate.mtowKg, W.mtow, Math.log(4));
  log('Span', remote.spanM, candidate.spanM, W.span, Math.log(2));
  log('Length', remote.lengthM, candidate.lengthM, W.length, Math.log(2));
  log('Cruise', remote.cruiseKt, candidate.cruiseKt, W.cruise, Math.log(2));
  if (remote.engineCount !== null && candidate.engineCount !== null) {
    const d = Math.abs(remote.engineCount - candidate.engineCount);
    features.push({ feature: 'Engines', weight: W.engineCount, distance: d === 0 ? 0 : d === 1 ? 0.6 : 1.0 });
  }
  if (remote.engine && candidate.engine) features.push({ feature: 'EngineType', weight: W.engineType, distance: engineDistance(remote.engine, candidate.engine) });
  if (remote.wing && candidate.wing) features.push({ feature: 'Wing', weight: W.wing, distance: wingDistance(remote.wing, candidate.wing) });
  if (remote.gear && candidate.gear) features.push({ feature: 'Gear', weight: W.gear, distance: gearDistance(remote.gear, candidate.gear) });
  return finish(result, features);
}

function finish(result, features) {
  const totalWeight = features.reduce((s, f) => s + f.weight, 0);
  const allWeights = W.mtow + W.span + W.length + W.cruise + W.engineCount + W.engineType + W.wing + W.gear;
  if (totalWeight <= 0) { result.score = 0; result.confidence = 0; return result; }
  result.score = features.reduce((s, f) => s + f.weight * (1 - f.distance) / totalWeight, 0);
  const sizeKnown = features.some(f => ['Mtow', 'Span', 'Length'].includes(f.feature));
  const reference = sizeKnown ? allWeights : W.engineCount + W.engineType + W.gear;
  result.confidence = Math.min(1.0, totalWeight / reference);
  return result;
}

/** CombinedMatcher.SameManufacturerRule */
function sameManufacturerBonus(remote, candidate) {
  if (!remote.manufacturer || remote.manufacturer !== candidate.manufacturer) return 0;
  if (remote.rotor === null || candidate.rotor === null || remote.rotor !== candidate.rotor) return 0;
  const ratio = (a, b) => Math.max(a, b) / Math.min(a, b);
  if (remote.mtowKg !== null && candidate.mtowKg !== null) return ratio(remote.mtowKg, candidate.mtowKg) <= 2.5 ? 40 : 0;
  if (remote.spanM !== null && candidate.spanM !== null) return ratio(remote.spanM, candidate.spanM) <= 1.6 ? 40 : 0;
  return 0;
}

// ---- the matcher -----------------------------------------------------------------------------------------------------------------------------------
const MIN_MATCH_SCORE = 20, MIN_SIMILARITY = 0.5, SIMILARITY_POINTS_MAX = 100, OTHER_KIND_POINTS = 120, SAME_HINT_POINTS = 250, TITLE_INFERRED_FACTOR = 0.75;
const LIGHT_WAKE = 'L', AIRLINER_MIN_MTOW_KG = 7000; // the mass is used only when the Doc8643 wake category is unknown
const NOT_AIRLINER_ROLES = new Set([ROLE.Glider, ROLE.Balloon, ROLE.Airship]);
const CALLSIGN_WITH_AIRLINE = /^([A-Z]{3})\d{1,4}[A-Z]{0,2}$/; // UAE123, DLH4AB - a registration (N748UA, D-EABC) is not one

/**
 * @param {{reference, doc8643, airlines}} data  makeReference / makeDoc8643 / makeAirlines results
 * @returns {{ prepareModels(parsed): object[], match(prepared, request): {model, type, total, ranking}|null }}
 */
export function createMatcher({ reference, doc8643, airlines }) {
  // what a model's specs are depends only on its type, class code, role and (for untagged / folded types) title: resolved once per kind, like JoinFS' ModelSpecCache
  const specsOf = new Map();
  /** Substitution.Model after JoinFS loaded it from a models list: the class code, wake and typerole re-derived from the Doc8643 designator. */
  function prepareModel(m) {
    const model = {
      title: m.title, manufacturer: m.manufacturer ?? '', type: m.type ?? '', variation: m.livery ?? m.variation ?? '', icaoType: m.icaoType ?? m.tag ?? '',
      wtc: m.wtc ?? '', icaoAirline: m.airline ?? '', classCode: m.classConfirmed ?? m.confirmed ? (m.classCode ?? '') : '', classCodeConfirmed: !!(m.classConfirmed ?? m.confirmed),
      typerole: typeroleFromString(m.role ?? ''), source: m,
    };
    if (!model.classCodeConfirmed) {
      model.classCode = '';
      const row = doc8643.get(model.icaoType);
      if (model.icaoType && row) { model.classCode = row.classCode; if (!model.wtc) model.wtc = row.wtc; }
    }
    if (model.typerole !== ROLE.Fighter && model.typerole !== ROLE.Bomber) {
      const derived = typeroleFromIcao(model.icaoType, model.classCode, model.wtc);
      if (derived > 0) model.typerole = derived;
    }
    return model;
  }

  const classCodeOf = icao => doc8643.get(icao)?.classCode ?? '';

  function coarse(classCode, typerole) {
    const specs = { name: '', rotor: null, wing: '', spanM: null, lengthM: null, mtowKg: null, engineCount: null, engine: '', cruiseKt: null, gear: '', manufacturer: '' };
    let rotor = typerole === ROLE.Rotorcraft;
    if (typerole === ROLE.Glider && classCode.length !== 3) { specs.engine = 'none'; specs.engineCount = 0; specs.rotor = false; return specs; }
    if (classCode.length === 3) {
      rotor = rotor || classCode[0] === 'H' || classCode[0] === 'G';
      const engines = Number.parseInt(classCode[1], 10);
      if (Number.isInteger(engines) && engines > 0) specs.engineCount = engines;
      const kind = { P: 'piston', T: rotor ? 'turboshaft' : 'turboprop', J: 'jet', E: 'electric' }[classCode[2]];
      if (kind) specs.engine = kind;
    }
    if (rotor) specs.rotor = true;
    return specs;
  }

  function fillManufacturer(specs, icaoType) {
    let key = manufacturerKey(reference.manufacturerOf(icaoType));
    if (!key) key = manufacturerKey(doc8643.majorityManufacturer(icaoType));
    if (key) specs.manufacturer = key;
  }

  /** SpecResolver.ForRemote / ForModel: reference data of the type (the title picks the row), else inferred from the title, else coarse from the class code. */
  function resolveSpecs({ tag, title, text, classCode, typerole, classOfTag }) {
    const resolved = { specs: null, effectiveIcao: '', matchedHint: '' };
    const icao = reference.resolveAlias(tag);
    let match = reference.findRowMatch(icao, text);
    if (match) {
      resolved.specs = cloneSpecs(match.entry.specs); resolved.effectiveIcao = match.entry.icao; resolved.matchedHint = match.hint;
    } else {
      const inferred = reference.inferIcaoFromText(title);
      const row = inferred ? reference.findRowMatch(inferred, text) : null;
      if (row) { resolved.specs = cloneSpecs(row.entry.specs); resolved.matchedHint = row.hint; resolved.effectiveIcao = inferred; }
    }
    if (!resolved.specs) resolved.specs = coarse(classCode.length === 3 ? classCode : classOfTag(tag), typerole);
    fillManufacturer(resolved.specs, resolved.effectiveIcao || tag);
    return resolved;
  }

  const forRemote = request => resolveSpecs({ tag: request.icaoType, title: request.title, text: `${request.title} ${request.livery}`, classCode: request.classCode, typerole: request.typerole, classOfTag: classCodeOf });
  const forModel = model => resolveSpecs({ tag: model.icaoType, title: `${model.title} ${model.variation}`, text: `${model.title} ${model.variation}`, classCode: model.classCode, typerole: model.typerole, classOfTag: () => '' });

  /** Substitution.ScoreCandidate with typeroleIsWeakHint. Returns { score, attrs: {IcaoType, ...}, contributions[] } */
  function scoreCandidate(model, request, remoteClass, remoteWtc) {
    let total = 0;
    const attrs = {};
    const details = [];
    const add = (attr, points, detail) => {
      const applied = roundEven(points);
      if (applied === 0) return;
      total += applied;
      attrs[attr] = (attrs[attr] ?? 0) + applied;
      details.push(`${detail} (${applied > 0 ? '+' : ''}${applied})`);
    };
    const gf = 1.0; // a loaded model's type is never guessed
    const airlineGuessFactor = request.icaoAirlineGuessed ? 0.2 : 1.0;
    const exact = request.icaoType.length > 0 && model.icaoType.length > 0 && model.icaoType.toLowerCase() === request.icaoType.toLowerCase();
    if (exact) add('IcaoType', 200 * gf, `ICAO type '${request.icaoType}'`);
    if (request.icaoAirline.length > 0 && model.icaoAirline.length > 0 && model.icaoAirline.toLowerCase() === request.icaoAirline.toLowerCase()) add('IcaoAirline', 100 * airlineGuessFactor, `ICAO airline '${request.icaoAirline}'`);
    if (remoteClass.length === 3 && model.classCode.length === 3 && model.classCode === remoteClass) {
      add('ClassCode', 60 * gf, `class code '${remoteClass}'`);
      if (model.classCode[1] === remoteClass[1]) add('ClassCode', 20, 'engine count');
      if (model.classCode[2] === remoteClass[2]) add('ClassCode', 20, 'engine type');
    }
    if (remoteWtc.length > 0 && model.wtc.length > 0 && model.wtc === remoteWtc) add('Wtc', 40 * gf, `WTC '${remoteWtc}'`);
    if (request.typerole > 0 && model.typerole > 0 && model.typerole === request.typerole) add('Typerole', 15, 'same typerole');
    if (request.livery.length > 0) {
      for (const word of request.livery.split(/[ \-_]+/).filter(Boolean)) {
        if (word.length < 4) continue;
        if (model.variation.toLowerCase().includes(word.toLowerCase())) { add('Livery', 1, `livery word '${word}'`); break; }
      }
    }
    const maxLen = Math.min(request.title.length, model.title.length);
    let prefix = 0;
    while (prefix < maxLen && request.title[prefix].toLowerCase() === model.title[prefix].toLowerCase()) prefix++;
    if (prefix >= 4) add('Title', Math.min(prefix, 25), `title prefix (${prefix} chars)`);
    return { score: total, attrs, contributions: details };
  }

  function resolveRemoteClass(request) {
    let classCode = request.classCode, wtc = request.wtc;
    if (classCode.length === 0 && request.icaoType.length > 0) {
      const row = doc8643.get(request.icaoType);
      if (row) { classCode = row.classCode; wtc = row.wtc; }
    }
    return [classCode, wtc];
  }

  function correctedRequest(original) {
    let request = { ...original };
    // a type tag with a curated alias ("500E" -> "H500") is replaced, unless it is an official designator
    if (request.icaoType && !doc8643.isRecognized(request.icaoType)) {
      const resolved = reference.resolveAlias(request.icaoType);
      if (resolved !== request.icaoType) request = { ...request, icaoType: resolved };
    }
    const airline = airlines.resolve(request.icaoAirline, request.atcAirline, request.title, request.livery);
    if (airline.changed && airline.icao.toLowerCase() !== request.icaoAirline.toLowerCase()) request = { ...request, icaoAirline: airline.icao, icaoAirlineGuessed: airline.guessed || request.icaoAirlineGuessed };
    const [classCode, wtc] = resolveRemoteClass(request);
    const derived = typeroleFromClassCode(request.icaoType, classCode, wtc);
    if (derived !== 0 && derived !== request.typerole) request = { ...request, typerole: derived };
    return request;
  }

  /** the request as the map sends it: missing fields are empty */
  const normalize = r => ({
    title: r.title ?? '', livery: r.livery ?? '', callsign: r.callsign ?? '', icaoType: r.icaoType ?? '', icaoAirline: r.icaoAirline ?? '', atcAirline: r.atcAirline ?? '',
    classCode: r.classCode ?? '', wtc: r.wtc ?? '', typerole: r.typerole ?? ROLE.SingleProp, icaoAirlineGuessed: !!r.icaoAirlineGuessed,
  });

  /** The airline of the request when it is certain: a known ICAO code that was given (not guessed from the title), or a callsign like UAE123. */
  function verifiedAirlineOf(request) {
    const given = request.icaoAirline.toUpperCase();
    if (!request.icaoAirlineGuessed && airlines.isKnownCode(given)) return given;
    const fromCallsign = CALLSIGN_WITH_AIRLINE.exec(request.callsign.trim().toUpperCase());
    return fromCallsign && airlines.isKnownCode(fromCallsign[1]) ? fromCallsign[1] : '';
  }

  /** Not GA, rotorcraft, balloon, glider or motor glider: a fixed-wing type outside the light wake category (jets, turboprops and piston airliners alike). */
  function isAirlinerKind(icaoType, wtc, specs, typerole) {
    if (doc8643.isCollapsed(icaoType) || specs.rotor === true || NOT_AIRLINER_ROLES.has(typerole)) return false;
    const wake = wtc || doc8643.get(icaoType)?.wtc || '';
    return wake ? wake !== LIGHT_WAKE : (specs.mtowKg ?? 0) >= AIRLINER_MIN_MTOW_KG;
  }

  function match(models, requestIn) {
    const original = normalize(requestIn);
    // the exact title (and livery) of an installed model is never second-guessed
    if (original.title) {
      const exactModel = models.find(m => m.title === original.title && m.variation === original.livery);
      if (exactModel) return { model: exactModel, type: 'Original', total: null, ranking: [] };
    }
    const request = correctedRequest(original);
    const remote = forRemote(request);
    const [remoteClass, remoteWtc] = resolveRemoteClass(request);
    const folded = doc8643.isCollapsed(request.icaoType) && reference.rowCount(request.icaoType) > 1;
    const remoteType = folded && remote.specs.name.length > 0 && remote.effectiveIcao.length > 0 ? remote.effectiveIcao : request.icaoType;
    const remoteTokens = folded ? titleTokens(request.title) : null;
    const cacheKey = m => `${m.icaoType}\u0001${m.classCode}\u0001${m.typerole}\u0001${m.icaoType.length === 0 || reference.rowCount(m.icaoType) > 1 ? `${m.title} ${m.variation}` : ''}`;
    const ranked = [];
    const airlinerRequest = isAirlinerKind(request.icaoType, remoteWtc, remote.specs, request.typerole);
    const verifiedAirline = airlinerRequest ? verifiedAirlineOf(request) : '';

    for (const model of models) {
      const key = cacheKey(model);
      let candidate = specsOf.get(key);
      if (!candidate) { candidate = forModel(model); specsOf.set(key, candidate); }
      const similarity = compareSpecs(remote.specs, candidate.specs);
      if (similarity.gated) continue;
      const familyBonus = sameManufacturerBonus(remote.specs, candidate.specs);
      const similarityPoints = roundEven(SIMILARITY_POINTS_MAX * similarity.score * similarity.confidence);
      const nearPoints = nearIdenticalBonus(similarity);

      const identity = scoreCandidate(model, request, remoteClass, remoteWtc);
      titleInferredIdentity(identity, model, candidate, remoteType, folded, remoteClass, remoteWtc);
      if (remoteTokens) {
        const bonus = titleBonus(request.title, model.title);
        if (bonus > 0) { identity.score += bonus; identity.contributions.push(`shared title words with the remote aircraft (+${bonus})`); }
      }
      const genericFallback = folded && foldedIdentity(identity, model, candidate, remoteType, request, remote);
      const liveryFirst = verifiedAirline.length > 0 && model.icaoAirline.toUpperCase() === verifiedAirline && similarity.confidence > 0 && similarity.score >= NEAR_FROM
        && isAirlinerKind(model.icaoType, model.wtc, candidate.specs, model.typerole);
      if (nearPoints > 0) identity.contributions.push(`near identical to the remote aircraft (+${nearPoints})`);
      if (liveryFirst) identity.contributions.push(`airliner of the requested airline '${verifiedAirline}', at least ${Math.round(NEAR_FROM * 100)} % alike: the livery comes before the exact type`);
      ranked.push({ model, total: identity.score + similarityPoints + nearPoints + familyBonus, baseline: identity.score, attrs: identity.attrs, contributions: identity.contributions,
        similarity, similarityPoints, nearPoints, liveryFirst, familyBonus, genericFallback, effectiveIcao: candidate.effectiveIcao });
    }
    ranked.sort((a, b) => (Number(b.liveryFirst) - Number(a.liveryFirst)) || (b.total - a.total) || (b.similarity.score - a.similarity.score) || ordinal(a.model.title, b.model.title) || ordinal(a.model.variation, b.model.variation));

    const acceptable = c => c.total >= MIN_MATCH_SCORE && (c.similarity.confidence <= 0 || c.similarity.score >= MIN_SIMILARITY || c.attrs.IcaoType !== undefined);
    const winner = ranked.find(c => acceptable(c) && !c.genericFallback) ?? ranked.find(acceptable);
    if (!winner) return null;
    const type = winner.model.icaoType.length > 0 && request.icaoType.length > 0 && winner.model.icaoType.toLowerCase() === request.icaoType.toLowerCase() ? 'Icao'
      : winner.model.classCode.length === 3 && winner.model.classCode === remoteClass ? 'Category' : 'Auto';
    return { model: winner.model, type, total: winner.total, ranking: ranked, remote, request };
  }

  /** CombinedMatcher.AddTitleInferredIdentity */
  function titleInferredIdentity(identity, model, candidate, remoteType, collapsedRequest, remoteClass, remoteWtc) {
    if (!remoteType) return;
    if (model.icaoType.length > 0 && (!collapsedRequest || doc8643.isRecognized(model.icaoType))) return;
    if (candidate.effectiveIcao.toLowerCase() !== remoteType.toLowerCase()) return;
    const type = roundEven(200 * TITLE_INFERRED_FACTOR);
    identity.score += type; identity.attrs.IcaoType = type;
    identity.contributions.push(`title names ICAO type '${remoteType}' (title hint, model without a designator tag, +${type})`);
    const row = doc8643.get(remoteType);
    if (!row) return;
    if (remoteClass.length === 3 && row.classCode === remoteClass && model.classCode.length === 0) {
      const cls = roundEven(100 * TITLE_INFERRED_FACTOR); identity.score += cls; identity.attrs.ClassCode = cls; identity.contributions.push(`class code '${remoteClass}' via the title-named type (+${cls})`);
    }
    if (remoteWtc.length > 0 && row.wtc === remoteWtc && model.wtc.length === 0) {
      const wtc = roundEven(40 * TITLE_INFERRED_FACTOR); identity.score += wtc; identity.attrs.Wtc = wtc; identity.contributions.push(`WTC '${remoteWtc}' via the title-named type (+${wtc})`);
    }
  }

  /** CombinedMatcher.ApplyFoldedIdentity: for GLID, GLIM, UHEL ... the title decides what the tag cannot. Returns true for the generic last resort. */
  function foldedIdentity(identity, model, candidate, remoteType, request, remote) {
    const exactTag = model.icaoType.toLowerCase() === request.icaoType.toLowerCase();
    const tagLeavesTypeToTitle = !(model.icaoType.length > 0 && doc8643.isRecognized(model.icaoType))
      && (candidate.effectiveIcao.toLowerCase() === remoteType.toLowerCase() || reference.isStandInFor(request.icaoType, candidate.effectiveIcao));
    if (!exactTag && !tagLeavesTypeToTitle) return false;
    const remoteNamed = remote.matchedHint.length > 0, modelNamed = candidate.matchedHint.length > 0;
    const sameRow = candidate.specs.name === remote.specs.name || reference.isMemberOfRow(candidate.effectiveIcao, remote.specs.name, request.icaoType);
    let points, genericFallback = false;
    if (remoteNamed && modelNamed && candidate.matchedHint.toLowerCase() === remote.matchedHint.toLowerCase()) points = SAME_HINT_POINTS;
    else if (sameRow) points = 200;
    else { points = OTHER_KIND_POINTS; genericFallback = remoteNamed && !modelNamed; }
    const before = identity.attrs.IcaoType ?? 0;
    identity.score += points - before;
    identity.attrs.IcaoType = points;
    identity.contributions.push(`'${request.icaoType}' covers several aircraft (${before > 0 ? `type points ${before} -> ${points}` : `+${points}`})`);
    return genericFallback;
  }

  return { prepareModels: parsed => parsed.map(prepareModel), match, forRemote, isAirlineCode: code => airlines.isKnownCode(String(code)) };
}
