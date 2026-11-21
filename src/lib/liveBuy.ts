/**
 * Manual BUY for the live account, server side. The order ticket (live mode) calls this through
 * POST /api/broker/live/buy.
 *
 * Long only, real stocks only, watchlist only. Sizing is the SAME risk engine the pick runner uses
 * (sizeLiveEntry: LIVE_LIMITS per-position cap (33% of equity, whole shares), 100% total exposure, cash and
 * buying power, daily-loss halt), so a manual buy is reduced or refused, never larger than what Auto could take. The order ticket
 * (OrderModule) sends `requireDrive`, so the server also refuses a long that is not aligned with the gear.
 *
 * Every check reads Alpaca fresh and fails closed: anything unreadable, stale or doubtful refuses.
 * The answer says "accepted" only after Alpaca returned the order, and `filled: true` only after the
 * broker's own position list shows the stock. Every attempt past the route's own gates is audited
 * (source: live-manual-buy).
 *
 * Up to LIVE_LIMITS.maxPositions (3) stocks at a time: a buy is refused (MAX_POSITIONS) when held positions plus
 * working orders already fill every slot, counted by company (GOOGL and GOOG are one, pickRank COMPANY_GROUPS).
 * It never adds to a stock already held (HELD) or stacks on a working order in it (WORKING).
 *
 * Auto ON rule (replaces the old one-stock AUTO_LOCK): Auto ON does not restrict WHICH watchlist stock may be
 * bought by hand, only the same slot and cap rules apply. The runner and the hand cannot double-buy: Auto never
 * enters a stock that is held, has a working order, or already has an entry today, and before every entry it
 * re-reads positions and working orders, so a hand buy that lands first simply uses up a slot. Once bought, Auto
 * manages the position by polarity like any other (it may close it on a Neutral or Reverse reading); with Auto
 * OFF only the stop-out and the end-of-day flatten act on it. The safer choice is taken in every conflict:
 * refuse (or send fewer shares) rather than exceed 3 positions or the per-position cap.
 */
import { buildAuditRecord, type AuditDraft, type AuditRecord } from "@/lib/audit";
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import type { LiveSettings } from "@/lib/liveSettings";
import { placeLiveManualBuy } from "@/lib/broker/liveExecute";
import { deriveDayState } from "@/lib/broker/liveOrders";
import type { LiveBroker } from "@/lib/broker/types";
import type { AutoState } from "@/lib/liveAutoStore";
import { newYorkClock } from "@/lib/paperRunner";
import { sessionOpen } from "@/lib/mirrorRunner";
import { slotUse } from "@/lib/liveLimits";
import { companyKey as pickCompanyKey, sizeLiveEntry, toReading } from "@/lib/pickRank";
import { computePolaritySeries, type Bar } from "@/lib/polarity";
import { MAX_SHARES } from "@/lib/risk";
import { normalizeTicker } from "@/lib/ticker";

