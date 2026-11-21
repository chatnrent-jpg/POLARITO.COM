/**
 * Read the SPY options chain through the read-only Alpaca client (no order endpoint is reachable from here).
 * Selection rules live in optionsSelect.ts; this file only fetches, validates shapes and applies them.
 */
import type { OptionType } from "@/lib/broker/options";
import type { BrokerErrorCode, Result } from "@/lib/broker/types";
import type { ReadOnlyClient, ReadOnlyHost } from "@/lib/alpacaReadOnly";
import {
  DEFAULT_MODEL,
  assertContractRules,
  DELTA_THRESHOLDS,
  MIN_ABS_DELTA,
  MIN_DAYS_TO_EXPIRY,
  buildRow,
  earliestExpiry,
  pickDeepItm,
  type ChainRow,
  type PickResult,
  type PricingModel,
  type RawOptionSnapshot,
} from "@/lib/optionsSelect";
import { addDays, daysBetween, parseOccSymbol } from "@/lib/broker/options";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const fail = <T>(code: BrokerErrorCode, error: string): Result<T, BrokerErrorCode> => ({ ok: false, code, error });

/** Today's date in New York (YYYY-MM-DD). */
export function newYorkDate(now: Date): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export type AccountSummary = {
  status: string;
  tradingBlocked: boolean;
  accountBlocked: boolean;
  equity: number | null;
  cash: number | null;
  buyingPower: number | null;
  optionsBuyingPower: number | null;
  optionsApprovedLevel: number | null;
  optionsTradingLevel: number | null;
  multiplier: number | null;
  /** Names (never values other than "null") of the option-related fields Alpaca sent, so the report can say what was missing. */
  optionsFieldsSeen: string[];
};

/** Only the fields Henry needs. The account number and id are never copied. */
export function parseAccountSummary(data: unknown): AccountSummary | null {
  if (!isRecord(data) || typeof data.status !== "string") return null;
  return {
    status: data.status,
    tradingBlocked: data.trading_blocked === true,
    accountBlocked: data.account_blocked === true,
    equity: num(data.equity),
    cash: num(data.cash),
    buyingPower: num(data.buying_power),
    optionsBuyingPower: num(data.options_buying_power),
    optionsApprovedLevel: num(data.options_approved_level),
    optionsTradingLevel: num(data.options_trading_level),
    multiplier: num(data.multiplier),
    optionsFieldsSeen: Object.keys(data)
      .filter((k) => /option/i.test(k))
      .sort()
      .map((k) => (data[k] === null || data[k] === undefined ? `${k} (null)` : k)),
  };
}

export async function readAccount(client: ReadOnlyClient, host: ReadOnlyHost): Promise<Result<AccountSummary, BrokerErrorCode>> {
  const res = await client.get(host, "/v2/account");
  if (!res.ok) return res;
  const s = res.value.status === 200 ? parseAccountSummary(res.value.data) : null;
  return s ? { ok: true, value: s } : fail("MALFORMED", "Unexpected account response.");
}

export type Spot = { price: number; at: string; feed: string };

/** Latest SPY trade. Tries each feed in order and uses the first the plan allows. */
export async function readSpot(client: ReadOnlyClient, symbol: string, feeds: readonly string[]): Promise<Result<Spot, BrokerErrorCode>> {
  let lastError = "no feed tried";
  for (const feed of feeds) {
    const res = await client.get("data", `/v2/stocks/${symbol}/trades/latest`, { feed });
    if (!res.ok) {
      lastError = res.error;
      continue;
    }
    const d = res.value.data;
    const trade = isRecord(d) && isRecord(d.trade) ? d.trade : null;
    const price = trade ? num(trade.p) : null;
    const at = trade && typeof trade.t === "string" ? trade.t : null;
    if (res.value.status === 200 && price !== null && price > 0 && at !== null) return { ok: true, value: { price, at, feed } };
    lastError = "Unexpected latest-trade response.";
  }
  return fail("MALFORMED", `Could not read the ${symbol} price (${lastError}).`);
}

const CONTRACT_PAGES_MAX = 10;
const SNAPSHOT_PAGES_MAX = 10;

