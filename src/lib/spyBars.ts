/**
 * SPY stock bars (daily and 5-minute) through the read-only Alpaca client. GET only; no order endpoint is reachable.
 *
 * Daily bars use adjustment=split, the same as the live app (src/lib/marketApi.ts), so a period's open and close are
 * the real traded prices. The newest bar can be the session in progress.
 */
import type { BrokerErrorCode, Result } from "@/lib/broker/types";
import type { ReadOnlyClient } from "@/lib/alpacaReadOnly";
import { etClock } from "@/lib/marketCalendar";
import type { IntradayBar } from "@/lib/longPolarity";
import type { Bar } from "@/lib/polarity";

const BAR_PAGES_MAX = 12;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = <T>(code: BrokerErrorCode, error: string): Result<T, BrokerErrorCode> => ({ ok: false, code, error });
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

async function readBars(client: ReadOnlyClient, symbol: string, timeframe: "1Day" | "5Min", start: string, feed: string, end?: string): Promise<Result<unknown[], BrokerErrorCode>> {
  const rows: unknown[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < BAR_PAGES_MAX; page++) {
    const params: Record<string, string> = { symbols: symbol, timeframe, start, feed, adjustment: "split", sort: "asc", limit: "10000" };
    if (end) params.end = end;
    if (pageToken) params.page_token = pageToken;
    const res = await client.get("data", "/v2/stocks/bars", params);
    if (!res.ok) return res;
    const d = res.value.data;
    if (res.value.status !== 200 || !isRecord(d)) return fail("MALFORMED", "Unexpected bars response.");
    const list = isRecord(d.bars) ? d.bars[symbol] : null;
    if (Array.isArray(list)) rows.push(...list);
    else if (d.bars !== null && d.bars !== undefined && !isRecord(d.bars)) return fail("MALFORMED", "Unexpected bars payload.");
    pageToken = typeof d.next_page_token === "string" && d.next_page_token ? d.next_page_token : null;
    if (!pageToken) return { ok: true, value: rows };
  }
  return fail("MALFORMED", "Too many pages of bars; refusing to use partial history.");
}

/** Daily bars from `start` (YYYY-MM-DD) to now. The session date is the UTC date of the midnight-ET stamp. */
export async function loadDailyBars(client: ReadOnlyClient, symbol: string, start: string, feed: string): Promise<Result<Bar[], BrokerErrorCode>> {
  const res = await readBars(client, symbol, "1Day", start, feed);
  if (!res.ok) return res;
  const bars: Bar[] = [];
  for (const r of res.value) {
    if (!isRecord(r) || typeof r.t !== "string" || ![r.o, r.h, r.l, r.c, r.v].every(finite)) return fail("MALFORMED", "A daily bar is malformed.");
    const ms = Date.parse(r.t);
    if (!Number.isFinite(ms)) return fail("MALFORMED", "A daily bar has no valid timestamp.");
    bars.push({ date: new Date(ms).toISOString().slice(0, 10), open: r.o as number, high: r.h as number, low: r.l as number, close: r.c as number, volume: r.v as number });
  }
  if (bars.length === 0) return fail("MALFORMED", `No daily bars returned for ${symbol}.`);
  return { ok: true, value: bars };
}

/** 5-minute bars from `start` (YYYY-MM-DD, New York) to now, all hours the feed returns. */
export async function loadIntradayBars(client: ReadOnlyClient, symbol: string, start: string, feed: string): Promise<Result<IntradayBar[], BrokerErrorCode>> {
  const res = await readBars(client, symbol, "5Min", `${start}T00:00:00-05:00`, feed);
  if (!res.ok) return res;
  const bars: IntradayBar[] = [];
  for (const r of res.value) {
    if (!isRecord(r) || typeof r.t !== "string" || ![r.o, r.c, r.v].every(finite)) return fail("MALFORMED", "A 5-minute bar is malformed.");
    const ms = Date.parse(r.t);
    if (!Number.isFinite(ms)) return fail("MALFORMED", "A 5-minute bar has no valid timestamp.");
    bars.push({ t: new Date(ms).toISOString(), date: etClock(new Date(ms)).date, open: r.o as number, close: r.c as number, volume: r.v as number });
  }
  return { ok: true, value: bars };
}
