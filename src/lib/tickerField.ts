import { normalizeTicker } from "@/lib/ticker";

/**
 * How the single Stock Ticker field (inside the order box) relates to what has been analyzed.
 *   empty    nothing typed
 *   invalid  not a plain US stock symbol (loadBars would refuse it too)
 *   current  the typed ticker is the analyzed one: orders may use the analysis
 *   pending  the typed ticker differs from the analyzed one (or none is analyzed yet): press Analyze first
 * Orders only ever use an analysis whose ticker matches the field, so a typed-but-unanalyzed ticker can never
 * be traded on another ticker's gear.
 */
export type TickerFieldState = "empty" | "invalid" | "current" | "pending";

export function tickerFieldState(draft: string, analyzedTicker: string | null): TickerFieldState {
  if (draft.trim() === "") return "empty";
  const t = normalizeTicker(draft);
  if (t === null) return "invalid";
  return analyzedTicker !== null && t === analyzedTicker ? "current" : "pending";
}
