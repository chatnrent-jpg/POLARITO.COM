/**
 * Shared Alpaca daily-history loader for the research scripts.
 * Paginated fetch (daily bars only, total-return adjusted) + on-disk cache in
 * data/bars/<feed>/. Credentials come from the environment (.env.local) and go
 * out as headers only; nothing secret is cached.
 */
import fs from "node:fs";
import path from "node:path";
import { validateBars, type Bar } from "../src/lib/polarity";
import { mapAlpacaBars } from "../src/lib/marketApi";

export type LoadOpts = { feed: "iex" | "sip"; start: string; refresh: boolean };
const ROOT = path.resolve(__dirname, "..");
const BARS_URL = "https://data.alpaca.markets/v2/stocks/bars";
const MAX_PAGES = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchHistory(ticker: string, start: string, end: string, feed: string): Promise<Bar[]> {
  const keyId = process.env.ALPACA_API_KEY_ID?.trim();
  const secret = process.env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secret) {
    throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY missing (expected in .env.local).");
  }
  const raw: unknown[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(BARS_URL);
    url.searchParams.set("symbols", ticker);
    url.searchParams.set("timeframe", "1Day"); // daily only, same as the live app
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("adjustment", "all"); // splits + dividends: total-return prices
    url.searchParams.set("feed", feed);
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", "10000");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    type Page = { bars?: Record<string, unknown[]>; next_page_token?: string | null };
    let body = null as Page | null;
    for (let attempt = 0; attempt < 4 && body === null; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "APCA-API-KEY-ID": keyId,
            "APCA-API-SECRET-KEY": secret,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error(`${ticker}: network error or timeout talking to Alpaca.`);
      }
      if (res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `${ticker}: Alpaca rejected the credentials/feed (HTTP ${res.status}). ` +
            `If you rotated keys, update .env.local. On free plans use --feed=iex.`,
        );
      }
      if (!res.ok) throw new Error(`${ticker}: Alpaca returned HTTP ${res.status}.`);
      try {
        body = (await res.json()) as Page;
      } catch {
        throw new Error(`${ticker}: Alpaca returned invalid JSON.`);
      }
    }
    if (body === null) throw new Error(`${ticker}: rate-limited by Alpaca after 4 attempts.`);

    const rows = body.bars?.[ticker];
    if (Array.isArray(rows)) raw.push(...rows);
    pageToken = body.next_page_token ?? null;
    if (!pageToken) break;
    if (page === MAX_PAGES - 1) {
      throw new Error(`${ticker}: exceeded ${MAX_PAGES} pages; refusing to use partial history.`);
    }
  }

  if (raw.length === 0) throw new Error(`${ticker}: no bars returned.`);
  const bars = mapAlpacaBars(raw);
  validateBars(bars); // same validator the live engine uses; throws on bad data
  return bars;
}

export async function loadBars(ticker: string, a: LoadOpts, end: string): Promise<{ bars: Bar[]; cached: boolean }> {
  const dir = path.join(ROOT, "data", "bars", a.feed);
  const file = path.join(dir, `${ticker}_${a.start}.json`);
  if (!a.refresh && fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { bars: Bar[] };
      validateBars(parsed.bars);
      return { bars: parsed.bars, cached: true };
    } catch {
      // corrupt/stale cache: fall through and refetch
    }
  }
  const bars = await fetchHistory(ticker, a.start, end, a.feed);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ticker, feed: a.feed, start: a.start, end, bars }));
  return { bars, cached: false };
}


