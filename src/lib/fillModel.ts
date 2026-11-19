/**
 * Simulated execution costs. A real order never fills exactly at the quoted
 * price: buys fill a little higher, sells a little lower, and commissions apply.
 * Costs are folded into the effective fill price so the ledger schema is unchanged.
 */
export type FillCosts = {
  /** Adverse price move per fill, in basis points (5 = 0.05%). */
  slippageBps: number;
  /** Commission per share, applied adversely on every fill. */
  commissionPerShare: number;
};

export const DEFAULT_FILL_COSTS: Readonly<FillCosts> = Object.freeze({
  slippageBps: 5,
  commissionPerShare: 0,
});

export type PositionSide = "long" | "short";

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Effective fill price.
 *   enter long  = buy   -> higher      close long  = sell -> lower
 *   enter short = sell  -> lower       close short = buy  -> higher
 */
export function effectiveFillPrice(
  action: "enter" | "close",
  side: PositionSide,
  quotedPrice: number,
  costs: FillCosts = DEFAULT_FILL_COSTS,
): number {
  if (!Number.isFinite(quotedPrice) || quotedPrice <= 0) {
    throw new RangeError("Quoted price must be a positive number.");
  }
  if (
    !Number.isFinite(costs.slippageBps) ||
    costs.slippageBps < 0 ||
    !Number.isFinite(costs.commissionPerShare) ||
    costs.commissionPerShare < 0
  ) {
    throw new RangeError("Fill costs must be finite and >= 0.");
  }
  const isBuy = (action === "enter") === (side === "long");
  const slip = (quotedPrice * costs.slippageBps) / 10_000;
  const adverse = slip + costs.commissionPerShare;
  const price = isBuy ? quotedPrice + adverse : quotedPrice - adverse;
  if (!(price > 0)) throw new RangeError("Costs exceed the quoted price.");
  return round4(price);
}
