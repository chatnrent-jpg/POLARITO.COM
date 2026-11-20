import type { LiveBroker } from "@/lib/broker/types";

export type FlatCheck =
  | { ok: true }
  | { ok: false; code: "POSITIONS_OPEN" | "POSITIONS_UNREADABLE"; error: string; openPositions?: number };

/**
 * The rule for turning live Auto OFF: the account must be flat. Every position counts (stock, option,
 * on or off the watchlist), because Auto OFF stops the signal-driven exits. Working, unfilled orders do
 * NOT count and are never cancelled. If positions cannot be read the answer is "not flat" (fail closed).
 */
export async function requireFlat(broker: Pick<LiveBroker, "getPositions">): Promise<FlatCheck> {
  try {
    const r = await broker.getPositions();
    if (!r.ok) {
      return { ok: false, code: "POSITIONS_UNREADABLE", error: "Could not read the live positions, so Auto was not turned OFF. Try again." };
    }
    if (r.value.length > 0) {
      return {
        ok: false,
        code: "POSITIONS_OPEN",
        error: `Close all positions first (${r.value.length} open). Auto cannot be turned OFF while the live account holds a position.`,
        openPositions: r.value.length,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "POSITIONS_UNREADABLE", error: "Could not read the live positions, so Auto was not turned OFF. Try again." };
  }
}
