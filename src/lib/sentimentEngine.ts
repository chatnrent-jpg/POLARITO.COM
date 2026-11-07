/**
 * Crowd Sentiment engine: live news headlines -> the 1 / 0 / -1 framework.
 *
 *   +1  DRIVING  : bullish headline keywords clearly outnumber bearish ones
 *    0  APATHY   : balanced, too few keywords, no news, or feed unavailable
 *   -1  REVERSE  : bearish headline keywords clearly outnumber bullish ones
 *
 * Source: Alpaca News API (https://data.alpaca.markets/v1beta1/news), read with
 * the same ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY the market data uses.
 * Server side only; the keys go in request headers and never reach the browser.
 *
 * Honesty rules
 *  - Every headline counted is a real article returned by the feed.
 *  - A day inside the fetched window with no articles is a real Apathy (0).
 *  - A day the feed could not cover (failure, rate limit, older than the window
 *    we could page back to) is also 0, but is marked `source: "unavailable"` so
 *    the UI never presents it as a live reading.
 *  - `calculateSentimentPolarity` never throws; failure => unavailable days.
 */
import type { Polarity } from "@/lib/polarity";
import { normalizeTicker } from "@/lib/ticker";

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/** |velocity| must exceed this to leave Neutral. */
export const SENTIMENT_BAND = 0.2;
/** Fewer matched keywords than this in a day is too thin to call (Neutral). */
export const MIN_KEYWORD_HITS = 2;

/** Base forms; inflections (surges, surged, surging, dropped...) are matched too. */
export const BULLISH_KEYWORDS = [
  "surge",
  "growth",
  "buy",
  "bullish",
  "upgrade",
  "profit",
  "shatter",
  "beat",
] as const;
export const BEARISH_KEYWORDS = [
  "drop",
  "plunge",
  "sell",
  "bearish",
  "downgrade",
  "loss",
  "miss",
  "risk",
  "fall",
] as const;

function forms(base: string): string[] {
  const last = base[base.length - 1];
  const out = [base, `${base}s`, `${base}es`, `${base}d`, `${base}ed`, `${base}ing`];
  if (base.endsWith("e")) out.push(`${base.slice(0, -1)}ing`); // surge -> surging
  out.push(`${base}${last}ed`, `${base}${last}ing`); // drop -> dropped, dropping
  return out;
}

function buildLookup(words: readonly string[]): ReadonlySet<string> {
  return new Set(words.flatMap(forms));
}
const BULLISH = buildLookup(BULLISH_KEYWORDS);
const BEARISH = buildLookup(BEARISH_KEYWORDS);

/** Keyword hits in one headline (whole words only, case-insensitive). */
export function scoreHeadline(text: string): { positive: number; negative: number } {
  let positive = 0;
  let negative = 0;
  if (typeof text !== "string") return { positive, negative };
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (BULLISH.has(word)) positive += 1;
    else if (BEARISH.has(word)) negative += 1;
  }
  return { positive, negative };
}

/** (positive - negative) / (positive + negative), in [-1, 1]; 0 if no hits. */
export function textVelocity(positive: number, negative: number): number {
  const total = positive + negative;
  return total > 0 ? (positive - negative) / total : 0;
}

/** Strict gate; thin evidence or anything inside the band is Neutral. */
export function classifySentiment(
  positive: number,
  negative: number,
): { polarity: Polarity; velocity: number } {
  const velocity = textVelocity(positive, negative);
  if (positive + negative < MIN_KEYWORD_HITS) return { polarity: 0, velocity };
  if (velocity > SENTIMENT_BAND) return { polarity: 1, velocity };
  if (velocity < -SENTIMENT_BAND) return { polarity: -1, velocity };
  return { polarity: 0, velocity };
}

/* ------------------------------------------------------------------ */
/* Types + display                                                     */
/* ------------------------------------------------------------------ */

/** "news" = a real reading from the live feed; "unavailable" = defaulted to 0. */
export type SentimentSource = "news" | "unavailable";

export type SentimentDay = {
  date: string;
  positiveHits: number;
  negativeHits: number;
  /** Articles counted for this day. */
  articles: number;
  /** Text velocity in [-1, 1]. */
  velocity: number;
  polarity: Polarity;
  source: SentimentSource;
};

