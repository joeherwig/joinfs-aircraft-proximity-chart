// The search box: how well an aircraft fits the text, and which aircraft count as hits. Pure, so it can be tested without the page.

export const NO_MATCH = 4;
const squash = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * How well an aircraft matches the search: 1 = ICAO type or alias equals it, 2 = ICAO type or alias starts with it,
 * 3 = found anywhere (name, manufacturer, title hints, ...), 4 = no match. Punctuation and spaces are ignored, like
 * JoinFS does when it looks a type tag up (JU-52 = JU52).
 */
export function searchTier(a, search) {
  const q = search.trim().toLowerCase();
  const qs = squash(q);
  const codes = [a.icao, ...(a.aliases ?? [])].map(squash);
  if (qs && codes.includes(qs)) return 1;
  if (qs && codes.some(c => c.startsWith(qs))) return 2;
  const fields = [a.icao, a.name, a.manufacturer, ...(a.aliases ?? []), ...(a.titleHints ?? [])];
  return fields.some(x => x.toLowerCase().includes(q) || (qs !== '' && squash(x).includes(qs))) ? 3 : NO_MATCH;
}

/** Only the best tier that has any hit counts: "C177" finds the Cardinal, not the C-17 whose title hint says "CC-177". */
export function bestSearchTier(aircraft, search) {
  return Math.min(NO_MATCH, ...aircraft.map(a => searchTier(a, search)));
}

/** True when the aircraft is a hit. An empty search hits everything; a search nothing fits hits nothing (it must never fall back to "everything"). */
export function isSearchHit(a, search, best) {
  if (search.trim() === '') return true;
  const tier = searchTier(a, search);
  return tier < NO_MATCH && tier <= best;
}
