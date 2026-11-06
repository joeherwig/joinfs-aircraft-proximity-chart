// The order of the "most similar aircraft" list when a models list is loaded: the installed types in the order JoinFS' matcher ranks them for the remote aircraft,
// so the list and the model JoinFS would inject agree. The physical similarity and the manufacturer bonus alone would put e.g. every Airbus before a C130 for an A400.

/**
 * @param {{model:{source:object}, total:number, effectiveIcao?:string}[]} ranking  the matcher's ranking, best first
 * @param {object} winner  the model the matcher chose (its entry and the better ranked, unacceptable ones, are skipped)
 * @param {(model:object)=>number} nodeOf  the chart node of a model, or -1
 * @param {number} limit
 * @returns {{node:number, score:number}[]}  one entry per installed type (its best model), best first
 */
export function matcherOrder(ranking, winner, nodeOf, limit) {
  const start = ranking.findIndex(c => c.model === winner);
  const seen = new Set();
  const order = [];
  for (const c of start < 0 ? [] : ranking.slice(start)) {
    const node = nodeOf(c);
    if (node < 0 || seen.has(node)) continue;
    seen.add(node);
    order.push({ node, score: c.total });
    if (order.length >= limit) break;
  }
  return order;
}