export type LiveBuyDeps = {
  broker: LiveBroker;
  config: PaperBrokerConfig;
  settings: LiveSettings;
  /** Reads the persisted live Auto switch. */
  readAuto: () => Promise<AutoState>;
  loadBars: (ticker: string) => Promise<Bar[]>;
  audit: (record: AuditRecord) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type LiveBuyOutcome =
  | {
      ok: true;
      /** submitted: Alpaca accepted a new order. noop: an order with this id already existed, nothing new was sent. */
      status: "submitted" | "noop";
      ticker: string;
      requestedQuantity: number;
      quantity: number;
      /** true when the risk engine sent fewer shares than asked for. */
      reduced: boolean;
      clientOrderId: string;
      orderId?: string;
      orderStatus?: string;
      /** true only when the broker's own position list shows the stock after the order. */
      filled: boolean;
      message: string;
    }
  | { ok: false; code: string; error: string; clientOrderId?: string };

const ORDER_LOOKBACK_MS = 36 * 3_600_000;
const FILL_CHECKS = 5;
const FILL_CHECK_MS = 400;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** GOOGL and GOOG share one key; every other ticker is its own company. */
export const companyKey = pickCompanyKey;

const refusal = (code: string, error: string, clientOrderId?: string): LiveBuyOutcome => ({ ok: false, code, error, clientOrderId });

export type LiveBuyOptions = {
  /**
   * The order ticket's gear gate, re-checked on the server: refuse unless the engine's latest reading for the
   * stock is ready and Drive (+1). The ticket always sets it; a bare API call may leave it off (a hand buy).
   */
  requireDrive?: boolean;
};

export async function buyLivePosition(
  deps: LiveBuyDeps,
  tickerInput: unknown,
  quantityInput: unknown,
  options: LiveBuyOptions = {},
): Promise<LiveBuyOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? defaultSleep;
  const ticker = normalizeTicker(tickerInput);
  const auditTicker = ticker ?? (typeof tickerInput === "string" ? tickerInput.slice(0, 12) : "?");

  const audit = (draft: Omit<AuditDraft, "source" | "ticker">): void => {
    try {
      deps.audit(buildAuditRecord({ ...draft, source: "live-manual-buy", ticker: auditTicker }, now));
    } catch {
      /* logging must not change what was sent */
    }
  };

  const outcome = await decide();
  if (outcome.ok) {
    audit({
      outcome: outcome.status === "submitted" ? "entered" : "held",
      reason: outcome.message,
      side: "long",
      quantity: outcome.quantity,
      orderId: outcome.orderId,
      clientOrderId: outcome.clientOrderId,
    });
  } else {
    const failed = outcome.code === "BROKER" || outcome.code === "UNREADABLE" || outcome.code === "INTERNAL";
    audit({ outcome: failed ? "error" : "blocked", reason: outcome.error, side: "long", clientOrderId: outcome.clientOrderId });
  }
  return outcome;

  async function decide(): Promise<LiveBuyOutcome> {
    try {
      if (!ticker) return refusal("INVALID", "Ticker is not a valid stock symbol.");
      const requested = typeof quantityInput === "number" ? quantityInput : Number.NaN;
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_SHARES) {
        return refusal("INVALID", `Quantity must be a whole number of shares from 1 to ${MAX_SHARES.toLocaleString("en-US")}.`);
      }
      const { settings } = deps;
      if (!settings.watchlist.includes(ticker)) {
        return refusal("NOT_WATCHLIST", `${ticker} is not on the live watchlist (POLARITO_LIVE_WATCHLIST). No order was sent.`);
      }

      const gate = tradingGate(deps.config);
      if (!gate.ok) {
        return refusal(
          gate.code,
          gate.code === "DISABLED" ? "Live trading is not enabled (set POLARITO_LIVE_TRADING_ENABLED=1). No order was sent." : `${gate.error} No order was sent.`,
        );
      }

      if (!sessionOpen(now)) return refusal("MARKET_CLOSED", "US market is closed. No orders outside 09:30-16:00 New York. No order was sent.");
      const ny = newYorkClock(now);
      const today = ny.date;
      if (settings.flattenAtMinutes !== null && ny.minutes >= settings.flattenAtMinutes) {
        return refusal("FLATTEN_TIME", `It is past the ${clock(settings.flattenAtMinutes)} New York end-of-day flatten, which would sell it. No buy after that time. No order was sent.`);
      }

      const accountRes = await deps.broker.getAccount();
      if (!accountRes.ok) return refusal("UNREADABLE", `Cannot read the broker account: ${accountRes.error} No order was sent.`);
      const account = accountRes.value;
      if (account.status !== "ACTIVE" || account.tradingBlocked || account.accountBlocked) {
        return refusal("ACCOUNT", "Broker account is not active or trading is blocked. No order was sent.");
      }
      if (!(account.equity > 0) || !(account.lastEquity > 0)) return refusal("UNREADABLE", "Broker equity is not usable. No order was sent.");

      const positionsRes = await deps.broker.getPositions();
      if (!positionsRes.ok) return refusal("UNREADABLE", `Cannot read broker positions: ${positionsRes.error} No order was sent.`);
      const openRes = await deps.broker.listOpenOrders();
      if (!openRes.ok) return refusal("UNREADABLE", `Cannot read working orders: ${openRes.error} No order was sent.`);
      const ordersRes = await deps.broker.listOrdersSince(new Date(now.getTime() - ORDER_LOOKBACK_MS).toISOString());
      if (!ordersRes.ok) return refusal("UNREADABLE", `Cannot read today's orders: ${ordersRes.error} No order was sent.`);
      const state = deriveDayState(ordersRes.value, today);

      let auto: AutoState;
      try {
        auto = await deps.readAuto();
      } catch {
        return refusal("UNREADABLE", "Could not read the live Auto switch, so the buy was refused. No order was sent.");
      }
      // A configured store that failed to answer is not "Auto OFF": refuse rather than guess.
      if (auto.available && !auto.on && auto.reason !== "Auto is OFF.") {
        return refusal("UNREADABLE", `Could not read the live Auto switch (${auto.reason}) so the buy was refused. No order was sent.`);
      }

      if (state.stoppedToday) return refusal("STOPPED", "Stopped out today. No buy until the next session. No order was sent.");
      const dayLossPct = ((account.equity - account.lastEquity) / account.lastEquity) * 100;
      if (dayLossPct <= -settings.dailyLossPct) {
        return refusal("DAILY_LOSS", `Daily stop (${settings.dailyLossPct}%) reached (${dayLossPct.toFixed(2)}% today). No buy until the next session. No order was sent.`);
      }

      const key = companyKey(ticker);
      const held = positionsRes.value.find((p) => companyKey(p.ticker) === key);
      if (held) {
        return refusal("HELD", `Already holding ${held.side} ${held.quantity} ${held.ticker}. A manual buy does not add to a position. No order was sent.`);
      }
      const working = openRes.value.find((o) => companyKey(o.ticker) === key);
      if (working) {
        return refusal("WORKING", `A ${working.ticker} order (${working.clientOrderId}) is still working. Wait for it to finish. No order was sent.`);
      }
      const slots = slotUse(positionsRes.value, openRes.value, settings.maxPositions);
      if (slots.free <= 0) {
        return refusal(
          "MAX_POSITIONS",
          `${slots.used} of ${settings.maxPositions} position slots are in use (${[...slots.companies].join(", ")}). Close one first, or wait for a working order to finish. No order was sent.`,
        );
      }

      const asset = await deps.broker.getAsset(ticker);
      if (!asset.ok) return refusal("UNREADABLE", `Asset check failed (${asset.error}). No order was sent.`);
      if (!asset.value) return refusal("ASSET", `${ticker} was not found at Alpaca. No order was sent.`);
      if (asset.value.status.toLowerCase() !== "active" || !asset.value.tradable) {
        return refusal("ASSET", `${ticker} is not an active, tradable asset at Alpaca. No order was sent.`);
      }

      let bars: Bar[];
      try {
        bars = await deps.loadBars(ticker);
      } catch (e) {
        return refusal("UNREADABLE", `Could not load prices for ${ticker}: ${e instanceof Error ? e.message.slice(0, 120) : "unknown error"} No order was sent.`);
      }
      const series = computePolaritySeries(bars);
      if (series.length === 0) return refusal("UNREADABLE", `No usable price bars for ${ticker}. No order was sent.`);
      const reading = toReading(ticker, bars, series);
      if (reading.barDate !== today) {
        return refusal("STALE", `The latest ${ticker} bar (${reading.barDate}) is not today's (${today}). No trade on stale prices. No order was sent.`);
      }

      if (options.requireDrive && !(reading.ready && reading.polarity === 1)) {
        return refusal("GEAR", `The engine does not read ${ticker} as Drive (+1) right now (${reading.ready ? `polarity ${reading.polarity}` : "not enough history"}), so a long is not aligned. No order was sent.`);
      }

      const reserved = positionsRes.value.reduce((s, p) => s + p.quantity * p.avgEntryPrice, 0);
      const sized = sizeLiveEntry(
        {
          price: reading.price,
          equity: account.equity,
          lastEquity: account.lastEquity,
          cash: account.cash,
          buyingPower: account.buyingPower,
          reservedNotional: reserved,
          today,
          quantity: requested,
          maxPositionPct: settings.maxPositionPct,
          dailyLossPct: settings.dailyLossPct,
        },
        "long",
      );
      if (sized.quantity < 1) return refusal("RISK", `${sized.reason ?? "No room for one share under the risk limits."} No order was sent.`);
      const quantity = Math.min(requested, sized.quantity);

      const res = await placeLiveManualBuy({ broker: deps.broker, config: deps.config, date: today, nn: state.maxEntry + 1, ticker, quantity });
      if (!res.ok) {
        return refusal(res.code, `${res.error}${res.code === "BROKER" ? " Nothing is assumed bought; check the position below." : " No order was sent."}`, res.clientOrderId);
      }
      if (res.status === "noop" && !res.order) {
        return refusal("HELD", `${res.message} No order was sent.`, res.clientOrderId);
      }

      let filled = false;
      for (let i = 0; i < FILL_CHECKS && !filled; i++) {
        const again = await deps.broker.getPositions();
        if (again.ok) filled = again.value.some((p) => p.ticker === ticker && p.side === "long" && p.quantity >= quantity);
        if (!filled && i < FILL_CHECKS - 1) await sleep(FILL_CHECK_MS);
      }

      const reduced = quantity < requested;
      const sizing = reduced ? ` Reduced from ${requested} to ${quantity} by the risk limits${sized.notes.length ? ` (${sized.notes.join(" ")})` : ""}.` : "";
      const orderStatus = res.order?.status;
      const head =
        res.status === "submitted"
          ? `Alpaca accepted BUY ${quantity} ${ticker} (${orderStatus ?? "pending"}), order ${res.clientOrderId}.`
          : `Order ${res.clientOrderId} already exists at Alpaca (${orderStatus ?? "unknown"}). Nothing new was sent.`;
      const autoNote = auto.on ? ` Live Auto is ON, so it will manage ${ticker} by polarity (it may close it on a Neutral or Reverse reading).` : "";
      const tail =
        (filled
          ? ` The ${ticker} position is shown at Alpaca.`
          : " Not filled yet: the position is not shown at Alpaca until the order fills.") + autoNote;
      return {
        ok: true,
        status: res.status,
        ticker,
        requestedQuantity: requested,
        quantity,
        reduced,
        clientOrderId: res.clientOrderId,
        orderId: res.order?.id,
        orderStatus,
        filled,
        message: `${head}${sizing}${tail}`,
      };
    } catch (e) {
      return refusal("INTERNAL", `Unexpected buy failure (${e instanceof Error ? e.name : "error"}). Nothing is assumed bought; check the position below.`);
    }
  }
}
