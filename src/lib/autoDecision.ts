/**
 * Pure auto-trading decision shared by the browser simulation and the server
 * paper runner. No storage, no network, no `window`: safe on the server.
 *
 * Virtues (hard requirements):
 *   Wisdom     - Neutral / unready => STAND ASIDE (close what is open, never force a trade).
 *                Drive => long only; Reverse => short only.
 *   Temperance - Every entry is sized by the risk engine (risk.ts) BEFORE it is
 *                placed: streak scale-down, per-position / exposure / cash caps,
 *                hard daily loss and profit boundaries (new entries only; closes
 *                are never blocked by risk limits).
 *   Justice    - Stale, malformed or inconsistent data produces no trade.
 */
import type { LedgerState, ClosedTrade, Position } from "@/lib/ledger";
import { effectiveFillPrice } from "@/lib/fillModel";
import type { OrderSide } from "@/lib/orderGuard";
import type { DayResult, Polarity } from "@/lib/polarity";
import { assessEntry, type Sizing } from "@/lib/risk";
import { normalizeTicker } from "@/lib/ticker";
import type { AutoSimPrefs } from "@/lib/autoSimPrefs";

/** What the risk engine needs to know about an account, for a given set of positions. */
export type RiskAccountView = {
  startingCash: number;
  closed: readonly Pick<ClosedTrade, "realizedPnl" | "exitDate">[];
  reservedNotional: number;
  cashAvailable: number;
};
export type AccountOf = (state: LedgerState) => RiskAccountView;

export type AutoSimInput = {
  ticker: string;
  /** The bar whose polarity produced the signal. */
  signal: { polarity: Polarity; ready: boolean; date: string };
  /** Where the order fills: session date and QUOTED price (costs are added later). */
  fill: { date: string; price: number };
};

/** Machine-readable class of a decision (used by the audit trail). */
export type DecisionKind = "act" | "hold" | "aside" | "skip" | "blocked" | "off";

export type AutoSimDecision = {
  kind: DecisionKind;
  /** Open position to close (full quantity). */
  close: Position | null;
  /** New entry to open (after any close). */
  enter: { side: OrderSide; quantity: number } | null;
  reason: string;
  /** Non-blocking risk notes (size scaled / clipped). */
  notes: string[];
};

/** Bars older than this many calendar days are treated as stale (long weekend + holiday). */
export const MAX_STALE_DAYS = 5;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Side required by polarity, or null when standing aside (Neutral / unready). */
export function sideForPolarity(signal: { polarity: Polarity; ready: boolean }): OrderSide | null {
  if (!signal.ready) return null;
  if (signal.polarity === 1) return "long";
  if (signal.polarity === -1) return "short";
  return null;
}

/** True when `dateIso` is more than `maxDays` calendar days before `now` (or in the future by > 1 day). */
export function isStale(dateIso: string, now: Date, maxDays = MAX_STALE_DAYS): boolean {
  if (!ISO_DATE.test(dateIso)) return true;
  const t = Date.parse(`${dateIso}T00:00:00Z`);
  if (!Number.isFinite(t)) return true;
  const days = (now.getTime() - t) / 86_400_000;
  return days > maxDays || days < -1;
}

/**
 * Build the signal/fill pair from the engine's results for the chosen fill mode.
 * Returns null when there is not enough data to act on (stand aside).
 */
export function buildAutoSimInput(
  ticker: string,
  results: readonly DayResult[],
  fillMode: AutoSimPrefs["fillMode"],
): AutoSimInput | null {
  const n = results.length;
  if (n === 0) return null;
  const latest = results[n - 1];
  if (fillMode === "signal-close") {
    return {
      ticker,
      signal: { polarity: latest.polarity, ready: latest.ready, date: latest.date },
      fill: { date: latest.date, price: latest.close },
    };
  }
  if (n < 2) return null;
  const signalBar = results[n - 2];
  return {
    ticker,
    signal: { polarity: signalBar.polarity, ready: signalBar.ready, date: signalBar.date },
    fill: { date: latest.date, price: latest.open },
  };
}

function sizingFor(prefs: AutoSimPrefs): Sizing {
  return prefs.sizingMode === "risk"
    ? { mode: "risk", riskPct: prefs.riskPct / 100 }
    : { mode: "fixed", quantity: prefs.quantity };
}

function none(
  kind: DecisionKind,
  reason: string,
  notes: string[] = [],
): AutoSimDecision {
  return { kind, close: null, enter: null, reason, notes };
}

