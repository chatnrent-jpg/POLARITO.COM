/**
 * Live executor: entries and closes with the live id scheme (liveOrders.ts).
 * Everything goes through the shared `placeIntent`, so account, position and
 * duplicate-id reconciliation are the same code the paper paths use. This
 * layer adds: live-worded gate errors, attempt numbers so a failed close can
 * be retried, and duplicate-id (HTTP 422) handling that treats the 422 as
 * "already placed" only after the order is found by its id.
 */
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import { placeIntent, type ExecuteCode } from "@/lib/broker/execute";
import {
  closeOrderId,
  closeOrdersFor,
  entryNumberFor,
  entryOrderId,
  isFailedStatus,
  manualOrderId,
  MAX_CLOSE_ATTEMPTS,
  stopOrderId,
  type DayState,
} from "@/lib/broker/liveOrders";
import type { BrokerOrder, LiveBroker, PositionSide } from "@/lib/broker/types";

export type LiveOrderCode = ExecuteCode | "BREAKER";

export type LiveOrderResult =
  | { ok: true; status: "submitted"; order: BrokerOrder; clientOrderId: string; message: string }
  | { ok: true; status: "noop"; order?: BrokerOrder; clientOrderId: string; message: string }
  | { ok: false; code: LiveOrderCode; error: string; clientOrderId?: string };

const refuse = (code: LiveOrderCode, error: string, clientOrderId?: string): LiveOrderResult => ({
  ok: false,
  code,
  error,
  clientOrderId,
});

const DUPLICATE_ID = /client_order_id|unique|duplicate/i;

function liveGate(config: PaperBrokerConfig): LiveOrderResult | null {
  const gate = tradingGate(config, "live");
  if (gate.ok) return null;
  if (gate.code === "DISABLED") {
    return refuse("DISABLED", "Live trading is not enabled (set POLARITO_LIVE_TRADING_ENABLED=1). No order was sent.");
  }
  if (gate.code === "NOT_CONFIGURED") return refuse("NOT_CONFIGURED", "Alpaca live credentials are not configured.");
  return refuse(gate.code, gate.error);
}

/** Broker refused the id as a duplicate: success only if the order really exists and is not dead. */
async function settleDuplicate(
  broker: LiveBroker,
  clientOrderId: string,
  error: string,
): Promise<LiveOrderResult> {
  const found = await broker.getOrderByClientId(clientOrderId);
  if (found.ok && found.value && !isFailedStatus(found.value.status)) {
    return {
      ok: true,
      status: "noop",
      order: found.value,
      clientOrderId,
      message: `Order ${clientOrderId} already exists at the broker (${found.value.status}). Nothing sent.`,
    };
  }
  return refuse("BROKER", error, clientOrderId);
}

export type LiveEntryArgs = {
  broker: LiveBroker;
  config: PaperBrokerConfig;
  /** New York session date, YYYY-MM-DD. */
  date: string;
  /** Entry number: DayState.maxEntry + 1. */
  nn: number;
  ticker: string;
  side: PositionSide;
  quantity: number;
  /** Polarity of the signal bar (the executor re-checks side against it). */
  polarity: number;
  signalDate: string;
};

export async function placeLiveEntry(a: LiveEntryArgs): Promise<LiveOrderResult> {
  const gated = liveGate(a.config);
  if (gated) return gated;
  const clientOrderId = entryOrderId(a.date, a.nn, a.ticker);
  const res = await placeIntent(a.broker, a.config, {
    action: "enter",
    ticker: a.ticker,
    side: a.side,
    quantity: a.quantity,
    signalPolarity: a.polarity,
    signalDate: a.signalDate,
    timeInForce: "day",
    clientOrderId,
  });
  if (res.ok) {
    return res.status === "submitted"
      ? { ok: true, status: "submitted", order: res.order, clientOrderId, message: res.message }
      : { ok: true, status: "noop", order: res.order, clientOrderId, message: res.message };
  }
  if (res.code === "BROKER" && DUPLICATE_ID.test(res.error)) return settleDuplicate(a.broker, clientOrderId, res.error);
  return refuse(res.code, res.error, clientOrderId);
}

