// The "most similar aircraft" list. With a models list loaded the installed types come first in the order JoinFS' matcher ranks them for the remote aircraft, so the
// list and the model JoinFS would inject agree. Every row states everything that was taken into consideration: the points of the matching type data (type, class
// code, weight class, role, airline), the physical similarity, the near-identical and manufacturer bonuses and, for an airliner of the requested airline, the livery
// tier. The score is shown as points and as a percentage of what a perfect candidate would get; it never rises from one row to the next.

/** What a perfect candidate scores: type 200 + class code 100 + weight class 40 + role 15 + similarity 100 + near-identical 60 + manufacturer 40; an airline match adds 100. */
export const SCORE_MAX = 555;
export const AIRLINE_POINTS = 100;
/** The identity points of a row by reason, in the order they are shown; what the reasons do not cover is the shared words of the titles. */
export const IDENTITY_REASONS = ['IcaoType', 'IcaoAirline', 'ClassCode', 'Wtc', 'Typerole'];
export function identityParts(row) {
  const parts = IDENTITY_REASONS.map(reason => ({ reason, points: row.attrs?.[reason] ?? 0 })).filter(p => p.points > 0);
  const rest = (row.identity ?? 0) - parts.reduce((sum, p) => sum + p.points, 0);
  if (rest > 0) parts.push({ reason: 'Title', points: rest });
  return parts;
}
export const maxScore = withAirline => SCORE_MAX + (withAirline ? AIRLINE_POINTS : 0);

/**
 * @param {{model:object, total:number, baseline:number, similarityPoints:number, nearPoints:number, familyBonus:number, liveryFirst?:boolean, effectiveIcao?:string}[]} ranking  the matcher's ranking, best first
 * @param {object} winner  the model the matcher chose (its entry and the better ranked, unacceptable ones, are skipped)
 * @param {(entry:object)=>number} nodeOf  the chart node of a ranking entry, or -1
 * @param {number} limit
 * @returns {{node:number, total:number, identity:number, attrs:object, similarity:number, near:number, manufacturer:number, liveryFirst:boolean}[]}  one entry per installed type (its best model), best first
 */
export function matcherOrder(ranking, winner, nodeOf, limit) {
  const start = ranking.findIndex(c => c.model === winner);
  const seen = new Set();
  const order = [];
  for (const c of start < 0 ? [] : ranking.slice(start)) {
    const node = nodeOf(c);
    if (node < 0 || seen.has(node)) continue;
    seen.add(node);
    order.push({
      node, total: c.total, identity: c.baseline ?? 0, attrs: c.attrs ?? {}, similarity: c.similarityPoints ?? 0, near: c.nearPoints ?? 0, manufacturer: c.familyBonus ?? 0, liveryFirst: !!c.liveryFirst,
    });
    if (order.length >= limit) break;
  }
  return order;
}

/**
 * Gives every row the score it is shown with and the points of its parts, so that the score never rises down the list:
 * an airliner of the requested airline ranks before models with more points (the livery tier) - its shown score is lifted to the best of the rows below and the
 * lift is listed as a part of its own. Types without a matcher score (not installed) are placed by the points their data alone earns, capped by the row above.
 * @param {ReturnType<typeof matcherOrder>} order
 * @param {{node:number, p:object}[]} unranked  neighbours that merely look similar, best first
 */
export function withScores(order, unranked) {
  const rows = [];
  let ceiling = Infinity;
  const below = order.map((_, i) => Math.max(0, ...order.slice(i + 1).map(o => o.total)));
  order.forEach((o, i) => {
    const lifted = o.liveryFirst ? Math.max(o.total, below[i]) : o.total;
    const score = Math.min(lifted, ceiling);
    ceiling = score;
    rows.push({ ...o, score, livery: Math.max(0, score - o.total) });
  });
  // a type that merely looks similar takes the place its own score earns among the rows (never before the matcher's choice), capped by the row above it
  for (const n of [...unranked].sort((x, y) => y.p.total - x.p.total)) {
    const at = rows.findIndex((r, i) => i > 0 && r.score < n.p.total);
    const place = at < 0 ? rows.length : at;
    const score = Math.min(n.p.total, rows[place - 1]?.score ?? Infinity);
    rows.splice(place, 0, { node: n.index, score, identity: 0, similarity: n.p.physical.points, near: n.p.nearIdenticalBonus, manufacturer: n.p.manufacturerBonus, livery: 0, liveryFirst: false, unranked: true });
  }
  return rows;
}