export type SentimentMeta = {
  value: Polarity;
  label: "DRIVING" | "APATHY" | "REVERSE";
  display: "+1" | "0" | "-1";
  text: string;
  hex: string;
};

export const SENTIMENT_META: Readonly<Record<"1" | "0" | "-1", SentimentMeta>> =
  Object.freeze({
    "1": { value: 1, label: "DRIVING", display: "+1", text: "text-green-400", hex: "#22c55e" },
    "0": { value: 0, label: "APATHY", display: "0", text: "text-slate-200", hex: "#94a3b8" },
    "-1": { value: -1, label: "REVERSE", display: "-1", text: "text-red-400", hex: "#ef4444" },
  });

export function sentimentMeta(p: Polarity): SentimentMeta {
  return SENTIMENT_META[String(p) as "1" | "0" | "-1"];
}

/* ------------------------------------------------------------------ */
/* Live feed (Alpaca News)                                             */
/* ------------------------------------------------------------------ */

const ALPACA_NEWS_URL = "https://data.alpaca.markets/v1beta1/news";
const PAGE_SIZE = 50; // Alpaca maximum
/** Newest-first pages to read. ~500 articles: weeks for a hot ticker, months for a quiet one. */
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 8_000;
const TOTAL_TIMEOUT_MS = 20_000;
/** Roundups tagging many tickers say little about any one of them. */
const MAX_SYMBOLS_PER_ARTICLE = 5;
const DAY_MS = 86_400_000;

type NewsArticle = { id: string; createdAt: string; headline: string; symbolCount: number };

const etFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Timestamp -> US Eastern calendar date (the market's session date), or null. */
function easternDate(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : etFormat.format(new Date(ms));
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => isoDay(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS);

function parseArticles(body: unknown): { articles: NewsArticle[]; nextToken: string | null } {
  if (typeof body !== "object" || body === null) throw new Error("unexpected payload");
  const b = body as { news?: unknown; next_page_token?: unknown };
  if (!Array.isArray(b.news)) throw new Error("unexpected payload");
  const articles: NewsArticle[] = [];
  for (const item of b.news) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as Record<string, unknown>;
    if (
      (typeof a.id !== "string" && typeof a.id !== "number") ||
      typeof a.created_at !== "string" ||
      typeof a.headline !== "string"
    ) {
      continue;
    }
    articles.push({
      id: String(a.id),
      createdAt: a.created_at,
      headline: a.headline,
      symbolCount: Array.isArray(a.symbols) ? a.symbols.length : 1,
    });
  }
  return {
    articles,
    nextToken: typeof b.next_page_token === "string" && b.next_page_token ? b.next_page_token : null,
  };
}

/**
 * Newest-first articles for `symbol` from `startDate` on, plus whether paging
 * stopped before reaching `startDate` (so older days are not covered).
 */
async function fetchNews(
  symbol: string,
  startDate: string,
): Promise<{ articles: NewsArticle[]; truncated: boolean }> {
  const keyId = process.env.ALPACA_API_KEY_ID?.trim();
  const secret = process.env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secret) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set");

  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const seen = new Set<string>();
  const articles: NewsArticle[] = [];
  let token: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(ALPACA_NEWS_URL);
    url.searchParams.set("symbols", symbol);
    url.searchParams.set("start", `${addDays(startDate, -1)}T00:00:00Z`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("sort", "desc");
    url.searchParams.set("include_content", "false");
    if (token) url.searchParams.set("page_token", token);

    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (res.status === 429) throw new Error("rate limited (HTTP 429)");
    if (res.status === 401 || res.status === 403) throw new Error(`access denied (HTTP ${res.status})`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const parsed = parseArticles(await res.json());
    for (const a of parsed.articles) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        articles.push(a);
      }
    }
    token = parsed.nextToken;
    if (!token) return { articles, truncated: false };
  }
  return { articles, truncated: true };
}

const unavailableDay = (date: string): SentimentDay => ({
  date,
  positiveHits: 0,
  negativeHits: 0,
  articles: 0,
  velocity: 0,
  polarity: 0,
  source: "unavailable",
});

