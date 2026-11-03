/**
 * Alpaca Market Data daily bars -> frontend `Bar[]`.
 *
 * SERVER ONLY. Credentials come from `process.env.ALPACA_API_KEY_ID` and
 * `process.env.ALPACA_API_SECRET_KEY` (no NEXT_PUBLIC_ prefix) and are sent as
 * request headers, so they never ship to the browser or appear in a URL. The
 * dashboard reaches this module through the /api/bars route handler
 * (`next dev`) or, on Name.com, through hosting/api/bars.php. Keys stay
 * server-side in both cases. Never rename them to NEXT_PUBLIC_*.
 *
 * Endpoint (documented multi-symbol form, called with one symbol):
 *   GET https://data.alpaca.markets/v2/stocks/bars
 *       ?symbols=TICKER&timeframe=1Day&start=YYYY-MM-DD&end=YYYY-MM-DD
 *       &adjustment=split&feed=iex&sort=asc&limit=10000
 */
import { validateBars, type Bar } from "@/lib/polarity";
import { calculateSentimentPolarity, type SentimentDay } from "@/lib/sentimentEngine";
import { normalizeTicker } from "@/lib/ticker";

const ALPACA_BARS_URL = "https://data.alpaca.markets/v2/stocks/bars";

/** The one and only aggregate range the app may request: 1 x day. */
export const REQUIRED_MULTIPLIER = 1;
export const REQUIRED_TIMESPAN = "day";
/** Alpaca's spelling of 1 x day. */
export const ALPACA_DAILY_TIMEFRAME = "1Day";

/** ~1 year of sessions (252) + 20-day volume warm-up, with holiday margin. */
const LOOKBACK_CALENDAR_DAYS = 450;
const REQUEST_LIMIT = 10_000; // Alpaca maximum; ~300 bars are expected
const REQUEST_TIMEOUT_MS = 10_000;

/** iex works on free plans; sip (all exchanges) needs a paid data plan. */
const ALLOWED_FEEDS = ["iex", "sip"] as const;

export type MarketErrorCode =
  | "BAD_TICKER"
  | "NO_API_KEY"
  | "BAD_CONFIG"
  | "RATE_LIMIT"
  | "AUTH"
  | "NOT_FOUND"
  | "UPSTREAM"
  | "NETWORK"
  | "BAD_RESPONSE"
  | "BAD_DATA";

export class MarketApiError extends Error {
  readonly code: MarketErrorCode;
  readonly status: number;
  constructor(code: MarketErrorCode, message: string, status: number) {
    super(message);
    this.name = "MarketApiError";
    this.code = code;
    this.status = status;
  }
}

/** Thrown when anything asks for sub-day (or non-1) data. Never caught and downgraded. */
export class TimeframeFirewallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeframeFirewallError";
  }
}

/**
 * STRICT TIMEFRAME FIREWALL.
 * The range must be exactly 1 day. Minute/hour bars, or a 2-day, weekly...
 * multiplier, are an absolute system failure, not a recoverable error.
 */
export function assertDailyRange(multiplier: unknown, timespan: unknown): void {
  if (multiplier !== REQUIRED_MULTIPLIER || timespan !== REQUIRED_TIMESPAN) {
    throw new TimeframeFirewallError(
      `SYSTEM FAILURE: timeframe firewall tripped. Requested range ` +
        `${String(multiplier)}/${String(timespan)}; only exactly ` +
        `${REQUIRED_MULTIPLIER}/${REQUIRED_TIMESPAN} is permitted.`,
    );
  }
}

type AlpacaBar = { t: string; o: number; h: number; l: number; c: number; v: number };

type AlpacaResponse = {
  bars?: unknown;
  next_page_token?: string | null;
  message?: string;
};

function isAlpacaBar(x: unknown): x is AlpacaBar {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.t === "string" &&
    (["o", "h", "l", "c", "v"] as const).every(
      (k) => typeof r[k] === "number" && Number.isFinite(r[k] as number),
    )
  );
}

/**
 * Alpaca RFC-3339 timestamp -> 'YYYY-MM-DD'.
 * Daily bars are stamped at midnight US Eastern (04:00/05:00 UTC), so the UTC
 * calendar date is the session date.
 */
function timestampToDate(t: string): string | null {
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

/** o/h/l/c/v/t -> open/high/low/close/volume/date. Rejects anything malformed. */
export function mapAlpacaBars(bars: unknown): Bar[] {
  if (!Array.isArray(bars)) {
    throw new MarketApiError("BAD_RESPONSE", "Alpaca returned an unexpected payload.", 502);
  }
  return bars.map((r, i) => {
    const date = isAlpacaBar(r) ? timestampToDate(r.t) : null;
    if (!isAlpacaBar(r) || date === null) {
      throw new MarketApiError("BAD_RESPONSE", `Alpaca bar ${i} is malformed.`, 502);
    }
    return {
      date,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
    };
  });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function readFeed(): (typeof ALLOWED_FEEDS)[number] {
  const raw = (process.env.ALPACA_DATA_FEED ?? "iex").trim().toLowerCase();
  if (!(ALLOWED_FEEDS as readonly string[]).includes(raw)) {
    throw new MarketApiError(
      "BAD_CONFIG",
      `ALPACA_DATA_FEED must be "iex" or "sip" (got "${raw}").`,
      500,
    );
  }
  return raw as (typeof ALLOWED_FEEDS)[number];
}

async function safeMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : "";
  } catch {
    return "";
  }
}

