/**
 * Browser-side loader for /api/bars. No UI here, no engine here: it returns
 * validated bars or throws a readable Error.
 *
 * The browser only knows the URL of OUR proxy. Alpaca keys never live here.
 *
 *   Local (`next dev`):    Next.js route at /api/bars
 *   Name.com (static):     Apache rewrites /api/bars -> api/bars.php
 *
 * Optional public (non-secret) build-time vars:
 *   NEXT_PUBLIC_BARS_ENDPOINT  full URL or path of the proxy (default /api/bars)
 *   NEXT_PUBLIC_BASE_PATH      subdirectory prefix, e.g. /polarito
 */
import type { Bar } from "@/lib/polarity";
import { sanitizeSentiment, type SentimentByDate } from "@/lib/sentimentEngine";
import { normalizeTicker } from "@/lib/ticker";

type BarsPayload =
  | { ok: true; ticker: string; bars: Bar[]; sentiment?: unknown }
  | { ok: false; code?: string; error?: string };

/** Public proxy URL. Not a key. Never point this at data.alpaca.markets from the browser. */
export function barsEndpoint(ticker: string): string {
  const configured = (process.env.NEXT_PUBLIC_BARS_ENDPOINT ?? "").trim();
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
  const path = configured !== "" ? configured : `${basePath}/api/bars`;
  const sep = path.indexOf("?") === -1 ? "?" : "&";
  return `${path}${sep}ticker=${encodeURIComponent(ticker)}`;
}

export async function loadBars(
  rawTicker: string,
  signal?: AbortSignal,
): Promise<{ ticker: string; bars: Bar[]; sentiment: SentimentByDate }> {
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) {
    throw new Error("Enter a valid stock ticker (1-5 letters, e.g. NVDA, TSLA, SPY).");
  }

  let res: Response;
  try {
    res = await fetch(barsEndpoint(ticker), {
      cache: "no-store",
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("Could not reach the server. Check your connection.");
  }

  let payload: BarsPayload;
  try {
    payload = (await res.json()) as BarsPayload;
  } catch {
    throw new Error(`Server returned an unreadable response (HTTP ${res.status}).`);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Server returned an unexpected response.");
  }
  if (!payload.ok) {
    throw new Error(payload.error ?? `Request failed (HTTP ${res.status}).`);
  }
  if (!Array.isArray(payload.bars) || payload.bars.length === 0) {
    throw new Error("Server returned no bars.");
  }
  // Sentiment is optional: malformed/missing entries are dropped and read as Neutral.
  return { ticker: payload.ticker, bars: payload.bars, sentiment: sanitizeSentiment(payload.sentiment) };
}

/** Public proxy URL for the chart's older daily history. Not a key. */
export function historyEndpoint(ticker: string): string {
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
  return `${basePath}/api/bars/history?ticker=${encodeURIComponent(ticker)}`;
}

/**
 * Older daily bars for the chart's quarterly / yearly candles. Fetched once per
 * ticker and kept for the page session: finished history never changes.
 * Failure rejects (the chart then shows only fully covered periods).
 */
const historyCache = new Map<string, Promise<Bar[]>>();

export function loadHistoryBars(rawTicker: string, signal?: AbortSignal): Promise<Bar[]> {
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) return Promise.reject(new Error("Invalid ticker."));
  const cached = historyCache.get(ticker);
  if (cached) return cached;
  const request = (async () => {
    const res = await fetch(historyEndpoint(ticker), { cache: "no-store", signal });
    const payload = (await res.json()) as BarsPayload;
    if (!payload || typeof payload !== "object" || !payload.ok || !Array.isArray(payload.bars)) {
      throw new Error("History unavailable.");
    }
    return payload.bars;
  })();
  historyCache.set(ticker, request);
  request.catch(() => historyCache.delete(ticker));
  return request;
}
