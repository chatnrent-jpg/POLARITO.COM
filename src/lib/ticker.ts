/**
 * Ticker normalisation shared by the browser (early feedback) and the server
 * (the real gate). Only plain US stock symbols are allowed: 1-5 letters with an
 * optional class suffix (BRK.B, BF-B). Anything else is rejected, which also
 * keeps arbitrary text out of the upstream URL path.
 */
const TICKER_PATTERN = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;

/** Returns the upper-cased ticker, or null if it is not a valid stock symbol. */
export function normalizeTicker(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim().toUpperCase();
  return TICKER_PATTERN.test(t) ? t : null;
}
