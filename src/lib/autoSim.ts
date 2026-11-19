/**
 * Simulated auto enter / close for the paper ledger.
 *
 * Rules (same discipline as the manual OrderModule gate):
 *   Wisdom  — Neutral / unready => STAND ASIDE (no entry; close open positions).
 *             Drive => long only; Reverse => short only.
 *   Courage — When auto is on and a valid signal exists, execute via ledger APIs
 *             with no review dialog and no discretionary bypass.
 *   Temperance — Size from prefs.quantity; cash and canOpen still enforced.
 *   Justice — Refuse bad/unready analysis; never claim success on failed writes.
 *
 * Manual OrderModule / LedgerPanel stay unchanged. Auto only acts on the
 * ticker currently analyzed, at the last daily close (same fill basis as manual).
 */
import {
  addLedgerEntry,
  canOpen,
  closeActivePosition,
  computeAccount,
  getLedgerSnapshot,
  newEntryId,
  type LedgerEntry,
  type LedgerSnapshot,
  type Position,
} from "@/lib/ledger";
import { getAccountDef, type AccountId } from "@/lib/multiAccount";
import { evaluateGuard, type OrderSide } from "@/lib/orderGuard";
import type { Polarity } from "@/lib/polarity";
import type { AutoSimPrefs } from "@/lib/autoSimPrefs";

export type AutoSimAnalysis = {
  ticker: string;
  polarity: Polarity;
  close: number;
  asOf: string;
  ready: boolean;
};

export type AutoSimDecision = {
  /** Close open position on this ticker before any entry (full quantity). */
  close: Position | null;
  /** Open a new aligned position when flat (or after a flip close). */
  enter: { side: OrderSide; quantity: number } | null;
  reason: string;
};

