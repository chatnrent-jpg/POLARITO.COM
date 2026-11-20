/**
 * Alpaca PAPER trading adapter (server-side only).
 *
 * The base URL is a constant and is NOT configurable: this adapter cannot be
 * pointed at the live endpoint by an env var or a caller. Going live would be
 * a separate, deliberate code change. Credentials never appear in errors/logs.
 */
import {
  parseOccSymbol,
  type ContractQuery,
  type OptionContract,
  type OptionOrderRequest,
  type OptionQuote,
  type OptionsBroker,
} from "@/lib/broker/options";
import type {
  BrokerAccount,
  BrokerErrorCode,
  BrokerOrder,
  BrokerPosition,
  MarketOrderRequest,
  Result,
} from "@/lib/broker/types";

export const ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
/** Read-only market data host, also fixed. Used only for option quotes. */
export const ALPACA_DATA_BASE_URL = "https://data.alpaca.markets";
const CONTRACT_PAGES_MAX = 5;
export const DEFAULT_TIMEOUT_MS = 8_000;

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export type AlpacaPaperOptions = {
  keyId: string;
  secretKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

const fail = (code: BrokerErrorCode, error: string): Result<never, BrokerErrorCode> => ({
  ok: false,
  code,
  error,
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse a finite number from a JSON number or numeric string. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseOrder(v: unknown): BrokerOrder | null {
  if (!isRecord(v)) return null;
  const qty = num(v.qty);
  if (
    typeof v.id !== "string" ||
    typeof v.client_order_id !== "string" ||
    typeof v.status !== "string" ||
    typeof v.symbol !== "string" ||
    (v.side !== "buy" && v.side !== "sell") ||
    qty === null
  ) {
    return null;
  }
  return {
    id: v.id,
    clientOrderId: v.client_order_id,
    status: v.status,
    ticker: v.symbol,
    side: v.side,
    quantity: qty,
  };
}

function parsePosition(v: unknown): BrokerPosition | null {
  if (!isRecord(v)) return null;
  const qty = num(v.qty);
  const avg = num(v.avg_entry_price);
  if (typeof v.symbol !== "string" || qty === null || avg === null || qty === 0) return null;
  const side = v.side === "short" || v.side === "long" ? v.side : qty < 0 ? "short" : "long";
  return { ticker: v.symbol, side, quantity: Math.abs(qty), avgEntryPrice: avg };
}

/** An item is trusted only if every field agrees with its OCC symbol. */
function parseContract(v: unknown): OptionContract | null {
  if (!isRecord(v)) return null;
  const occ = parseOccSymbol(v.symbol);
  const strike = num(v.strike_price);
  if (
    !occ ||
    strike === null ||
    typeof v.symbol !== "string" ||
    typeof v.expiration_date !== "string" ||
    v.expiration_date !== occ.expiration ||
    v.type !== occ.type ||
    typeof v.tradable !== "boolean" ||
    Math.abs(strike - occ.strike) > 1e-6
  ) {
    return null;
  }
  return { symbol: v.symbol, underlying: occ.underlying, type: occ.type, strike, expiration: occ.expiration, tradable: v.tradable };
}

export class AlpacaPaperBroker implements OptionsBroker {
  private readonly keyId: string;
  private readonly secretKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: AlpacaPaperOptions) {
    if (!opts.keyId.trim() || !opts.secretKey.trim()) {
      throw new Error("Alpaca paper credentials are required.");
    }
    this.keyId = opts.keyId.trim();
    this.secretKey = opts.secretKey.trim();
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Never includes headers or credentials in the returned error. */
  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    baseUrl: string = ALPACA_PAPER_BASE_URL,
  ): Promise<Result<{ status: number; data: unknown }, BrokerErrorCode>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          "APCA-API-KEY-ID": this.keyId,
          "APCA-API-SECRET-KEY": this.secretKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok && res.status !== 404) {
        const message =
          isRecord(data) && typeof data.message === "string"
            ? data.message.slice(0, 200)
            : "no details";
        return fail(
          res.status === 403 || res.status === 422 ? "REJECTED" : "HTTP",
          `Alpaca paper API returned ${res.status}: ${message}`,
        );
      }
      return { ok: true, value: { status: res.status, data } };
    } catch (e) {
      if (controller.signal.aborted) return fail("TIMEOUT", "Alpaca paper API timed out.");
      return fail("NETWORK", `Alpaca paper API request failed (${e instanceof Error ? e.name : "error"}).`);
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccount(): Promise<Result<BrokerAccount, BrokerErrorCode>> {
    const res = await this.request("GET", "/v2/account");
    if (!res.ok) return res;
    const d = res.value.data;
    if (res.value.status !== 200 || !isRecord(d)) return fail("MALFORMED", "Unexpected account response.");
    const equity = num(d.equity);
    const lastEquity = num(d.last_equity);
    const cash = num(d.cash);
    const buyingPower = num(d.buying_power);
    if (
      typeof d.status !== "string" ||
      typeof d.trading_blocked !== "boolean" ||
      typeof d.account_blocked !== "boolean" ||
      equity === null ||
      lastEquity === null ||
      cash === null ||
      buyingPower === null
    ) {
      return fail("MALFORMED", "Account response failed validation.");
    }
    return {
      ok: true,
      value: {
        status: d.status,
        tradingBlocked: d.trading_blocked,
        accountBlocked: d.account_blocked,
        equity,
        lastEquity,
        cash,
        buyingPower,
      },
    };
  }

  async getPositions(): Promise<Result<BrokerPosition[], BrokerErrorCode>> {
    const res = await this.request("GET", "/v2/positions");
    if (!res.ok) return res;
    const d = res.value.data;
    if (res.value.status !== 200 || !Array.isArray(d)) {
      return fail("MALFORMED", "Unexpected positions response.");
    }
    const out: BrokerPosition[] = [];
    for (const item of d) {
      const p = parsePosition(item);
      if (!p) return fail("MALFORMED", "A position failed validation; refusing to trust the list.");
      out.push(p);
    }
    return { ok: true, value: out };
  }

  async getOrderByClientId(clientOrderId: string): Promise<Result<BrokerOrder | null, BrokerErrorCode>> {
    const res = await this.request(
      "GET",
      `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
    );
    if (!res.ok) return res;
    if (res.value.status === 404) return { ok: true, value: null };
    const order = parseOrder(res.value.data);
    return order ? { ok: true, value: order } : fail("MALFORMED", "Order response failed validation.");
  }

  async submitMarketOrder(req: MarketOrderRequest): Promise<Result<BrokerOrder, BrokerErrorCode>> {
    if (!Number.isSafeInteger(req.quantity) || req.quantity < 1) {
      return fail("REJECTED", "Order quantity must be a whole number of shares.");
    }
    const res = await this.request("POST", "/v2/orders", {
      symbol: req.ticker,
      qty: String(req.quantity),
      side: req.side,
      type: "market",
      time_in_force: req.timeInForce,
      client_order_id: req.clientOrderId,
    });
    if (!res.ok) return res;
    const order = parseOrder(res.value.data);
    return order ? { ok: true, value: order } : fail("MALFORMED", "Order response failed validation.");
  }

  async listContracts(q: ContractQuery): Promise<Result<OptionContract[], BrokerErrorCode>> {
    const out: OptionContract[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < CONTRACT_PAGES_MAX; page++) {
      const params = new URLSearchParams({
        underlying_symbols: q.underlying,
        type: q.type,
        status: "active",
        expiration_date_gte: q.expiresFrom,
        expiration_date_lte: q.expiresTo,
        strike_price_gte: String(q.strikeLow),
        strike_price_lte: String(q.strikeHigh),
        limit: "1000",
      });
      if (pageToken) params.set("page_token", pageToken);
      const res = await this.request("GET", `/v2/options/contracts?${params.toString()}`);
      if (!res.ok) return res;
      const d = res.value.data;
      if (res.value.status !== 200 || !isRecord(d) || !Array.isArray(d.option_contracts)) {
        return fail("MALFORMED", "Unexpected option contracts response.");
      }
      for (const item of d.option_contracts) {
        const c = parseContract(item);
        if (c) out.push(c);
      }
      pageToken = typeof d.next_page_token === "string" && d.next_page_token ? d.next_page_token : null;
      if (!pageToken) break;
    }
    return { ok: true, value: out };
  }

  async getOptionQuote(symbol: string): Promise<Result<OptionQuote | null, BrokerErrorCode>> {
    if (!parseOccSymbol(symbol)) return fail("REJECTED", "Not a valid option symbol.");
    const res = await this.request(
      "GET",
      `/v1beta1/options/snapshots?symbols=${encodeURIComponent(symbol)}&feed=indicative`,
      undefined,
      ALPACA_DATA_BASE_URL,
    );
    if (!res.ok) return res;
    if (res.value.status === 404) return { ok: true, value: null };
    const d = res.value.data;
    if (res.value.status !== 200 || !isRecord(d) || !isRecord(d.snapshots)) {
      return fail("MALFORMED", "Unexpected option snapshot response.");
    }
    const snap = d.snapshots[symbol];
    if (snap === undefined || snap === null) return { ok: true, value: null };
    if (!isRecord(snap) || !isRecord(snap.latestQuote)) return { ok: true, value: null };
    const bid = num(snap.latestQuote.bp);
    const ask = num(snap.latestQuote.ap);
    const at = snap.latestQuote.t;
    if (bid === null || ask === null || typeof at !== "string") {
      return fail("MALFORMED", "Option quote failed validation.");
    }
    return { ok: true, value: { symbol, bid, ask, at } };
  }

  async submitOptionOrder(req: OptionOrderRequest): Promise<Result<BrokerOrder, BrokerErrorCode>> {
    if (!parseOccSymbol(req.symbol)) return fail("REJECTED", "Not a valid option symbol.");
    if (!Number.isSafeInteger(req.quantity) || req.quantity < 1) {
      return fail("REJECTED", "Option quantity must be a whole number of contracts.");
    }
    if (req.type === "limit" && !(typeof req.limitPrice === "number" && req.limitPrice > 0)) {
      return fail("REJECTED", "A limit order needs a positive limit price.");
    }
    const res = await this.request("POST", "/v2/orders", {
      symbol: req.symbol,
      qty: String(req.quantity),
      side: req.side,
      type: req.type,
      time_in_force: "day",
      position_intent: req.positionIntent,
      client_order_id: req.clientOrderId,
      ...(req.type === "limit" ? { limit_price: (req.limitPrice as number).toFixed(2) } : {}),
    });
    if (!res.ok) return res;
    const order = parseOrder(res.value.data);
    return order ? { ok: true, value: order } : fail("MALFORMED", "Order response failed validation.");
  }
}