/**
 * Daily crowd-sentiment series for `ticker`, one entry per date given.
 *
 * Each article is counted on the US Eastern date it was published. An article
 * published on a non-trading day (weekend/holiday) counts toward the next
 * trading date in `dates`. Never throws: any failure (no keys, rate limit,
 * network, bad payload) is logged and every day comes back as an unavailable
 * Apathy (0), so callers and the chart keep working.
 */
export async function calculateSentimentPolarity(
  ticker: string,
  dates: readonly string[],
): Promise<SentimentDay[]> {
  const valid = [...new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  const fallback = () => valid.map(unavailableDay);

  const symbol = normalizeTicker(ticker);
  if (!symbol) {
    console.error("Sentiment: invalid ticker; defaulting to Apathy (0).");
    return fallback();
  }
  if (valid.length === 0) return [];
  if (typeof window !== "undefined") {
    console.error("Sentiment: the news feed is server-side only; defaulting to Apathy (0).");
    return fallback();
  }

  try {
    const { articles, truncated } = await fetchNews(symbol, valid[0]);

    // Oldest article's day may be only partly read when we stopped paging early.
    let oldest: string | null = null;
    for (const a of articles) {
      const d = easternDate(a.createdAt);
      if (d && (oldest === null || d < oldest)) oldest = d;
    }
    const coverageStart = truncated && oldest ? addDays(oldest, 1) : valid[0];

    const buckets = new Map<string, { positive: number; negative: number; articles: number }>();
    for (const a of articles) {
      if (a.symbolCount > MAX_SYMBOLS_PER_ARTICLE) continue;
      const published = easternDate(a.createdAt);
      if (!published || published < coverageStart) continue;
      const target = valid.find((d) => d >= published); // same day, else next trading day
      if (!target) continue; // after the last bar: no bar to attach to
      const { positive, negative } = scoreHeadline(a.headline);
      const b = buckets.get(target) ?? { positive: 0, negative: 0, articles: 0 };
      b.positive += positive;
      b.negative += negative;
      b.articles += 1;
      buckets.set(target, b);
    }

    return valid.map((date): SentimentDay => {
      if (date < coverageStart) return unavailableDay(date);
      const b = buckets.get(date) ?? { positive: 0, negative: 0, articles: 0 };
      const { polarity, velocity } = classifySentiment(b.positive, b.negative);
      return {
        date,
        positiveHits: b.positive,
        negativeHits: b.negative,
        articles: b.articles,
        velocity,
        polarity,
        source: "news",
      };
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "unknown error";
    console.error(`Sentiment news feed unavailable (${reason}); defaulting to Apathy (0).`);
    return fallback();
  }
}

/* ------------------------------------------------------------------ */
/* Consumer helpers                                                    */
/* ------------------------------------------------------------------ */

export type SentimentByDate = Readonly<Record<string, SentimentDay>>;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Turn untrusted payload data into a date -> SentimentDay map. Malformed
 * entries are dropped (never guessed at); lookups then fall back to Neutral.
 */
export function sanitizeSentiment(raw: unknown): SentimentByDate {
  const map: Record<string, SentimentDay> = {};
  if (!Array.isArray(raw)) return map;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.date !== "string" ||
      (r.polarity !== 1 && r.polarity !== 0 && r.polarity !== -1) ||
      (r.source !== "news" && r.source !== "unavailable") ||
      !isNum(r.velocity) ||
      !isNum(r.positiveHits) ||
      !isNum(r.negativeHits) ||
      !isNum(r.articles)
    ) {
      continue;
    }
    map[r.date] = {
      date: r.date,
      positiveHits: r.positiveHits,
      negativeHits: r.negativeHits,
      articles: r.articles,
      velocity: r.velocity,
      polarity: r.polarity,
      source: r.source,
    };
  }
  return map;
}

/** Sentiment polarity for a date; missing => 0 (Neutral). Never throws. */
export function sentimentPolarityFor(
  byDate: SentimentByDate | undefined,
  date: string,
): Polarity {
  return byDate?.[date]?.polarity ?? 0;
}

/** True if any day carries a real reading from the live feed. */
export function hasLiveSentiment(byDate: SentimentByDate | undefined): boolean {
  if (!byDate) return false;
  return Object.values(byDate).some((d) => d.source === "news");
}
