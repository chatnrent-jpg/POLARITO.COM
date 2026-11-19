/**
 * Simulated auto enter / close for the paper ledger.
 *
 * Virtues (hard requirements):
 *   Wisdom     - Neutral / unready => STAND ASIDE (close what is open, never force a trade).
 *                Drive => long only; Reverse => short only.
 *   Courage    - A valid signal executes through the ledger with no review dialog.
 *   Temperance - Every entry is sized by the risk engine (risk.ts) BEFORE it is
 *                placed: streak scale-down, per-position / exposure / cash caps,
 *                hard daily loss and profit boundaries (new entries only; closes
 *                are never blocked by risk limits).
 *   Justice    - Stale, malformed or inconsistent data produces no trade, and a
 *                failed write is reported as a failure, never as success.
 *
 * Fill model:
 *   "next-open"    signal = last COMPLETED bar, fill = the next bar's open.
 *   "signal-close" signal = latest bar, fill = that bar's close (legacy).
 * Slippage / commission are folded into the effective fill price (fillModel.ts).
 */
import {
  addLedgerEntry,
  closeActivePosition,
  computeAccount,
  getLedgerSnapshot,
  newEntryId,
  type ClosedTrade,
  type LedgerEntry,
  type LedgerSnapshot,
  type Position,
} from "@/lib/ledger";
import { effectiveFillPrice } from "@/lib/fillModel";
import { getAccountDef, type AccountId } from "@/lib/multiAccount";
import type { OrderSide } from "@/lib/orderGuard";
import type { DayResult, Polarity } from "@/lib/polarity";
import { assessEntry, type Sizing } from "@/lib/risk";
import { normalizeTicker } from "@/lib/ticker";
import type { AutoSimPrefs } from "@/lib/autoSimPrefs";

export type AutoSimInput = {
  ticker: string;
  /** The bar whose polarity produced the signal. */
  signal: { polarity: Polarity; ready: boolean; date: string };
  /** Where the order fills: session date and QUOTED price (costs are added later). */
  fill: { date: string; price: number };
};

export type AutoSimDecision = {
  /** Open position to close (full quantity). */
  close: Position | null;
  /** New entry to open (after any close). */
  enter: { side: OrderSide; quantity: number } | null;
  reason: string;
  /** Non-blocking risk notes (size scaled / clipped). */
  notes: string[];
};

export type AutoSimApplyResult = {
  acted: boolean;
  messages: string[];
};

/** Bars older than this many calendar days are treated as stale (long weekend + holiday). */
export const MAX_STALE_DAYS = 5;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

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

function none(reason: string, notes: string[] = []): AutoSimDecision {
  return { close: null, enter: null, reason, notes };
}

