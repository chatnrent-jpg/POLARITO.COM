import type { AuditRecord } from "../../src/lib/audit";
import type { PaperBrokerConfig } from "../../src/lib/broker/config";
import type {
  BrokerAccount,
  BrokerAsset,
  BrokerErrorCode,
  BrokerOrder,
  BrokerPosition,
  LiveBroker,
  MarketOrderRequest,
  Result,
} from "../../src/lib/broker/types";
import type { LiveSettings } from "../../src/lib/liveSettings";
import { liveSettings } from "../../src/lib/liveSettings";
import type { PickDeps } from "../../src/lib/pickRunner";
import type { Bar } from "../../src/lib/polarity";

export const LIVE_ON: PaperBrokerConfig = { enabled: true, killed: false, configured: true };
// Thursday 2026-11-19, 15:00 New York (session open, before the 15:55 flatten).
export const MID_SESSION = new Date("2026-11-19T20:00:00Z");
export const TODAY = "2026-11-19";

export const ACCOUNT_1K: BrokerAccount = {
  status: "ACTIVE",
  tradingBlocked: false,
  accountBlocked: false,
  equity: 1_000,
  lastEquity: 1_000,
  cash: 1_000,
  buyingPower: 1_000,
  shortingEnabled: false,
  multiplier: 1,
};

const WORKING = new Set(["new", "accepted", "pending_new", "partially_filled", "accepted_for_bidding"]);

export class FakeLiveBroker implements LiveBroker {
  submitted: MarketOrderRequest[] = [];
  orders: BrokerOrder[] = [];
  /** Instant fill (market order in the session). When false the order stays working. */
  fill = true;
  /** Price a fill is booked at. */
  fillPrice = 100;
  assets = new Map<string, BrokerAsset>();
  /** Reject the next submits (consumed in order) instead of accepting. */
  rejectNext: Array<{ code: BrokerErrorCode; error: string }> = [];
  /** Make getOrderByClientId miss once for this id, as a racing writer would. */
  hideFromLookupOnce = new Set<string>();
  getAssetCalls: string[] = [];
  constructor(
    public account: BrokerAccount = ACCOUNT_1K,
    public positions: BrokerPosition[] = [],
  ) {}

  async getAccount(): Promise<Result<BrokerAccount, BrokerErrorCode>> {
    return { ok: true, value: this.account };
  }
  async getPositions(): Promise<Result<BrokerPosition[], BrokerErrorCode>> {
    return { ok: true, value: this.positions };
  }
  async getOrderByClientId(id: string): Promise<Result<BrokerOrder | null, BrokerErrorCode>> {
    if (this.hideFromLookupOnce.delete(id)) return { ok: true, value: null };
    return { ok: true, value: this.orders.find((o) => o.clientOrderId === id) ?? null };
  }
  async getAsset(symbol: string): Promise<Result<BrokerAsset | null, BrokerErrorCode>> {
    this.getAssetCalls.push(symbol);
    return {
      ok: true,
      value: this.assets.get(symbol) ?? { symbol, status: "active", tradable: true, shortable: false, borrowStatus: null },
    };
  }
  async listOrdersSince(): Promise<Result<BrokerOrder[], BrokerErrorCode>> {
    return { ok: true, value: [...this.orders] };
  }
  async listOpenOrders(): Promise<Result<BrokerOrder[], BrokerErrorCode>> {
    return { ok: true, value: this.orders.filter((o) => WORKING.has(o.status)) };
  }
  async submitMarketOrder(req: MarketOrderRequest): Promise<Result<BrokerOrder, BrokerErrorCode>> {
    this.submitted.push(req);
    const rej = this.rejectNext.shift();
    if (rej) return { ok: false, code: rej.code, error: rej.error };
    if (this.orders.some((o) => o.clientOrderId === req.clientOrderId)) {
      return { ok: false, code: "REJECTED", error: "Alpaca live API returned 422: client_order_id must be unique" };
    }
    const order: BrokerOrder = {
      id: `o${this.submitted.length}`,
      clientOrderId: req.clientOrderId,
      status: this.fill ? "filled" : "accepted",
      ticker: req.ticker,
      side: req.side,
      quantity: req.quantity,
    };
    this.orders.push(order);
    if (this.fill) {
      const cur = this.positions.find((p) => p.ticker === req.ticker);
      const signed = (cur ? (cur.side === "long" ? cur.quantity : -cur.quantity) : 0) + (req.side === "buy" ? req.quantity : -req.quantity);
      this.positions = this.positions.filter((p) => p.ticker !== req.ticker);
      if (signed !== 0) {
        this.positions.push({ ticker: req.ticker, side: signed > 0 ? "long" : "short", quantity: Math.abs(signed), avgEntryPrice: this.fillPrice });
      }
    }
    return { ok: true, value: order };
  }
}

export function weekdaysEnding(last: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${last}T00:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

export type BarSpec = {
  kind: "drive" | "reverse" | "neutral";
  /** Final-bar volume as a multiple of the normal bar (rank strength). */
  mult?: number;
  /** Latest close. */
  price?: number;
  baseVolume?: number;
  last?: string;
  count?: number;
};

/** 30 quiet bars; the final bar carries the reading. */
export function makeBars(spec: BarSpec): Bar[] {
  const { kind, mult = 9, price = 100, baseVolume = 1000, last = TODAY, count = 30 } = spec;
  return weekdaysEnding(last, count).map((date, i, all) => {
    const isLast = i === all.length - 1;
    const volume = isLast ? (kind === "neutral" ? 10 : baseVolume * mult) : baseVolume;
    const open = isLast ? (kind === "reverse" ? price * 1.02 : price * 0.98) : price * 0.99;
    const close = isLast ? (kind === "reverse" ? price * 0.98 : price) : price * 0.995;
    return { date, open, high: price * 1.03, low: price * 0.96, close, volume };
  });
}

export function pickSetup(opts: {
  specs: Record<string, BarSpec>;
  env?: Record<string, string | undefined>;
  account?: Partial<BrokerAccount>;
  positions?: BrokerPosition[];
  now?: Date;
  config?: PaperBrokerConfig;
  /** Live Auto switch. Default ON so existing scenarios exercise the signal path; tests set false. */
  auto?: boolean;
}) {
  const settingsRes = liveSettings({
    POLARITO_LIVE_WATCHLIST: Object.keys(opts.specs).join(","),
    ...(opts.env ?? {}),
  });
  if (!settingsRes.ok) throw new Error(settingsRes.error);
  const settings: LiveSettings = settingsRes.settings;
  const broker = new FakeLiveBroker({ ...ACCOUNT_1K, ...opts.account }, opts.positions ?? []);
  const audit: AuditRecord[] = [];
  let clock = opts.now ?? MID_SESSION;
  const specs = opts.specs;
  const autoState = { on: opts.auto ?? true };
  const deps: PickDeps = {
    readAuto: async () => ({ on: autoState.on, available: true, at: null, reason: autoState.on ? "Auto is ON." : "Auto is OFF." }),
    broker,
    config: opts.config ?? LIVE_ON,
    loadBars: async (ticker) => {
      const s = specs[ticker];
      if (!s) throw new Error("no such ticker");
      return makeBars(s);
    },
    audit: (r) => audit.push(r),
    now: () => clock,
    sleep: async () => {},
  };
  return { broker, audit, deps, settings, specs, autoState, setNow: (d: Date) => (clock = d), now: () => clock };
}
