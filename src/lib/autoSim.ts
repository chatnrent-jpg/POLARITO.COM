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
  type LedgerEntry,
  type LedgerSnapshot,
} from "@/lib/ledger";
import {
  decideAuto,
  type AccountOf,
  type AutoSimDecision,
  type AutoSimInput,
} from "@/lib/autoDecision";
import { effectiveFillPrice } from "@/lib/fillModel";
import { getAccountDef, type AccountId } from "@/lib/multiAccount";
import type { AutoSimPrefs } from "@/lib/autoSimPrefs";
import type { AuditDraft } from "@/lib/audit";

export {
  MAX_STALE_DAYS,
  buildAutoSimInput,
  isStale,
  sideForPolarity,
  type AutoSimDecision,
  type AutoSimInput,
} from "@/lib/autoDecision";

export type AutoSimApplyResult = {
  acted: boolean;
  messages: string[];
  audit: AuditDraft[];
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Risk view of a simulated ledger account. */
function simAccountOf(accountId: AccountId): AccountOf {
  const initial = getAccountDef(accountId).initialBalance;
  return (state) => {
    const a = computeAccount(state, {}, initial);
    return {
      startingCash: initial,
      closed: state.closed,
      reservedNotional: a.reserved,
      cashAvailable: a.cashAvailable,
    };
  };
}

/** Browser-simulation decision against the simulated ledger. */
export function decideAutoSim(
  input: AutoSimInput | null,
  ledger: LedgerSnapshot,
  prefs: AutoSimPrefs,
  now: Date = new Date(),
): AutoSimDecision {
  return decideAuto(input, ledger, simAccountOf(ledger.accountId), prefs, now);
}

/**
 * Apply a decision to the live ledger for `accountId`. Close runs before enter
 * so a polarity flip can reverse in one tick; the entry is re-decided against
 * the fresh post-close ledger so sizing uses real, persisted numbers.
 *
 * `audit` holds one draft per thing that actually happened (or the reason
 * nothing did), built from persisted results, never from intent.
 */
export function applyAutoSim(
  input: AutoSimInput,
  prefs: AutoSimPrefs,
  accountId: AccountId,
  now: Date = new Date(),
): AutoSimApplyResult {
  const messages: string[] = [];
  const audit: AuditDraft[] = [];
  const base = {
    source: "browser-sim" as const,
    ticker: input.ticker,
    signalDate: input.signal.date,
    polarity: input.signal.polarity,
    ready: input.signal.ready,
  };
  try {
    const ledger = getLedgerSnapshot();
    if (ledger.accountId !== accountId) {
      return { acted: false, messages: ["Active account changed; auto sim skipped this tick."], audit };
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
        audit.push({ ...base, outcome: "error", reason: `Auto-close failed: ${result.error}`, side: c.side });
        return { acted, messages: [`Auto-close failed: ${result.error}`], audit };
      }
      acted = true;
      messages.push(
        `Auto-closed ${result.trade.side.toUpperCase()} ${result.trade.quantity.toLocaleString("en-US")} ${result.trade.ticker} @ ${money(result.trade.exitPrice)} (${input.fill.date}). Realized ${money(result.trade.realizedPnl)}.`,
      );
      audit.push({
        ...base,
        outcome: "closed",
        reason: `${decision.reason} Realized ${money(result.trade.realizedPnl)}.`,
        side: result.trade.side,
        quantity: result.trade.quantity,
        price: result.trade.exitPrice,
      });
    }

    if (decision.enter) {
      const fresh = getLedgerSnapshot();
      if (fresh.accountId !== accountId) {
        messages.push("Active account changed before auto-entry; entry skipped.");
        audit.push({ ...base, outcome: "skipped", reason: "Active account changed before auto-entry; entry skipped." });
        return { acted, messages, audit };
      }
      const again = decideAutoSim(input, fresh, prefs, now);
      if (!again.enter || again.enter.side !== decision.enter.side) {
        if (!acted) messages.push(again.reason);
        audit.push({
          ...base,
          outcome: "blocked",
          reason: `Entry not placed after close: ${again.reason}`,
          notes: again.notes,
        });
        return { acted, messages, audit };
      }
      const { side, quantity } = again.enter;
      if (input.signal.polarity !== 1 && input.signal.polarity !== -1) {
        messages.push("Auto-entry refused: polarity is not Drive or Reverse.");
        audit.push({ ...base, outcome: "blocked", reason: "Auto-entry refused: polarity is not Drive or Reverse." });
        return { acted, messages, audit };
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
        audit.push({ ...base, outcome: "entered", reason: again.reason, notes: again.notes, side, quantity, price });
      } else {
        messages.push(`Auto-entry failed: ${result.error}`);
        audit.push({ ...base, outcome: "error", reason: `Auto-entry failed: ${result.error}`, side, quantity, price });
      }
    } else if (decision.notes.length > 0) {
      messages.push(...decision.notes);
    }

    if (!acted && messages.length === 0) messages.push(decision.reason);
    else if (!acted && decision.reason && !messages.includes(decision.reason)) {
      messages.unshift(decision.reason);
    }

    if (audit.length === 0) {
      const outcome =
        decision.kind === "hold"
          ? "held"
          : decision.kind === "aside" || decision.kind === "off"
            ? "aside"
            : decision.kind === "skip"
              ? "skipped"
              : "blocked";
      audit.push({ ...base, outcome, reason: decision.reason, notes: decision.notes });
    }
    return { acted, messages, audit };
  } catch (err) {
    const message =
      err instanceof Error ? `Auto sim error: ${err.message}` : "Auto sim error: unexpected failure.";
    audit.push({ ...base, outcome: "error", reason: message });
    return { acted: false, messages: [message], audit };
  }
}
