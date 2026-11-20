import type { LiveBroker } from "@/lib/broker/types";

export type IdleCheck =
  | { ok: true }
  | {
      ok: false;
      code: "POSITIONS_OPEN" | "ORDERS_OPEN" | "POSITIONS_UNREADABLE" | "ORDERS_UNREADABLE";
      error: string;
      openPositions?: number;
      openOrders?: number;
    };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The rule for turning live Auto OFF: the account must be flat AND have no working orders.
 * Every position counts (stock, option, on or off the watchlist) and every open, unfilled order counts
 * (Alpaca's status=open: new, accepted, partially filled, pending ...). Nothing is ever cancelled here.
 * If positions or orders cannot be read the answer is "not idle" (fail closed).
 */
export async function requireIdle(broker: Pick<LiveBroker, "getPositions" | "listOpenOrders">): Promise<IdleCheck> {
  let positions: Awaited<ReturnType<typeof broker.getPositions>>;
  let orders: Awaited<ReturnType<typeof broker.listOpenOrders>>;
  try {
    positions = await broker.getPositions();
  } catch {
    positions = { ok: false, code: "NETWORK", error: "threw" };
  }
  try {
    orders = await broker.listOpenOrders();
  } catch {
    orders = { ok: false, code: "NETWORK", error: "threw" };
  }
  if (!positions.ok) {
    return { ok: false, code: "POSITIONS_UNREADABLE", error: "Could not read the live positions, so Auto was not turned OFF. Try again." };
  }
  if (!orders.ok) {
    return { ok: false, code: "ORDERS_UNREADABLE", error: "Could not read the live working orders, so Auto was not turned OFF. Try again." };
  }
  const p = positions.value.length;
  const o = orders.value.length;
  if (p > 0) {
    return {
      ok: false,
      code: "POSITIONS_OPEN",
      error:
        `Close all positions first (${plural(p, "position")} open).` +
        (o > 0 ? ` ${plural(o, "working order")} also open: cancel or let them finish.` : "") +
        " Auto cannot be turned OFF while the live account holds a position or a working order.",
      openPositions: p,
      openOrders: o,
    };
  }
  if (o > 0) {
    return {
      ok: false,
      code: "ORDERS_OPEN",
      error: `Cancel or let working orders finish first (${plural(o, "working order")} open). Auto cannot be turned OFF while an order is unfilled. Nothing was cancelled.`,
      openPositions: 0,
      openOrders: o,
    };
  }
  return { ok: true };
}
