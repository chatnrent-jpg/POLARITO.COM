/**
 * Order executor: turns a strategy intent into at most one broker order.
 *
 * Safety (every check runs before an order can be sent):
 *   1. Intent validation (ticker, whole shares, dates).
 *   2. Kill switch / enable / credentials gate.
 *   3. Account must be ACTIVE and not blocked.
 *   4. Idempotency: a deterministic client order id; if the broker already has
 *      that order, nothing is sent (a retry can never double-buy).
 *   5. Position reconciliation against the broker's ACTUAL positions: no adding
 *      to an existing position, no flipping without a close, and closes flatten
 *      the real quantity, not an assumed one.
 */
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import type {
  Broker,
  BrokerOrder,
  OrderIntent,
  PositionSide,
} from "@/lib/broker/types";
import { MAX_SHARES } from "@/lib/risk";
import { normalizeTicker } from "@/lib/ticker";

export type ExecuteCode =
  | "INVALID"
  | "KILLED"
  | "DISABLED"
  | "NOT_CONFIGURED"
  | "ACCOUNT"
  | "CONFLICT"
  | "BROKER";

export type ExecuteResult =
  | { ok: true; status: "submitted"; order: BrokerOrder; message: string }
  | { ok: true; status: "noop"; message: string; order?: BrokerOrder }
  | { ok: false; code: ExecuteCode; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const refuse = (code: ExecuteCode, error: string): ExecuteResult => ({ ok: false, code, error });

/** Deterministic: the same signal can only ever produce the same order id. */
export function clientOrderIdFor(intent: Pick<OrderIntent, "action" | "ticker" | "side" | "signalDate">): string {
  return `pol-${intent.ticker}-${intent.action}-${intent.side}-${intent.signalDate}`;
}

export function validateIntent(intent: OrderIntent): { ok: true; ticker: string } | { ok: false; error: string } {
  const ticker = normalizeTicker(intent.ticker);
  if (!ticker) return { ok: false, error: "Ticker is not a valid stock symbol." };
  if (intent.action !== "enter" && intent.action !== "close") return { ok: false, error: "Unknown action." };
  if (intent.side !== "long" && intent.side !== "short") return { ok: false, error: "Unknown side." };
  if (typeof intent.signalDate !== "string" || !ISO_DATE.test(intent.signalDate)) {
    return { ok: false, error: "Signal date must be YYYY-MM-DD." };
  }
  if (intent.action === "enter") {
    if (!Number.isSafeInteger(intent.quantity) || intent.quantity < 1 || intent.quantity > MAX_SHARES) {
      return { ok: false, error: `Quantity must be a whole number from 1 to ${MAX_SHARES.toLocaleString("en-US")}.` };
    }
  }
  if (intent.timeInForce !== undefined && intent.timeInForce !== "day" && intent.timeInForce !== "opg") {
    return { ok: false, error: "Unknown time in force." };
  }
  return { ok: true, ticker };
}

/** Entering long = buy, entering short = sell; closing reverses that. */
function orderSide(action: OrderIntent["action"], side: PositionSide): "buy" | "sell" {
  return (action === "enter") === (side === "long") ? "buy" : "sell";
}

export async function placeIntent(
  broker: Broker,
  config: PaperBrokerConfig,
  intent: OrderIntent,
): Promise<ExecuteResult> {
  try {
    const valid = validateIntent(intent);
    if (!valid.ok) return refuse("INVALID", valid.error);

    const gate = tradingGate(config);
    if (!gate.ok) return refuse(gate.code, gate.error);

    const account = await broker.getAccount();
    if (!account.ok) return refuse("BROKER", account.error);
    if (account.value.status !== "ACTIVE" || account.value.tradingBlocked || account.value.accountBlocked) {
      return refuse("ACCOUNT", "Broker account is not active or trading is blocked.");
    }

    const normalized: OrderIntent = { ...intent, ticker: valid.ticker };
    const clientOrderId = clientOrderIdFor(normalized);

    const existing = await broker.getOrderByClientId(clientOrderId);
    if (!existing.ok) return refuse("BROKER", existing.error);
    if (existing.value) {
      return {
        ok: true,
        status: "noop",
        order: existing.value,
        message: `Order ${clientOrderId} was already submitted (${existing.value.status}). Nothing sent.`,
      };
    }

    const positions = await broker.getPositions();
    if (!positions.ok) return refuse("BROKER", positions.error);
    const held = positions.value.find((p) => p.ticker === valid.ticker) ?? null;

    let quantity: number;
    if (intent.action === "enter") {
      if (held) {
        return held.side === intent.side
          ? { ok: true, status: "noop", message: `Already ${held.side} ${held.quantity} ${valid.ticker}. Not adding.` }
          : refuse("CONFLICT", `Broker holds a ${held.side} in ${valid.ticker}. Close it before entering a ${intent.side}.`);
      }
      quantity = intent.quantity;
    } else {
      if (!held) return { ok: true, status: "noop", message: `No ${valid.ticker} position at the broker. Nothing to close.` };
      if (held.side !== intent.side) {
        return refuse("CONFLICT", `Broker position in ${valid.ticker} is ${held.side}, not ${intent.side}.`);
      }
      quantity = held.quantity;
    }

    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return refuse("CONFLICT", "Broker position quantity is fractional or invalid; close it manually.");
    }

    const submitted = await broker.submitMarketOrder({
      ticker: valid.ticker,
      side: orderSide(intent.action, intent.side),
      quantity,
      clientOrderId,
      timeInForce: intent.timeInForce ?? "day",
    });
    if (!submitted.ok) return refuse("BROKER", submitted.error);
    return {
      ok: true,
      status: "submitted",
      order: submitted.value,
      message: `Submitted ${submitted.value.side.toUpperCase()} ${quantity} ${valid.ticker} (${submitted.value.status}).`,
    };
  } catch (e) {
    return refuse("BROKER", e instanceof Error ? `Unexpected executor error (${e.name}).` : "Unexpected executor error.");
  }
}