/** Every listed expiry (tradable contracts) for one side inside a date and strike window. */
export async function listExpirations(
  client: ReadOnlyClient,
  host: ReadOnlyHost,
  symbol: string,
  type: OptionType,
  window: { from: string; to: string; strikeLow: number; strikeHigh: number },
): Promise<Result<string[], BrokerErrorCode>> {
  const found = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 0; page < CONTRACT_PAGES_MAX; page++) {
    const params: Record<string, string> = {
      underlying_symbols: symbol,
      type,
      status: "active",
      expiration_date_gte: window.from,
      expiration_date_lte: window.to,
      strike_price_gte: String(Math.floor(window.strikeLow)),
      strike_price_lte: String(Math.ceil(window.strikeHigh)),
      limit: "1000",
    };
    if (pageToken) params.page_token = pageToken;
    const res = await client.get(host, "/v2/options/contracts", params);
    if (!res.ok) return res;
    const d = res.value.data;
    if (res.value.status !== 200 || !isRecord(d) || !Array.isArray(d.option_contracts)) return fail("MALFORMED", "Unexpected option contracts response.");
    for (const c of d.option_contracts) {
      if (isRecord(c) && c.tradable === true && typeof c.expiration_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.expiration_date)) found.add(c.expiration_date);
    }
    pageToken = typeof d.next_page_token === "string" && d.next_page_token ? d.next_page_token : null;
    if (!pageToken) return { ok: true, value: [...found].sort() };
  }
  return fail("MALFORMED", "Too many pages of option contracts; refusing to use a partial list.");
}

export function parseSnapshot(symbol: string, snap: unknown): RawOptionSnapshot {
  const s = isRecord(snap) ? snap : {};
  const q = isRecord(s.latestQuote) ? s.latestQuote : {};
  const g = isRecord(s.greeks) ? s.greeks : {};
  return {
    symbol,
    bid: num(q.bp),
    ask: num(q.ap),
    quoteAt: typeof q.t === "string" ? q.t : null,
    delta: num(g.delta),
    iv: num(s.impliedVolatility),
  };
}

/** Raw snapshots (quote + greeks) for one side and one expiry. */
export async function readSnapshots(
  client: ReadOnlyClient,
  symbol: string,
  type: OptionType,
  expiry: string | { from: string; to: string },
  strikeLow: number,
  strikeHigh: number,
  feed: string,
): Promise<Result<RawOptionSnapshot[], BrokerErrorCode>> {
  const out: RawOptionSnapshot[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < SNAPSHOT_PAGES_MAX; page++) {
    const params: Record<string, string> = {
      feed,
      type,
      ...(typeof expiry === "string" ? { expiration_date: expiry } : { expiration_date_gte: expiry.from, expiration_date_lte: expiry.to }),
      strike_price_gte: String(Math.floor(strikeLow)),
      strike_price_lte: String(Math.ceil(strikeHigh)),
      limit: "1000",
    };
    if (pageToken) params.page_token = pageToken;
    const res = await client.get("data", `/v1beta1/options/snapshots/${symbol}`, params);
    if (!res.ok) return res;
    const d = res.value.data;
    if (res.value.status !== 200 || !isRecord(d) || !isRecord(d.snapshots)) return fail("MALFORMED", "Unexpected option snapshots response.");
    for (const [sym, snap] of Object.entries(d.snapshots)) out.push(parseSnapshot(sym, snap));
    pageToken = typeof d.next_page_token === "string" && d.next_page_token ? d.next_page_token : null;
    if (!pageToken) return { ok: true, value: out };
  }
  return fail("MALFORMED", "Too many pages of option snapshots; refusing to use a partial chain.");
}

/** Information only: what a LATER qualifying expiry would offer. It is never selected (the nearest listed expiry is the only one used). */
export type LaterExpiry = {
  expiration: string;
  daysToExpiry: number;
  rowsBuilt: number;
  /** Contracts at this expiry that meet every hard rule (|delta| >= 0.80, spread, quote). */
  meetingRules: number;
  /** The row with the highest |delta| at this expiry, whatever the other rules say. */
  highestAbsDelta: ChainRow | null;
  error: string | null;
};

export type SideReport = {
  type: OptionType;
  listedExpirations: string[];
  pick: PickResult;
  /** Usable rows of the chosen expiry with |delta| between 0.5 and 1.0, closest to the 0.80 rule first, for context. */
  ladder: ChainRow[];
  /** The usable row with the highest |delta| at the chosen expiry, whether or not it meets the other rules. */
  highestAbsDelta: ChainRow | null;
  /** The strike window requested, and what the usable rows actually covered. */
  window: { low: number; high: number };
  strikesRead: { count: number; min: number | null; max: number | null };
  /** Filled only when the nearest expiry gave no contract: what later qualifying expiries offer (information only). */
  later: LaterExpiry[];
  rowsBuilt: number;
  rejected: Record<string, number>;
  error: string | null;
};

export type ChainOptions = {
  symbol: string;
  today: string;
  now: Date;
  spot: number;
  optionsFeed: string;
  /** The trading host whose account answered; null when none did (then expiries come from option snapshots). */
  contractsHost: ReadOnlyHost | null;
  model?: PricingModel;
};

/** Deep in the money: calls below the price, puts above it. The put side reaches 3x the price so a far strike is never cut off. */
export const strikeRange = (type: OptionType, spot: number): { low: number; high: number } =>
  type === "call" ? { low: spot * 0.5, high: spot * 1.0 } : { low: spot * 1.0, high: spot * 3.0 };