export type LiveManualBuyArgs = {
  broker: LiveBroker;
  config: PaperBrokerConfig;
  /** New York session date, YYYY-MM-DD. */
  date: string;
  /** Entry number: DayState.maxEntry + 1 (manual and automatic entries share the sequence). */
  nn: number;
  ticker: string;
  quantity: number;
};

/**
 * A hand-placed long (the order ticket in live mode). Same executor, account, position and duplicate-id
 * checks as an automatic entry, filed under the manual id pol-{date}-m{NN}-{TICKER}. A manual buy is
 * long by definition, so the executor's polarity alignment check is satisfied with +1 and no signal is consulted.
 */
export async function placeLiveManualBuy(a: LiveManualBuyArgs): Promise<LiveOrderResult> {
  const gated = liveGate(a.config);
  if (gated) return gated;
  const clientOrderId = manualOrderId(a.date, a.nn, a.ticker);
  const res = await placeIntent(a.broker, a.config, {
    action: "enter",
    ticker: a.ticker,
    side: "long",
    quantity: a.quantity,
    signalPolarity: 1,
    signalDate: a.date,
    timeInForce: "day",
    clientOrderId,
  });
  if (res.ok) {
    return res.status === "submitted"
      ? { ok: true, status: "submitted", order: res.order, clientOrderId, message: res.message }
      : { ok: true, status: "noop", order: res.order, clientOrderId, message: res.message };
  }
  if (res.code === "BROKER" && DUPLICATE_ID.test(res.error)) return settleDuplicate(a.broker, clientOrderId, res.error);
  return refuse(res.code, res.error, clientOrderId);
}

export type LiveCloseArgs = {
  broker: LiveBroker;
  config: PaperBrokerConfig;
  /** The day's state as read from the broker just before this call. */
  state: DayState;
  ticker: string;
  /** Side of the position at the broker. The quantity is always the broker's own. */
  side: PositionSide;
  /** "stop" files the order under the stop-out id, which also locks entries for the day. */
  kind: "close" | "stop";
};

/**
 * Close the broker's real position. One id per (entry number, attempt): a second click,
 * the automation and a stop-out cannot sell the same position twice, and an attempt that
 * ended canceled or rejected is followed by the next attempt number (max 3, then BREAKER).
 */
export async function placeLiveClose(a: LiveCloseArgs): Promise<LiveOrderResult> {
  const gated = liveGate(a.config);
  if (gated) return gated;

  const nn = entryNumberFor(a.state, a.ticker);
  const prior = closeOrdersFor(a.state, a.ticker, nn);
  const live = prior.find((p) => !isFailedStatus(p.order.status));
  if (live) {
    return {
      ok: true,
      status: "noop",
      order: live.order,
      clientOrderId: live.order.clientOrderId,
      message: `Close ${live.order.clientOrderId} was already submitted (${live.order.status}). Nothing sent.`,
    };
  }
  const attempt = prior.reduce((m, p) => Math.max(m, p.id.attempt), 0) + 1;
  if (attempt > MAX_CLOSE_ATTEMPTS) {
    return refuse(
      "BREAKER",
      `${MAX_CLOSE_ATTEMPTS} close attempts for ${a.ticker} failed. No more automatic tries and no new entries: close it in Alpaca's own dashboard.`,
    );
  }
  const clientOrderId =
    a.kind === "stop" ? stopOrderId(a.state.date, nn, attempt, a.ticker) : closeOrderId(a.state.date, nn, attempt, a.ticker);

  const res = await placeIntent(a.broker, a.config, {
    action: "close",
    ticker: a.ticker,
    side: a.side,
    quantity: 0,
    signalDate: a.state.date,
    timeInForce: "day",
    clientOrderId,
  });
  if (res.ok) {
    return res.status === "submitted"
      ? { ok: true, status: "submitted", order: res.order, clientOrderId, message: res.message }
      : { ok: true, status: "noop", order: res.order, clientOrderId, message: res.message };
  }
  if (res.code === "BROKER" && DUPLICATE_ID.test(res.error)) return settleDuplicate(a.broker, clientOrderId, res.error);
  return refuse(res.code, res.error, clientOrderId);
}
