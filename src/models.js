// Parser for the JoinFS models list ("models - <simulator>.txt"). Pure functions, no DOM.
// Line layout (see JoinFS/Substitution.cs): title[+]manufacturer[+]type[+]variation[+]index[+]engine[+]...[+]icaoType[+]wake[+]airline[+]class[+]confirmed
// The variation is what JoinFS shows as the livery; the ICAO type (field 8) is what ties a model to an aircraft type.

const squash = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The airline (ICAO code) a callsign stands for, resolved with the airlines the models list itself knows. Returns '' if unknown.
 *   1. an ICAO callsign or bare code: three letters, then digits or nothing (DLH123, DLH) - if some model carries that code;
 *   2. otherwise a name: the text (without trailing flight number) as part of the livery or title of models that carry an
 *      airline code (Lufthansa, "Aegean"); the code of most of those models wins.
 */
export function resolveAirline(callsign, models) {
  const text = String(callsign ?? '').trim();
  if (!text) return '';
  const prefix = /^([A-Za-z]{3})(\d.*)?$/.exec(text);
  if (prefix) {
    const code = prefix[1].toUpperCase();
    if (models.some(m => m.airline.toUpperCase() === code)) return code;
  }
  const needle = squash(text.replace(/[\s\d]+$/, ''));
  if (needle.length < 3) return '';
  const votes = new Map();
  for (const m of models) {
    if (!m.airline || !squash(`${m.livery} ${m.title}`).includes(needle)) continue;
    const code = m.airline.toUpperCase();
    votes.set(code, (votes.get(code) ?? 0) + 1);
  }
  let best = '';
  let top = 0;
  for (const [code, n] of votes) if (n > top) { best = code; top = n; }
  return best;
}

