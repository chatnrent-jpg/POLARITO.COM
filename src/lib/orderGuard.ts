/**
 * Execution safety gate (pure logic, no UI).
 *
 * Rules, checked against the engine's current daily Polarity Gate:
 *   Neutral (0)            -> blocked, always.
 *   Drive (+1)  + Long     -> allowed.
 *   Reverse (-1) + Short   -> allowed.
 *   Drive (+1)  + Short    -> opposed, blocked.
 *   Reverse (-1) + Long    -> opposed, blocked.
 * There is no override. An unready or missing analysis never allows an order.
 */
import type { Polarity } from "@/lib/polarity";

export type OrderSide = "long" | "short";

export type GuardState =
  | "no-data"
  | "insufficient-history"
  | "blocked-neutral"
  | "select-type"
  | "opposed"
  | "aligned";

export type GuardResult = {
  state: GuardState;
  canSubmit: boolean;
  /** Exact on-screen wording for the two alert states, null otherwise. */
  message: string | null;
};

/*
 * These rules are a self-discipline feature of the simulator, NOT a forecast.
 * Back-tests (SPY 2016-2026, daily and 5-minute bars, costs included) found no
 * edge in following Polarity, so the wording must not imply that the aligned
 * side is the "right" side.
 */
export const MSG_NEUTRAL =
  "ORDER BLOCKED: Polarity is NEUTRAL (volume is inside the Noise Floor). This simulator takes no entries on a Neutral reading.";

export const MSG_OPPOSED =
  "ORDER BLOCKED: This simulator only takes entries that match the polarity (Drive = long, Reverse = short). It is a discipline rule, not a forecast: back-tests found no tradeable edge in following it.";

export const MAX_QUANTITY = 100_000;

export function isOrderSide(value: unknown): value is OrderSide {
  return value === "long" || value === "short";
}

export function evaluateGuard(
  analysis: { polarity: Polarity; ready: boolean } | null,
  side: OrderSide | "",
): GuardResult {
  const deny = (state: GuardState, message: string | null = null): GuardResult => ({
    state,
    canSubmit: false,
    message,
  });

  if (!analysis) return deny("no-data");
  if (!analysis.ready) return deny("insufficient-history");
  if (analysis.polarity === 0) return deny("blocked-neutral", MSG_NEUTRAL);
  if (!isOrderSide(side)) return deny("select-type");

  const aligned =
    (analysis.polarity === 1 && side === "long") ||
    (analysis.polarity === -1 && side === "short");

  return aligned
    ? { state: "aligned", canSubmit: true, message: null }
    : deny("opposed", MSG_OPPOSED);
}

export type QuantityCheck = { ok: true; qty: number } | { ok: false; error: string };

/** Whole shares only, 1..MAX_QUANTITY. */
export function validateQuantity(raw: string): QuantityCheck {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) {
    return { ok: false, error: "Quantity must be a whole number of shares (1 or more)." };
  }
  const qty = Number(s);
  if (!Number.isSafeInteger(qty) || qty < 1) {
    return { ok: false, error: "Quantity must be at least 1 share." };
  }
  if (qty > MAX_QUANTITY) {
    return { ok: false, error: `Quantity cannot exceed ${MAX_QUANTITY.toLocaleString("en-US")} shares.` };
  }
  return { ok: true, qty };
}