/** Plan an entry against a ledger state (positions may already exclude a pending close). */
function planEntry(
  input: AutoSimInput,
  side: OrderSide,
  state: LedgerState,
  accountOf: AccountOf,
  prefs: AutoSimPrefs,
): { quantity: number; notes: string[]; reason: string | null } {
  const account = accountOf(state);
  let price: number;
  try {
    price = effectiveFillPrice("enter", side, input.fill.price);
  } catch (e) {
    return { quantity: 0, notes: [], reason: e instanceof Error ? e.message : "Unusable price." };
  }
  const assessment = assessEntry({
    closed: account.closed,
    startingCash: account.startingCash,
    reservedNotional: account.reservedNotional,
    cashAvailable: account.cashAvailable,
    price,
    day: input.fill.date,
    sizing: sizingFor(prefs),
  });
  return assessment.allowed
    ? { quantity: assessment.quantity, notes: assessment.notes, reason: null }
    : { quantity: 0, notes: assessment.notes, reason: assessment.reason };
}

/**
 * Pure decision: what should auto do right now? Never mutates storage and
 * never touches the browser; `accountOf` supplies the risk view of the account
 * (simulated ledger in the browser, broker account on the server).
 * `now` is injectable so staleness is testable.
 */
export function decideAuto(
  input: AutoSimInput | null,
  ledger: LedgerState,
  accountOf: AccountOf,
  prefs: AutoSimPrefs,
  now: Date = new Date(),
): AutoSimDecision {
  if (!prefs.enabled) return none("off", "Auto sim is off.");
  if (!input) return none("aside", "Not enough bars to act on yet. Standing aside.");

  const ticker = normalizeTicker(input.ticker);
  if (!ticker) return none("skip", "Ticker is not valid. Standing aside.");
  if (
    !Number.isFinite(input.fill.price) ||
    input.fill.price <= 0 ||
    !ISO_DATE.test(input.fill.date) ||
    !ISO_DATE.test(input.signal.date) ||
    input.signal.date > input.fill.date
  ) {
    return none("skip", "Price or dates are not usable. Standing aside.");
  }
  if (isStale(input.fill.date, now)) {
    return none("skip", `Latest bar (${input.fill.date}) is stale. No trade on stale data.`);
  }

  const open = ledger.positions.filter((p) => p.ticker === ticker);
  const wanted = sideForPolarity(input.signal);

  // Wisdom: Neutral or not enough history => flat.
  if (wanted === null) {
    if (open.length === 0) {
      return none(
        "aside",
        input.signal.ready
          ? "Neutral: standing aside."
          : "Insufficient history: standing aside.",
      );
    }
    return {
      kind: "act",
      close: open[0],
      enter: null,
      reason: input.signal.ready
        ? "Neutral: closing to stand aside."
        : "Insufficient history: closing to stand aside.",
      notes: [],
    };
  }

  const misaligned = open.find((p) => p.side !== wanted) ?? null;
  if (misaligned) {
    // Evaluate the entry leg as if the close had already happened.
    let exitPrice: number;
    try {
      exitPrice = effectiveFillPrice("close", misaligned.side, input.fill.price);
    } catch (e) {
      return none("skip", e instanceof Error ? e.message : "Unusable price.");
    }
    const gross =
      misaligned.side === "long"
        ? (exitPrice - misaligned.avgPrice) * misaligned.quantity
        : (misaligned.avgPrice - exitPrice) * misaligned.quantity;
    const synthetic: ClosedTrade = {
      id: "pending-close",
      simulated: true,
      ticker: misaligned.ticker,
      side: misaligned.side,
      quantity: misaligned.quantity,
      entryPrice: misaligned.avgPrice,
      exitPrice,
      exitDate: input.fill.date,
      openedAt: misaligned.openedAt,
      closedAt: input.fill.date,
      realizedPnl: Math.round(gross * 100) / 100,
    };
    const after = {
      positions: ledger.positions.filter(
        (p) => !(p.ticker === misaligned.ticker && p.side === misaligned.side),
      ),
      closed: [...ledger.closed, synthetic],
    };
    const plan = planEntry(input, wanted, after, accountOf, prefs);
    return plan.quantity > 0
      ? {
          kind: "act",
          close: misaligned,
          enter: { side: wanted, quantity: plan.quantity },
          reason: `Flip: close ${misaligned.side}, enter ${wanted}.`,
          notes: plan.notes,
        }
      : {
          kind: "act",
          close: misaligned,
          enter: null,
          reason: `Closing misaligned ${misaligned.side}; new entry blocked: ${plan.reason}`,
          notes: plan.notes,
        };
  }

  // Aligned and already holding: never add size on every refresh.
  if (open.some((p) => p.side === wanted)) {
    return none("hold", `Holding ${wanted}; signal still aligned.`);
  }

  const plan = planEntry(input, wanted, ledger, accountOf, prefs);
  if (plan.quantity < 1) return none("blocked", plan.reason ?? "Entry blocked.", plan.notes);
  return {
    kind: "act",
    close: null,
    enter: { side: wanted, quantity: plan.quantity },
    reason: `Enter ${wanted} on aligned gear.`,
    notes: plan.notes,
  };
}