/** How well a model fits an airline code: 4 = the model's airline field, 2 = the code appears as a word in title or livery, 0 = no. */
export function airlineScore(model, code) {
  if (!code) return 0;
  if (model.airline.toUpperCase() === code) return 4;
  const word = new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`, 'i');
  return word.test(`${model.title} ${model.livery}`) ? 2 : 0;
}

/**
 * How well a model fits the callsign itself, for aircraft without an airline (TBM9 with N960VM): 5 if the callsign appears as a
 * whole word in the title or livery (case and punctuation ignored, N-960VM = N960VM), else 0.
 */
export function callsignScore(model, callsign) {
  const want = squash(callsign ?? '');
  if (want.length < 3) return 0;
  const words = `${model.title} ${model.livery}`.split(/[^A-Za-z0-9]+/).map(squash);
  if (words.includes(want)) return 5;
  // registrations written with separators in the title: N-960-VM
  return squash(`${model.title} ${model.livery}`).includes(want) && new RegExp(`(^|[^A-Za-z0-9])${[...want].join('[^A-Za-z0-9]?')}([^A-Za-z0-9]|$)`, 'i').test(`${model.title} ${model.livery}`) ? 5 : 0;
}

/** The better of the airline fit and the callsign fit. */
export function modelScore(model, code, callsign) {
  return Math.max(airlineScore(model, code), callsignScore(model, callsign));
}

/** All models of a list as { title, manufacturer, livery, icaoType, airline }. Comment and empty lines are skipped. */
export function parseModels(text) {
  let separator = '|';
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('#')) { if (line.includes('new separator')) separator = '[+]'; continue; }
    if (line.trim() === '') continue;
    const p = line.split(separator);
    if (p.length < 4) continue;
    out.push({ title: p[0], manufacturer: p[1], type: (p[2] ?? '').trim(), livery: p[3], role: p[5] ?? '', icaoType: (p[8] ?? '').trim(), wtc: (p[9] ?? '').trim(), airline: (p[10] ?? '').trim(),
      classCode: (p[11] ?? '').trim(), confirmed: p[12] === 'True' });
  }
  return out;
}

const WEIGHT_RATIO_MAX = 4; // mirrors ReferenceSpecs.AmbiguousDesignatorMaxMtowRatio

/** True if `hint` appears in `text` as a standalone token (not adjacent to a letter or digit), case-insensitive - like JoinFS' ContainsToken. */
function containsToken(text, hint) {
  const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(text);
}

/** The longest title hint or name of `a` found in `text` ("" if none); the bare designator only counts when `designatorIsAHint`. */
export function hintOf(a, text, designatorIsAHint = true) {
  let best = '';
  for (const hint of [...(a.icao.length >= 3 ? [a.icao] : []), a.name, ...(a.titleHints ?? []), ...(a.aliases ?? []).filter(x => x.length >= 4)]) {
    if (hint && hint.length > best.length && (designatorIsAHint || hint.toLowerCase() !== a.icao.toLowerCase()) && containsToken(text, hint)) best = hint;
  }
  return best;
}

const hintLength = (a, text, designatorIsAHint = false) => hintOf(a, text, designatorIsAHint).length;

/** A specific type that can stand in for an ambiguous designator: another designator, same rotor flag and engine kind, comparable weight. */
export function similarKind(candidate, base) {
  if (candidate.icao === base.icao || !!candidate.rotor !== !!base.rotor) return false;
  if (candidate.engineType && base.engineType && candidate.engineType !== base.engineType) return false;
  if (!(candidate.mtowKg > 0) || !(base.mtowKg > 0)) return false;
  return Math.max(candidate.mtowKg, base.mtowKg) / Math.min(candidate.mtowKg, base.mtowKg) <= WEIGHT_RATIO_MAX;
}

/**
 * The aircraft index a model of a designator with several rows (GLID, GLIM ...) belongs to - the same rule as JoinFS' ReferenceSpecs.FindForText:
 * the longest title hint found in the title/livery wins, whether it belongs to one of the designator's own rows or to a specific type of a
 * similar kind (an ASK 21 for GLID); nothing found: the first row.
 */
export function pickRow(rowIndexes, aircraft, text) {
  return bestRow(rowIndexes, aircraft, text).index;
}

/** Like pickRow, plus the title hint that named the row ("" when none did and the first row is only the default; also for a designator with one row). */
export function resolveRow(rowIndexes, aircraft, text) {
  if (rowIndexes.length < 2) return { index: rowIndexes[0], hint: hintOf(aircraft[rowIndexes[0]], text, true) };
  const found = bestRow(rowIndexes, aircraft, text);
  return { index: found.index, hint: found.length > 0 ? hintOf(aircraft[found.index], text, !rowIndexes.includes(found.index)) : '' };
}

/**
 * True when the specific type shares a title hint with the named row of the folded designator: the class row lists its members ("classic wooden"
 * lists K7 and Pirat), so a K 7 is the same kind of aircraft as a Grunau Baby. Mirrors ReferenceSpecs.IsMemberOfRow.
 */
export function isMemberOfRow(candidate, row) {
  if (!candidate || !row || candidate === row) return false;
  const mine = new Set((candidate.titleHints ?? []).map(h => h.toLowerCase()));
  return (row.titleHints ?? []).some(h => mine.has(h.toLowerCase()));
}

/** Like pickRow, plus the length of the hint that decided (0 = nothing in the text named any row: the first row is only the default). */
function bestRow(rowIndexes, aircraft, text) {
  let own = rowIndexes[0];
  let ownLength = 0;
  for (const i of rowIndexes) {
    const length = hintLength(aircraft[i], text);
    if (length > ownLength) { own = i; ownLength = length; }
  }
  let specific = -1;
  let specificLength = ownLength;
  aircraft.forEach((a, i) => {
    if (a.virtual || rowIndexes.includes(i) || !similarKind(a, aircraft[rowIndexes[0]])) return;   // a model set's own node is no row to look a title up in
    const length = hintLength(a, text, true); // a specific type's own designator (LS4) names it
    // on an equally long hint the specific type wins (a class row lists its members as hints), like JoinFS
    if (length > 0 && length >= specificLength) { specific = i; specificLength = length; }
  });
  return specific >= 0 ? { index: specific, length: specificLength } : { index: own, length: ownLength };
}

/**
 * For a model whose tag is no known designator (MSFS: "JS3-15") or empty: the rows of the folded designator (GLID, GLIM ... - several rows) whose
 * title hints the title names, else undefined. Only folded designators are inferred: elsewhere a loose word in a title ("Black Hawk", "Airliner")
 * would put models on unrelated types.
 */
function rowsNamedIn(text, aircraft, lookup) {
  let best = null;
  for (const rows of lookup.values()) {
    if (rows.length < 2) continue;
    const hit = bestRow(rows, aircraft, text);
    if (hit.length > (best?.length ?? 0)) best = { rows: lookup.get(squash(aircraft[hit.index].icao)), length: hit.length };
  }
  return best?.rows;
}

/**
 * The rows of the type a title names, for a model without a usable designator tag ("Cabri G2 Passengers" has none): the longest title hint of any aircraft
 * found in the text, like JoinFS' ReferenceSpecs.InferIcaoFromText. A designator's own tag never counts here.
 */
function rowsInferredFromTitle(text, aircraft, lookup) {
  let best = -1, bestLength = 0;
  aircraft.forEach((a, i) => {
    if (a.virtual) return;
    const length = hintLength(a, text);
    if (length > bestLength) { best = i; bestLength = length; }
  });
  return best < 0 ? undefined : lookup.get(squash(aircraft[best].icao));
}

/**
 * Groups models by the chart's aircraft: Map<aircraft index, models[]>. A model belongs to the aircraft whose ICAO type
 * or alias equals its ICAO type (punctuation ignored); where a designator has several rows (GLID, GLIM ...) the title picks the row
 * (see pickRow). Models without a known type are counted in `unmatched`.
 */
export function groupModels(models, aircraft) {
  const lookup = new Map(); // squashed icao/alias -> every row index of that designator, first row first
  aircraft.forEach((a, i) => { const k = squash(a.icao); if (!lookup.has(k)) lookup.set(k, []); lookup.get(k).push(i); });
  aircraft.forEach((a, i) => { for (const x of a.aliases ?? []) if (!lookup.has(squash(x))) lookup.set(squash(x), [i]); });
  const byAircraft = new Map();
  let unmatched = 0;
  const seen = new Set();
  for (const m of models) {
    const text = `${m.title} ${m.livery}`;
    // a tag that is no known designator (MSFS: "JS3-15") or no tag at all: the type is inferred from the title, like JoinFS does
    const rows = (m.icaoType ? lookup.get(squash(m.icaoType)) : undefined) ?? rowsNamedIn(text, aircraft, lookup) ?? rowsInferredFromTitle(text, aircraft, lookup);
    if (rows === undefined) { unmatched++; continue; }
    const i = rows.length > 1 ? pickRow(rows, aircraft, text) : rows[0];
    const key = `${i}${m.title}${m.livery}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byAircraft.has(i)) byAircraft.set(i, []);
    byAircraft.get(i).push(m);
  }
  // Best first: names the type's title hints (A330-200 ...), is confirmed by JoinFS, has a livery name; then alphabetical.
  byAircraft.forEach((list, i) => {
    const hints = (aircraft[i].titleHints ?? []).map(squash).filter(Boolean);
    const score = m => {
      const text = squash(`${m.title} ${m.livery}`);
      return (hints.some(h => text.includes(h)) ? 2 : 0) + (m.confirmed ? 1 : 0) + (m.livery ? 0.5 : 0);
    };
    const scores = new Map(list.map(m => [m, score(m)]));
    list.sort((a, b) => scores.get(b) - scores.get(a) || (a.livery || a.title).localeCompare(b.livery || b.title));
  });
  return { byAircraft, unmatched };
}