export async function fetchRealMarketData(
  ticker: string,
  range: { multiplier?: number; timespan?: string } = {},
): Promise<Bar[]> {
  // 1) Firewall first: nothing else runs if the range is not exactly 1 day.
  const multiplier = range.multiplier ?? REQUIRED_MULTIPLIER;
  const timespan = range.timespan ?? REQUIRED_TIMESPAN;
  assertDailyRange(multiplier, timespan);
  const timeframe = ALPACA_DAILY_TIMEFRAME; // 1 x day, the only value ever sent

  // 2) Inputs.
  const symbol = normalizeTicker(ticker);
  if (!symbol) {
    throw new MarketApiError(
      "BAD_TICKER",
      "Enter a valid stock ticker (1-5 letters, e.g. NVDA, TSLA, SPY).",
      400,
    );
  }
  const keyId = process.env.ALPACA_API_KEY_ID?.trim();
  const secret = process.env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secret) {
    throw new MarketApiError(
      "NO_API_KEY",
      process.env.VERCEL
        ? "ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set. Add them in Vercel → Project → Settings → Environment Variables, then Redeploy."
        : "ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set. Add them to .env.local and restart the dev server.",
      500,
    );
  }
  const feed = readFeed();

  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_CALENDAR_DAYS * 86_400_000);

  const url = new URL(ALPACA_BARS_URL);
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("timeframe", timeframe);
  url.searchParams.set("start", isoDate(start));
  url.searchParams.set("end", isoDate(end));
  url.searchParams.set("adjustment", "split");
  url.searchParams.set("feed", feed);
  url.searchParams.set("sort", "asc");
  url.searchParams.set("limit", String(REQUEST_LIMIT));

  // 3) Network. Credentials travel in headers; nothing secret is in the URL.
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new MarketApiError(
      "NETWORK",
      "Could not reach Alpaca (network error or timeout). Try again.",
      504,
    );
  }

  if (res.status === 429) {
    throw new MarketApiError(
      "RATE_LIMIT",
      "Alpaca rate limit reached (about 200 requests/minute on free plans). Wait a moment and retry.",
      429,
    );
  }
  if (res.status === 401) {
    throw new MarketApiError(
      "AUTH",
      "Alpaca rejected the API key ID/secret (missing or invalid). Check .env.local.",
      502,
    );
  }
  if (res.status === 403) {
    const detail = await safeMessage(res);
    throw new MarketApiError(
      "AUTH",
      `Alpaca denied access to the "${feed}" feed${detail ? `: ${detail}` : "."} ` +
        `On free plans set ALPACA_DATA_FEED=iex.`,
      502,
    );
  }
  if (res.status === 400 || res.status === 422) {
    const detail = await safeMessage(res);
    throw new MarketApiError(
      "NOT_FOUND",
      `Alpaca could not process ${symbol}${detail ? `: ${detail}` : "."} Check the symbol.`,
      400,
    );
  }
  if (!res.ok) {
    throw new MarketApiError("UPSTREAM", `Alpaca returned HTTP ${res.status}.`, 502);
  }

  let body: AlpacaResponse;
  try {
    body = (await res.json()) as AlpacaResponse;
  } catch {
    throw new MarketApiError("BAD_RESPONSE", "Alpaca returned invalid JSON.", 502);
  }
  if (typeof body !== "object" || body === null) {
    throw new MarketApiError("BAD_RESPONSE", "Alpaca returned an unexpected payload.", 502);
  }

  // Sorted ascending, so a truncated page would silently DROP the newest bars.
  // Refuse rather than analyse stale history as if it were current.
  if (body.next_page_token) {
    throw new MarketApiError(
      "BAD_RESPONSE",
      "Alpaca returned a partial page of history; refusing to analyse incomplete data.",
      502,
    );
  }

  const bySymbol =
    typeof body.bars === "object" && body.bars !== null && !Array.isArray(body.bars)
      ? (body.bars as Record<string, unknown>)
      : null;
  const raw = bySymbol?.[symbol];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MarketApiError(
      "NOT_FOUND",
      `No daily bars returned for ${symbol}. Check the symbol.`,
      404,
    );
  }

  // 4) Map, then verify with the same validator the engine uses.
  const bars = mapAlpacaBars(raw);
  try {
    validateBars(bars);
  } catch (e) {
    throw new MarketApiError(
      "BAD_DATA",
      `Alpaca data failed validation: ${e instanceof Error ? e.message : "unknown"}`,
      502,
    );
  }
  return bars;
}

/**
 * Market bars plus the matching daily crowd-sentiment array.
 *
 * Runs alongside the Alpaca fetch: every returned bar date gets a sentiment
 * day. The sentiment half is LIVE news-headline keyword scoring (see
 * sentimentEngine.ts, Alpaca News). It is best-effort: it never throws, and on
 * any feed failure every day comes back as an unavailable Apathy (0), so the
 * real bars are never discarded.
 */
export async function fetchMarketDataWithSentiment(
  ticker: string,
  range: { multiplier?: number; timespan?: string } = {},
): Promise<{ bars: Bar[]; sentiment: SentimentDay[] }> {
  const bars = await fetchRealMarketData(ticker, range); // firewall + validation live here

  let sentiment: SentimentDay[] = [];
  try {
    sentiment = await calculateSentimentPolarity(
      ticker,
      bars.map((b) => b.date),
    );
  } catch (e) {
    console.error("Sentiment overlay unavailable:", e instanceof Error ? e.name : "unknown");
  }
  return { bars, sentiment };
}
