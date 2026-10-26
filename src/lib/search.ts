/**
 * One search rule for the whole app, so every box behaves the same way:
 *
 *   • case never matters                        h-100  =  H-100
 *   • dashes, spaces, dots, slashes are ignored  h100  =  h-100  =  h 100  =  h.100
 *   • several words must ALL be found            "h100 pix"  finds  H-100 · PIX
 *
 * Works on letters and digits only, so it is safe for SKU codes such as "TB-H-210-PIX",
 * sizes such as "1200-8M-30" and brand names alike. Free of server imports (used by the
 * browser and by server pages).
 */

/** Lower-case and keep letters and digits only: "TB-H-100 PIX" → "tbh100pix". */
export const squash = (s: string | number | null | undefined): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The words of a query, each squashed: "H-100  pix" → ["h100", "pix"]. */
export const queryTerms = (query: string): string[] =>
  query.split(/\s+/).map(squash).filter(Boolean);

/**
 * Build a matcher for a query. Call it with the fields of one row; it is true when every word of
 * the query appears in at least one field. An empty query matches everything.
 * Fields are joined with a separator that squash() never produces, so a word can't straddle
 * two fields ("100" + "pix" never matches a search for "0p").
 */
export function makeMatcher(query: string): (fields: (string | number | null | undefined)[]) => boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return () => true;
  return (fields) => {
    const hay = fields.map(squash).join('|');
    return terms.every((t) => hay.includes(t));
  };
}

/** True when a query has something to search for. */
export const hasQuery = (query: string): boolean => queryTerms(query).length > 0;