// ---- shared title words (mirrors JoinFS TitleTokens and CombinedMatcher.TitleTokenBonus) ----

export const TITLE_TOKEN_POINTS = 10;
export const TITLE_TOKEN_BONUS_MAX = 30;
const GENERIC_WORDS = new Set(['glider', 'gliders', 'sailplane', 'segelflugzeug', 'motorglider', 'motor', 'default', 'standard', 'passengers', 'passenger', 'livery', 'aircraft', 'plane', 'version', 'edition', 'the', 'and']);

/** The distinctive words of a title plus the joined neighbouring words ("ASK 21" and "ASK21" share "ask21"). */
export function titleTokens(title) {
  const parts = [];
  for (const raw of String(title ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || GENERIC_WORDS.has(raw)) continue;
    for (const run of raw.match(/[0-9]+|[a-z]+/g) ?? []) if (run.length >= 2 || /[0-9]/.test(run)) parts.push(run);
  }
  const tokens = new Set();
  parts.forEach((word, i) => { tokens.add(word); if (i > 0) tokens.add(parts[i - 1] + word); });
  return tokens;
}

/** How many title tokens two titles have in common. */
export function sharedTitleWords(a, b) {
  const other = titleTokens(b);
  let shared = 0;
  for (const token of titleTokens(a)) if (other.has(token)) shared++;
  return shared;
}

