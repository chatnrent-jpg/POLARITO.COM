/**
 * Options order executor: turns an intent into at most one broker order.
 *
 * Every check runs before an order can be sent:
 *   1. Intent validation, including the HARD alignment backstop: the contract
 *      is read from its own OCC symbol and must be a CALL on Drive (+1) or a
 *      PUT on Reverse (-1). Nothing else can be entered, whatever the caller says.
 *   2. Kill switch / enable / credentials gate.
 *   3. Account must be ACTIVE and not blocked.
 *   4. Idempotency: a deterministic client order id; a retry never double-buys.
 *   5. Reconciliation against the broker's ACTUAL option positions: one
 *      option per underlying, no adding, closes sell the real quantity.
 */
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import {
  MAX_OPTION_CONTRACTS,
  describeContract,
  optionTypeForPolarity,
  parseOccSymbol,
  type OptionType,
  type OptionsBroker,
} from "@/lib/broker/options";
import type { BrokerOrder, BrokerPosition } from "@/lib/broker/types";
import { normalizeTicker } from "@/lib/ticker";

export type OptionIntent = {
  action: "enter" | "close";
  ticker: string;
  /** Contract to buy. Required for entries; closes sell what the broker actually holds. */
  contractSymbol?: string;
  /** Polarity of the signal bar. Entries must match it. */
  signalPolarity?: number;
  signalDate: string;
  /** Contracts to buy. Ignored for closes. */
  quantity: number;
  /** Required for entries. For closes, absent means a market order. */
  limitPrice?: number;
};

export type OptionExecuteCode =
  | "INVALID"
  | "KILLED"
  | "DISABLED"
  | "NOT_CONFIGURED"
  | "ACCOUNT"
  | "CONFLICT"
  | "BROKER";