const LATER_EXPIRIES_MAX = 4;

function buildRows(snaps: ReadonlyArray<RawOptionSnapshot>, spot: number, today: string, now: Date, model: PricingModel, rejected?: Record<string, number>): ChainRow[] {
  const rows: ChainRow[] = [];
  for (const raw of snaps) {
    const r = buildRow(raw, spot, today, now, model);
    if (r.ok) rows.push(r.row);
    else if (rejected) {
      const key = r.reason.replace(/[0-9]+(\.[0-9]+)?/g, "#");
      rejected[key] = (rejected[key] ?? 0) + 1;
    }
  }
  return rows;
}

const highest = (rows: readonly ChainRow[]): ChainRow | null => rows.reduce<ChainRow | null>((m, r) => (m === null || Math.abs(r.delta) > Math.abs(m.delta) ? r : m), null);

/** One side (call or put): nearest listed expiry >= 365 days, then the delta >= 0.80 pick. Never throws. */
export async function readSide(client: ReadOnlyClient, type: OptionType, o: ChainOptions): Promise<SideReport> {
  const model = o.model ?? DEFAULT_MODEL;
  const { low, high } = strikeRange(type, o.spot);
  const base: SideReport = { type, listedExpirations: [], pick: { ok: false, reason: "not run", expiration: null }, ladder: [], highestAbsDelta: null, window: { low, high }, strikesRead: { count: 0, min: null, max: null }, later: [], rowsBuilt: 0, rejected: {}, error: null };
  try {
    const from = earliestExpiry(o.today);
    const to = addDays(from, 400);
    let listed: string[] = [];
    if (o.contractsHost) {
      const res = await listExpirations(client, o.contractsHost, o.symbol, type, { from, to, strikeLow: low, strikeHigh: high });
      if (!res.ok) return { ...base, error: `Listing expiries failed: ${res.error}` };
      listed = res.value;
    } else {
      const res = await readSnapshots(client, o.symbol, type, { from, to }, low, high, o.optionsFeed);
      if (!res.ok) return { ...base, error: `Listing expiries from quotes failed: ${res.error}` };
      listed = [...new Set(res.value.map((r) => parseOccSymbol(r.symbol)?.expiration).filter((e): e is string => !!e))].sort();
    }
    base.listedExpirations = listed;
    const probe = listed.find((e) => e >= from) ?? null;
    if (probe === null) return { ...base, pick: pickDeepItm([], listed, type, o.today) };
    const snaps = await readSnapshots(client, o.symbol, type, probe, low, high, o.optionsFeed);
    if (!snaps.ok) return { ...base, error: `Reading quotes failed: ${snaps.error}` };
    const rows = buildRows(snaps.value, o.spot, o.today, o.now, model, base.rejected);
    base.rowsBuilt = rows.length;
    base.pick = pickDeepItm(rows, listed, type, o.today);
    base.highestAbsDelta = highest(rows);
    const strikes = rows.map((r) => r.strike);
    base.strikesRead = { count: rows.length, min: strikes.length ? Math.min(...strikes) : null, max: strikes.length ? Math.max(...strikes) : null };
    base.ladder = rows
      .filter((r) => Math.abs(r.delta) >= 0.5 && Math.abs(r.delta) <= 1)
      .sort((a, b) => Math.abs(Math.abs(a.delta) - MIN_ABS_DELTA) - Math.abs(Math.abs(b.delta) - MIN_ABS_DELTA) || a.strike - b.strike);

    if (!base.pick.ok && base.pick.expiration !== null) {
      for (const exp of listed.filter((e) => e >= from && e !== probe).slice(0, LATER_EXPIRIES_MAX)) {
        const res = await readSnapshots(client, o.symbol, type, exp, low, high, o.optionsFeed);
        if (!res.ok) {
          base.later.push({ expiration: exp, daysToExpiry: daysBetween(o.today, exp), rowsBuilt: 0, meetingRules: 0, highestAbsDelta: null, error: res.error });
          continue;
        }
        const later = buildRows(res.value, o.spot, o.today, o.now, model);
        base.later.push({
          expiration: exp,
          daysToExpiry: daysBetween(o.today, exp),
          rowsBuilt: later.length,
          meetingRules: later.filter((r) => assertContractRules(r, type, o.today) === null).length,
          highestAbsDelta: highest(later),
          error: null,
        });
      }
    }
    return base;
  } catch {
    return { ...base, error: "Unexpected error while reading the chain." };
  }
}

export const RULES_TEXT = `expiry at least ${MIN_DAYS_TO_EXPIRY} days out (nearest listed), |delta| >= ${MIN_ABS_DELTA}, else the best usable |delta| down to a hard floor of ${DELTA_THRESHOLDS.floor} (marked as a fallback)`;