/** Points for the title words a model shares with the remote title: 10 per word, at most 30. */
export function titleBonus(remoteTitle, modelTitle) {
  return Math.min(TITLE_TOKEN_BONUS_MAX, sharedTitleWords(remoteTitle, modelTitle) * TITLE_TOKEN_POINTS);
}

/**
 * How well an installed model's title fits the remote title, to order the models of one row: an exact title (JoinFS' "Original" tier) beats
 * everything, then the capped title-word bonus, then the plain number of shared words as a tie-break.
 */
export function titleFit(remoteTitle, modelTitle) {
  const remote = String(remoteTitle ?? '').trim().toLowerCase();
  if (!remote) return 0;
  if (remote === String(modelTitle ?? '').trim().toLowerCase()) return 1e6;
  return titleBonus(remoteTitle, modelTitle) * 100 + sharedTitleWords(remoteTitle, modelTitle);
}

/**
 * True for a generic class line of a collapsed designator: manufacturer "-" and several lines under the same code (GLID: "Glider, 15 m class" ...).
 * Such a line only supplies parameters (size, weight, speed ...) for titles that list it as a hint; it is never an aircraft to inject. A collapsed
 * designator with a single "-" line (BALL) can be used as it is.
 */
export function isLookupLine(aircraft, i) {
  const a = aircraft[i];
  if (!a || a.manufacturer !== '-') return false;
  return aircraft.filter(x => x.icao === a.icao && x.manufacturer === '-').length > 1;
}

const mostCommon = counts => [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0];
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/**
 * Nodes for the types of a loaded model set that the aircraft data does not know (SZD30, AS7, LS4, JS3-15 ...): every distinct model tag that is no row or
 * alias of the data and whose models resolve, through their title hint, to a generic class line. Such a node takes the parameters of that class line (the
 * lookup), and its name and manufacturer from the model list. The junk tags of a list (scenery objects, tags guessed from a title) resolve to no class line
 * and get no node. Without models there are none; nothing is written to the data.
 */
export function virtualAircraft(models, aircraft) {
  const known = new Set();
  for (const a of aircraft) { known.add(squash(a.icao)); for (const x of a.aliases ?? []) known.add(squash(x)); }
  const lineRows = new Map(); // designator -> its class line indexes
  aircraft.forEach((a, i) => { if (isLookupLine(aircraft, i)) { if (!lineRows.has(a.icao)) lineRows.set(a.icao, []); lineRows.get(a.icao).push(i); } });

  const byTag = new Map();
  for (const m of models) {
    const key = squash(m.icaoType);
    if (!key || known.has(key)) continue;
    const text = `${m.title} ${m.livery}`;
    let best = null;
    for (const rows of lineRows.values()) {
      const hit = resolveRow(rows, aircraft, text);
      if (hit.hint && rows.includes(hit.index) && (!best || hit.hint.length > best.hint.length)) best = hit;
    }
    if (!best) continue;
    if (!byTag.has(key)) byTag.set(key, { tag: m.icaoType, lines: new Map(), manufacturers: new Map(), types: new Map() });
    const e = byTag.get(key);
    bump(e.lines, best.index);
    if (m.manufacturer) bump(e.manufacturers, m.manufacturer);
    if (m.type) bump(e.types, m.type);
  }

  return [...byTag.values()].sort((x, y) => (x.tag < y.tag ? -1 : 1)).map(e => {
    const line = mostCommon(e.lines);
    const base = aircraft[line];
    const manufacturer = mostCommon(e.manufacturers) ?? '';
    const type = mostCommon(e.types) ?? '';
    return {
      icao: e.tag, nonIcao: true, virtual: true, lookup: line,
      name: manufacturer && type ? `${manufacturer} ${type}` : e.tag,
      manufacturer: manufacturer || '-', titleHints: [],
      rotor: base.rotor, wing: base.wing, spanM: base.spanM, lengthM: base.lengthM, mtowKg: base.mtowKg,
      engines: base.engines, engineType: base.engineType, cruiseKt: base.cruiseKt, gear: base.gear,
    };
  });
}