export type OptionExecuteResult =
  | { ok: true; status: "submitted"; order: BrokerOrder; message: string }
  | { ok: true; status: "noop"; message: string; order?: BrokerOrder }
  | { ok: false; code: OptionExecuteCode; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const refuse = (code: OptionExecuteCode, error: string): OptionExecuteResult => ({ ok: false, code, error });

export function optionClientOrderId(action: "enter" | "close", ticker: string, type: OptionType, signalDate: string): string {
  return `pol-opt-${ticker}-${action}-${type}-${signalDate}`;
}

/** Option positions at the broker for one underlying (OCC symbols only). */
export function optionPositionsFor(positions: readonly BrokerPosition[], ticker: string): BrokerPosition[] {
  return positions.filter((p) => parseOccSymbol(p.ticker)?.underlying === ticker);
}

export const MSG_OPTION_MISALIGNED =
  "ORDER BLOCKED: a call needs Drive (+1) and a put needs Reverse (-1). No other entry is allowed.";

export async function placeOptionIntent(
  broker: OptionsBroker,
  config: PaperBrokerConfig,
  intent: OptionIntent,
): Promise<OptionExecuteResult> {
  try {
    const ticker = normalizeTicker(intent.ticker);
    if (!ticker) return refuse("INVALID", "Ticker is not a valid stock symbol.");
    if (intent.action !== "enter" && intent.action !== "close") return refuse("INVALID", "Unknown action.");
    if (typeof intent.signalDate !== "string" || !ISO_DATE.test(intent.signalDate)) {
      return refuse("INVALID", "Signal date must be YYYY-MM-DD.");
    }

    let enterContract: ReturnType<typeof parseOccSymbol> = null;
    if (intent.action === "enter") {
      enterContract = parseOccSymbol(intent.contractSymbol);
      if (!enterContract || enterContract.underlying !== ticker) {
        return refuse("INVALID", "Contract is not a valid option on this ticker.");
      }
      const required = optionTypeForPolarity({
        polarity: typeof intent.signalPolarity === "number" ? intent.signalPolarity : 0,
        ready: intent.signalPolarity === 1 || intent.signalPolarity === -1,
      });
      if (required === null || required !== enterContract.type) {
        return refuse("INVALID", MSG_OPTION_MISALIGNED);
      }
      if (!Number.isSafeInteger(intent.quantity) || intent.quantity < 1 || intent.quantity > MAX_OPTION_CONTRACTS) {
        return refuse("INVALID", `Contracts must be a whole number from 1 to ${MAX_OPTION_CONTRACTS}.`);
      }
      if (!(typeof intent.limitPrice === "number" && Number.isFinite(intent.limitPrice) && intent.limitPrice > 0)) {
        return refuse("INVALID", "An option entry needs a positive limit price.");
      }
    } else if (
      intent.limitPrice !== undefined &&
      !(typeof intent.limitPrice === "number" && Number.isFinite(intent.limitPrice) && intent.limitPrice > 0)
    ) {
      return refuse("INVALID", "Limit price must be positive.");
    }

    const gate = tradingGate(config);
    if (!gate.ok) return refuse(gate.code, gate.error);

    const account = await broker.getAccount();
    if (!account.ok) return refuse("BROKER", account.error);
    if (account.value.status !== "ACTIVE" || account.value.tradingBlocked || account.value.accountBlocked) {
      return refuse("ACCOUNT", "Broker account is not active or trading is blocked.");
    }

    const positions = await broker.getPositions();
    if (!positions.ok) return refuse("BROKER", positions.error);
    const held = optionPositionsFor(positions.value, ticker);
    if (held.length > 1) {
      return refuse("CONFLICT", `Broker holds ${held.length} option positions in ${ticker}. Close extras manually.`);
    }
    if (held.length === 1 && held[0].side !== "long") {
      return refuse("CONFLICT", `Broker holds a short option in ${ticker}. This system only holds bought options.`);
    }

    if (intent.action === "enter" && enterContract) {
      const cid = optionClientOrderId("enter", ticker, enterContract.type, intent.signalDate);
      const existing = await broker.getOrderByClientId(cid);
      if (!existing.ok) return refuse("BROKER", existing.error);
      if (existing.value) {
        return {
          ok: true,
          status: "noop",
          order: existing.value,
          message: `Order ${cid} was already submitted (${existing.value.status}). Nothing sent.`,
        };
      }
      if (held.length === 1) {
        const heldType = parseOccSymbol(held[0].ticker)?.type;
        return heldType === enterContract.type
          ? { ok: true, status: "noop", message: `Already holding ${held[0].ticker}. Not adding.` }
          : refuse("CONFLICT", `Broker holds ${held[0].ticker}. Close it before entering a ${enterContract.type}.`);
      }
      const submitted = await broker.submitOptionOrder({
        symbol: intent.contractSymbol as string,
        side: "buy",
        quantity: intent.quantity,
        clientOrderId: cid,
        type: "limit",
        limitPrice: intent.limitPrice,
        positionIntent: "buy_to_open",
      });
      if (!submitted.ok) return refuse("BROKER", submitted.error);
      return {
        ok: true,
        status: "submitted",
        order: submitted.value,
        message: `Submitted BUY ${intent.quantity} ${describeContract(enterContract)} (${submitted.value.status}).`,
      };
    }

    if (held.length === 0) {
      return { ok: true, status: "noop", message: `No ${ticker} option position at the broker. Nothing to close.` };
    }
    const pos = held[0];
    const parsed = parseOccSymbol(pos.ticker);
    if (!parsed) return refuse("CONFLICT", "Broker option position has an unreadable symbol; close it manually.");
    if (!Number.isSafeInteger(pos.quantity) || pos.quantity < 1) {
      return refuse("CONFLICT", "Broker option quantity is fractional or invalid; close it manually.");
    }
    const cid = optionClientOrderId("close", ticker, parsed.type, intent.signalDate);
    const existing = await broker.getOrderByClientId(cid);
    if (!existing.ok) return refuse("BROKER", existing.error);
    if (existing.value) {
      return {
        ok: true,
        status: "noop",
        order: existing.value,
        message: `Order ${cid} was already submitted (${existing.value.status}). Nothing sent.`,
      };
    }
    const submitted = await broker.submitOptionOrder({
      symbol: pos.ticker,
      side: "sell",
      quantity: pos.quantity,
      clientOrderId: cid,
      type: intent.limitPrice === undefined ? "market" : "limit",
      limitPrice: intent.limitPrice,
      positionIntent: "sell_to_close",
    });
    if (!submitted.ok) return refuse("BROKER", submitted.error);
    return {
      ok: true,
      status: "submitted",
      order: submitted.value,
      message: `Submitted SELL ${pos.quantity} ${describeContract(parsed)} to close (${submitted.value.status}).`,
    };
  } catch (e) {
    return refuse("BROKER", e instanceof Error ? `Unexpected executor error (${e.name}).` : "Unexpected executor error.");
  }
}
