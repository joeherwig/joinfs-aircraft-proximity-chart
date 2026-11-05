// Type-to-type proximity, ported from JoinFS docs/model-matching.md (sections 5-8).
// Pure functions, no DOM: usable in the browser bundle and in Node tests.

export const NEAR_FROM = 0.8;  // below this similarity two aircraft are not 'near identical'
export const NEAR_MAX = 60;    // the bonus at identical specs
export const NEAR_MIN_CONFIDENCE = 0.75; // 'identical' needs most of the comparison to be known: two aircraft that only share an engine count are not
export const MAX_POINTS = 100 + 40 + NEAR_MAX; // physical similarity + same manufacturer + near identical
export const SIMILARITY_ACCEPT = 0.5;

// feature: weight, saturation factor of the log ratio (numeric features)
const NUMERIC = [
  { key: 'mtowKg', feature: 'mtow', weight: 3.0, factor: 4, size: true },
  { key: 'spanM', feature: 'span', weight: 2.0, factor: 2, size: true },
  { key: 'lengthM', feature: 'length', weight: 1.5, factor: 2, size: true },
  { key: 'cruiseKt', feature: 'cruise', weight: 2.0, factor: 2, size: false },
];
const W_ENGINE_COUNT = 2.0;
const W_ENGINE_TYPE = 2.0;
const W_WING = 1.0;
const W_GEAR = 1.5;
const TOTAL_WEIGHT = NUMERIC.reduce((s, f) => s + f.weight, 0) + W_ENGINE_COUNT + W_ENGINE_TYPE + W_WING + W_GEAR;

export const FEATURES = [...NUMERIC.map(f => f.feature), 'engineCount', 'engineType', 'wing', 'gear'];

const ENGINE_TYPE_DISTANCE = {
  'piston|turboprop': 0.5,
  'turboprop|turboshaft': 0.4,
  'jet|turboprop': 0.6,
  'piston|turboshaft': 0.7,
  'electric|piston': 0.4,
  'jet|turboshaft': 0.9,
};

const known = v => v !== null && v !== undefined && !Number.isNaN(v);
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function logDistance(a, b, factor) {
  if (!(a > 0) || !(b > 0)) return null;
  return Math.min(1, Math.abs(Math.log(a / b)) / Math.log(factor));
}

function engineCountDistance(a, b) {
  const diff = Math.abs(a - b);
  return diff === 0 ? 0 : diff === 1 ? 0.6 : 1;
}

function engineTypeDistance(a, b) {
  if (a === b) return 0;
  return ENGINE_TYPE_DISTANCE[pairKey(a, b)] ?? 1;
}

function wingDistance(a, b) {
  if (a === b) return 0;
  if ((a === 'mid' && (b === 'high' || b === 'low')) || (b === 'mid' && (a === 'high' || a === 'low'))) return 0.5;
  return 1;
}

const WHEELS = new Set(['tricycle', 'taildragger']);
function gearDistance(a, b) {
  if (a === b) return 0;
  if (WHEELS.has(a) && WHEELS.has(b)) return 0.6;
  if ((a === 'floats' && WHEELS.has(b)) || (b === 'floats' && WHEELS.has(a))) return 0.8;
  return 1;
}

export const isRotor = a => a.rotor === true || a.wing === 'rotor';