/** Plan an entry against a ledger state (positions may already exclude a pending close). */
function planEntry(
  input: AutoSimInput,
  side: OrderSide,
  state: { positions: readonly Position[]; closed: readonly ClosedTrade[] },
  accountId: AccountId,
  prefs: AutoSimPrefs,
): { quantity: number; notes: string[]; reason: string | null } {
  const initial = getAccountDef(accountId).initialBalance;
  const account = computeAccount(state, {}, initial);
  let price: number;
  try {
    price = effectiveFillPrice("enter", side, input.fill.price);
  } catch (e) {
    return { quantity: 0, notes: [], reason: e instanceof Error ? e.message : "Unusable price." };
  }
  const assessment = assessEntry({
    closed: state.closed,
    startingCash: initial,
    reservedNotional: account.reserved,
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
 * Pure decision: what should auto do right now? Never mutates storage.
 * `now` is injectable so staleness is testable.
 */
export function decideAutoSim(
  input: AutoSimInput | null,
  ledger: LedgerSnapshot,
  prefs: AutoSimPrefs,
  now: Date = new Date(),
): AutoSimDecision {
  if (!prefs.enabled) return none("Auto sim is off.");
  if (!input) return none("Not enough bars to act on yet. Standing aside.");

  const ticker = normalizeTicker(input.ticker);
  if (!ticker) return none("Ticker is not valid. Standing aside.");
  if (
    !Number.isFinite(input.fill.price) ||
    input.fill.price <= 0 ||
    !ISO_DATE.test(input.fill.date) ||
    !ISO_DATE.test(input.signal.date) ||
    input.signal.date > input.fill.date
  ) {
    return none("Price or dates are not usable. Standing aside.");
  }
  if (isStale(input.fill.date, now)) {
    return none(`Latest bar (${input.fill.date}) is stale. No trade on stale data.`);
  }

  const open = ledger.positions.filter((p) => p.ticker === ticker);
  const wanted = sideForPolarity(input.signal);

  // Wisdom: Neutral or not enough history => flat.
  if (wanted === null) {
    if (open.length === 0) {
      return none(
        input.signal.ready
          ? "Neutral: standing aside."
          : "Insufficient history: standing aside.",
      );
    }
    return {
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
      return none(e instanceof Error ? e.message : "Unusable price.");
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
    const plan = planEntry(input, wanted, after, ledger.accountId, prefs);
    return plan.quantity > 0
      ? {
          close: misaligned,
          enter: { side: wanted, quantity: plan.quantity },
          reason: `Flip: close ${misaligned.side}, enter ${wanted}.`,
          notes: plan.notes,
        }
      : {
          close: misaligned,
          enter: null,
          reason: `Closing misaligned ${misaligned.side}; new entry blocked: ${plan.reason}`,
          notes: plan.notes,
        };
  }

  // Aligned and already holding: never add size on every refresh.
  if (open.some((p) => p.side === wanted)) {
    return none(`Holding ${wanted}; signal still aligned.`);
  }

  const plan = planEntry(input, wanted, ledger, ledger.accountId, prefs);
  if (plan.quantity < 1) return none(plan.reason ?? "Entry blocked.", plan.notes);
  return {
    close: null,
    enter: { side: wanted, quantity: plan.quantity },
    reason: `Enter ${wanted} on aligned gear.`,
    notes: plan.notes,
  };
}

/**
 * Apply a decision to the live ledger for `accountId`. Close runs before enter
 * so a polarity flip can reverse in one tick; the entry is re-decided against
 * the fresh post-close ledger so sizing uses real, persisted numbers.
 */
export function applyAutoSim(
  input: AutoSimInput,
  prefs: AutoSimPrefs,
  accountId: AccountId,
  now: Date = new Date(),
): AutoSimApplyResult {
  const messages: string[] = [];
  try {
    const ledger = getLedgerSnapshot();
    if (ledger.accountId !== accountId) {
      return { acted: false, messages: ["Active account changed; auto sim skipped this tick."] };
    }

    const decision = decideAutoSim(input, ledger, prefs, now);
    let acted = false;

    if (decision.close) {
      const c = decision.close;
      const exitPrice = effectiveFillPrice("close", c.side, input.fill.price);
      const result = closeActivePosition(c.ticker, c.quantity, exitPrice, {
        accountId,
        side: c.side,
        exitDate: input.fill.date,
      });
      if (!result.ok) {
        return { acted, messages: [`Auto-close failed: ${result.error}`] };
      }
      acted = true;
      messages.push(
        `Auto-closed ${result.trade.side.toUpperCase()} ${result.trade.quantity.toLocaleString("en-US")} ${result.trade.ticker} @ ${money(result.trade.exitPrice)} (${input.fill.date}). Realized ${money(result.trade.realizedPnl)}.`,
      );
    }

    if (decision.enter) {
      const fresh = getLedgerSnapshot();
      if (fresh.accountId !== accountId) {
        messages.push("Active account changed before auto-entry; entry skipped.");
        return { acted, messages };
      }
      const again = decideAutoSim(input, fresh, prefs, now);
      if (!again.enter || again.enter.side !== decision.enter.side) {
        if (!acted) messages.push(again.reason);
        return { acted, messages };
      }
      const { side, quantity } = again.enter;
      if (input.signal.polarity !== 1 && input.signal.polarity !== -1) {
        messages.push("Auto-entry refused: polarity is not Drive or Reverse.");
        return { acted, messages };
      }
      const price = effectiveFillPrice("enter", side, input.fill.price);
      const entry: LedgerEntry = {
        id: newEntryId(),
        createdAt: new Date().toISOString(),
        simulated: true,
        ticker: input.ticker,
        side,
        quantity,
        price,
        priceBasis: prefs.fillMode === "next-open" ? "next open" : "last daily close",
        priceDate: input.fill.date,
        polarityAtEntry: input.signal.polarity,
        notional: quantity * price,
      };
      const result = addLedgerEntry(entry, accountId);
      if (result.ok) {
        acted = true;
        messages.push(
          `Auto-entered ${side.toUpperCase()} ${quantity.toLocaleString("en-US")} ${input.ticker} @ ${money(price)} (${prefs.fillMode === "next-open" ? "open" : "close"} of ${input.fill.date}).`,
        );
        messages.push(...again.notes);
      } else {
        messages.push(`Auto-entry failed: ${result.error}`);
      }
    } else if (decision.notes.length > 0) {
      messages.push(...decision.notes);
    }

    if (!acted && messages.length === 0) messages.push(decision.reason);
    else if (!acted && decision.reason && !messages.includes(decision.reason)) {
      messages.unshift(decision.reason);
    }
    return { acted, messages };
  } catch (err) {
    return {
      acted: false,
      messages: [
        err instanceof Error ? `Auto sim error: ${err.message}` : "Auto sim error: unexpected failure.",
      ],
    };
  }
}