export type AutoSimApplyResult = {
  acted: boolean;
  messages: string[];
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Side required by polarity, or null when aside (Neutral / unready). */
export function sideForPolarity(
  analysis: Pick<AutoSimAnalysis, "polarity" | "ready">,
): OrderSide | null {
  if (!analysis.ready) return null;
  if (analysis.polarity === 1) return "long";
  if (analysis.polarity === -1) return "short";
  return null;
}

/**
 * Pure decision: given analysis + ledger snapshot + sizing, what should auto do?
 * Does not mutate storage.
 */
export function decideAutoSim(
  analysis: AutoSimAnalysis | null,
  ledger: LedgerSnapshot,
  prefs: AutoSimPrefs,
): AutoSimDecision {
  if (!prefs.enabled) {
    return { close: null, enter: null, reason: "Auto sim is off." };
  }
  if (!analysis) {
    return { close: null, enter: null, reason: "No analyzed ticker." };
  }
  if (!(analysis.close > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(analysis.asOf)) {
    return { close: null, enter: null, reason: "Mark price or date is not usable." };
  }

  const open = ledger.positions.filter((p) => p.ticker === analysis.ticker);
  const wanted = sideForPolarity(analysis);

  // Wisdom: unready or Neutral => flat. Close any open position on this ticker.
  if (wanted === null) {
    if (open.length === 0) {
      return {
        close: null,
        enter: null,
        reason: analysis.ready
          ? "Neutral — standing aside."
          : "Insufficient history — standing aside.",
      };
    }
    // Prefer closing the single position; if legacy dual sides exist, close first found.
    return {
      close: open[0],
      enter: null,
      reason: analysis.ready
        ? "Neutral — closing to stand aside."
        : "Insufficient history — closing to stand aside.",
    };
  }

  // Position no longer aligned with gear => close (and possibly flip).
  const misaligned = open.find((p) => p.side !== wanted) ?? null;
  if (misaligned) {
    const guard = evaluateGuard(analysis, wanted);
    const afterClose: LedgerSnapshot = {
      ...ledger,
      positions: ledger.positions.filter(
        (p) => !(p.ticker === misaligned.ticker && p.side === misaligned.side),
      ),
    };
    const openCheck = canOpen(afterClose, analysis.ticker, wanted);
    const account = computeAccount(
      afterClose,
      {},
      getAccountDef(ledger.accountId).initialBalance,
    );
    const notional = prefs.quantity * analysis.close;
    const canEnter =
      guard.canSubmit &&
      openCheck.ok &&
      prefs.quantity >= 1 &&
      notional <= account.cashAvailable &&
      // Only open when flat on this ticker after the close (no scale-in).
      !afterClose.positions.some((p) => p.ticker === analysis.ticker);

    return {
      close: misaligned,
      enter: canEnter ? { side: wanted, quantity: prefs.quantity } : null,
      reason: canEnter
        ? `Flip: close ${misaligned.side}, enter ${wanted}.`
        : `Close misaligned ${misaligned.side}; entry blocked.`,
    };
  }

  // Already aligned — do not add size on every refresh.
  if (open.some((p) => p.side === wanted)) {
    return {
      close: null,
      enter: null,
      reason: `Holding ${wanted}; signal still aligned.`,
    };
  }

  // Flat + aligned signal => enter once.
  const guard = evaluateGuard(analysis, wanted);
  if (!guard.canSubmit) {
    return { close: null, enter: null, reason: guard.message ?? "Entry blocked by safety gate." };
  }
  const openCheck = canOpen(ledger, analysis.ticker, wanted);
  if (!openCheck.ok) {
    return { close: null, enter: null, reason: openCheck.error };
  }
  const account = computeAccount(ledger, {}, getAccountDef(ledger.accountId).initialBalance);
  const notional = prefs.quantity * analysis.close;
  if (prefs.quantity < 1 || notional > account.cashAvailable) {
    return {
      close: null,
      enter: null,
      reason: `Insufficient cash for ${prefs.quantity} shares (${money(notional)} > ${money(account.cashAvailable)}).`,
    };
  }

  return {
    close: null,
    enter: { side: wanted, quantity: prefs.quantity },
    reason: `Enter ${wanted} on aligned gear.`,
  };
}

/**
 * Apply a decision against the live ledger for `accountId`.
 * Close runs before enter so a polarity flip can reverse in one tick.
 */
export function applyAutoSim(
  analysis: AutoSimAnalysis,
  prefs: AutoSimPrefs,
  accountId: AccountId,
): AutoSimApplyResult {
  const messages: string[] = [];
  try {
    const ledger = getLedgerSnapshot();
    if (ledger.accountId !== accountId) {
      return {
        acted: false,
        messages: ["Active account changed; auto sim skipped this tick."],
      };
    }

    const decision = decideAutoSim(analysis, ledger, prefs);
    let acted = false;

    if (decision.close) {
      const c = decision.close;
      const result = closeActivePosition(c.ticker, c.quantity, analysis.close, {
        accountId,
        side: c.side,
        exitDate: analysis.asOf,
      });
      if (result.ok) {
        acted = true;
        messages.push(
          `Auto-closed ${result.trade.side.toUpperCase()} ${result.trade.quantity.toLocaleString("en-US")} ${result.trade.ticker} @ ${money(result.trade.exitPrice)} (close of ${analysis.asOf}). Realized ${money(result.trade.realizedPnl)}.`,
        );
      } else {
        messages.push(`Auto-close failed: ${result.error}`);
        return { acted, messages };
      }
    }

    if (decision.enter) {
      const side = decision.enter.side;
      const quantity = decision.enter.quantity;
      // Re-check after close against a fresh snapshot (Justice).
      const after = getLedgerSnapshot();
      if (after.accountId !== accountId) {
        messages.push("Active account changed before auto-entry; entry skipped.");
        return { acted, messages };
      }
      const reDecision = decideAutoSim(analysis, after, { ...prefs, enabled: true });
      if (!reDecision.enter || reDecision.enter.side !== side) {
        if (!acted) messages.push(reDecision.reason);
        return { acted, messages };
      }

      if (analysis.polarity !== 1 && analysis.polarity !== -1) {
        messages.push("Auto-entry refused: polarity is not Drive or Reverse.");
        return { acted, messages };
      }
      const entry: LedgerEntry = {
        id: newEntryId(),
        createdAt: new Date().toISOString(),
        simulated: true,
        ticker: analysis.ticker,
        side,
        quantity,
        price: analysis.close,
        priceBasis: "last daily close",
        priceDate: analysis.asOf,
        polarityAtEntry: analysis.polarity,
        notional: quantity * analysis.close,
      };

      const result = addLedgerEntry(entry, accountId);
      if (result.ok) {
        acted = true;
        messages.push(
          `Auto-entered ${side.toUpperCase()} ${quantity.toLocaleString("en-US")} ${analysis.ticker} @ ${money(analysis.close)} (close of ${analysis.asOf}).`,
        );
      } else {
        messages.push(`Auto-entry failed: ${result.error}`);
      }
    }

    if (!acted && messages.length === 0) {
      messages.push(decision.reason);
    }
    return { acted, messages };
  } catch (err) {
    return {
      acted: false,
      messages: [
        err instanceof Error
          ? `Auto sim error: ${err.message}`
          : "Auto sim error: unexpected failure.",
      ],
    };
  }
}