export function normalizeManufacturer(m) {
  return (m ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Physical similarity (section 6): score 0..1, confidence 0..1 and a per-feature breakdown. */
export function physicalSimilarity(a, b) {
  const parts = [];
  const add = (feature, weight, distance, size) => {
    if (distance !== null) parts.push({ feature, weight, distance, size });
  };
  for (const f of NUMERIC) {
    add(f.feature, f.weight, known(a[f.key]) && known(b[f.key]) ? logDistance(a[f.key], b[f.key], f.factor) : null, f.size);
  }
  add('engineCount', W_ENGINE_COUNT, known(a.engines) && known(b.engines) ? engineCountDistance(a.engines, b.engines) : null, false);
  add('engineType', W_ENGINE_TYPE, a.engineType && b.engineType ? engineTypeDistance(a.engineType, b.engineType) : null, false);
  add('wing', W_WING, a.wing && b.wing ? wingDistance(a.wing, b.wing) : null, false);
  add('gear', W_GEAR, a.gear && b.gear ? gearDistance(a.gear, b.gear) : null, false);

  const compared = parts.reduce((s, p) => s + p.weight, 0);
  if (compared === 0) return { score: 0, confidence: 0, parts };
  const score = parts.reduce((s, p) => s + p.weight * (1 - p.distance), 0) / compared;

  // No size feature compared: confidence is measured against engine count + engine type + gear only.
  const hasSize = parts.some(p => p.size);
  let confidence;
  if (hasSize) confidence = compared / TOTAL_WEIGHT;
  else {
    const decisive = W_ENGINE_COUNT + W_ENGINE_TYPE + W_GEAR;
    const comparedDecisive = parts.filter(p => p.feature === 'engineCount' || p.feature === 'engineType' || p.feature === 'gear')
      .reduce((s, p) => s + p.weight, 0);
    confidence = comparedDecisive / decisive;
  }
  return { score, confidence, parts };
}

/** Plausibility gate (section 7): rotorcraft vs fixed wing, or weights differing by more than a factor 8. */
export function isImplausible(a, b) {
  if (isRotor(a) !== isRotor(b)) return true;
  if (a.mtowKg > 0 && b.mtowKg > 0 && Math.max(a.mtowKg, b.mtowKg) / Math.min(a.mtowKg, b.mtowKg) > 8) return true;
  return false;
}

/** Same-manufacturer bonus condition (section 6). */
export function sameMakerSimilarSize(a, b) {
  const ma = normalizeManufacturer(a.manufacturer);
  const mb = normalizeManufacturer(b.manufacturer);
  if (!ma || !mb || ma !== mb) return false;
  if (isRotor(a) !== isRotor(b)) return false;
  if (a.mtowKg > 0 && b.mtowKg > 0) return Math.max(a.mtowKg, b.mtowKg) / Math.min(a.mtowKg, b.mtowKg) <= 2.5;
  if (a.spanM > 0 && b.spanM > 0) return Math.max(a.spanM, b.spanM) / Math.min(a.spanM, b.spanM) <= 1.6;
  return false;
}

/**
 * Bonus for aircraft that are almost the same (replaces the family list): grows smoothly from 0 at NEAR_FROM to NEAR_MAX at identical specs,
 * scaled by how much of the comparison is known.
 */
export function nearIdenticalBonus({ score, confidence }) {
  if (!(score > NEAR_FROM) || !(confidence >= NEAR_MIN_CONFIDENCE)) return 0;
  const t = Math.min(1, (score - NEAR_FROM) / (1 - NEAR_FROM));
  return Math.round(NEAR_MAX * t * t * (3 - 2 * t) * confidence);
}

/**
 * Proximity of two aircraft types.
 * @returns {{total:number, percent:number, physical:{score,confidence,points,parts}, manufacturerBonus:number,
 *            nearIdenticalBonus:number, excluded:boolean, accepted:boolean}}
 */
export function proximity(a, b) {
  const physical = physicalSimilarity(a, b);
  physical.points = Math.round(100 * physical.score * physical.confidence);
  const excluded = isImplausible(a, b);
  const manufacturerBonus = !excluded && sameMakerSimilarSize(a, b) ? 40 : 0;
  const near = excluded ? 0 : nearIdenticalBonus(physical);
  const total = physical.points + manufacturerBonus + near;
  const accepted = !excluded && physical.score >= SIMILARITY_ACCEPT;
  return { total, percent: total / MAX_POINTS, physical, manufacturerBonus, nearIdenticalBonus: near, excluded, accepted };
}

/** Section 8 ordering: higher combined score, higher physical score, then ICAO. */
function compareNeighbours(x, y) {
  return (y.p.total - x.p.total) || (y.p.physical.score - x.p.physical.score) || (x.icao < y.icao ? -1 : x.icao > y.icao ? 1 : 0);
}

/** Builds the pairwise proximity table for all aircraft and a ranked, accepted neighbour list per aircraft. */
export function buildIndex(aircraft) {
  const n = aircraft.length;
  const matrix = Array.from({ length: n }, () => new Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = proximity(aircraft[i], aircraft[j]);
      matrix[i][j] = p;
      matrix[j][i] = p; // symmetric: the breakdown has no direction
    }
  }
  const neighbours = aircraft.map((a, i) => {
    const list = [];
    for (let j = 0; j < n; j++) {
      if (j !== i && matrix[i][j].accepted) list.push({ index: j, icao: aircraft[j].icao, p: matrix[i][j] });
    }
    return list.sort(compareNeighbours);
  });
  return { aircraft, matrix, neighbours };
}

/**
 * `node` as a neighbour of aircraft `i` with its real position among all other aircraft (1 = the most similar), also when it is not one of the accepted
 * neighbours: { index, icao, p, rank }. Null for the aircraft itself. Same ordering as buildIndex.
 */
export function neighbourOf(index, i, node) {
  if (node === i || node < 0 || node >= index.aircraft.length) return null;
  const p = index.matrix[i][node];
  const mine = { p, icao: index.aircraft[node].icao };
  let better = 0;
  for (let j = 0; j < index.aircraft.length; j++) {
    if (j === i || j === node) continue;
    if (compareNeighbours({ p: index.matrix[i][j], icao: index.aircraft[j].icao }, mine) < 0) better++;
  }
  return { index: node, icao: mine.icao, p, rank: better + 1 };
}
