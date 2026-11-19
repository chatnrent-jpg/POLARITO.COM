/**
 * Server-side paper-trading cycle. Runs after the US close, once per session.
 *
 * Source of truth: the Alpaca PAPER account. Equity, cash and positions come
 * from the broker, never from the browser ledger.
 *
 * Flow per ticker: completed daily bars -> polarity -> the same pure decision
 * the browser sim uses (autoDecision.ts) -> executor (idempotent, reconciled
 * against the broker) -> one audit record. Orders are DAY market orders sent
 * after the close, so they queue for the next open (the "next-open" model).
 *
 * Virtues:
 *   Wisdom     - same regime gate as the sim: Neutral / unready => flat.
 *   Courage    - a valid decision is sent with no human step in the path.
 *   Temperance - fixed shares by default, still checked by the risk guard; daily loss / profit boundaries from the broker's
 *                own equity, in-cycle exposure tracking so several tickers can
 *                never oversubscribe the account; closes are never blocked.
 *   Justice    - an account we cannot read, bars we cannot validate, or any
 *                failure means NO order; every outcome is audited truthfully.
 *
 * Known limits (documented, not hidden):
 *   - Losing-streak scale-down needs closed-trade history, which the broker
 *     does not hand over cheaply; here the streak is not applied.
 *   - A flip (long <-> short) closes first; the re-entry waits for the next
 *     session once the broker confirms flat.
 */
import { buildAuditRecord, type AuditDraft, type AuditRecord } from "@/lib/audit";
import { decideAuto, buildAutoSimInput, type AccountOf, type AutoSimInput } from "@/lib/autoDecision";
import type { AutoSimPrefs } from "@/lib/autoSimPrefs";
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import { clientOrderIdFor, placeIntent } from "@/lib/broker/execute";
import type { Broker, BrokerPosition } from "@/lib/broker/types";
import { effectiveFillPrice } from "@/lib/fillModel";
import type { Position } from "@/lib/ledger";
import { computePolaritySeries, type Bar } from "@/lib/polarity";
import { normalizeTicker } from "@/lib/ticker";

export const MAX_WATCHLIST = 10;
/** Regular session closes 16:00 New York; allow a few minutes for the daily bar to finalize. */
export const BAR_FINAL_MINUTES = 16 * 60 + 15;

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export type RunnerSettings = { watchlist: string[]; prefs: AutoSimPrefs };

export function paperRunnerSettings(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; settings: RunnerSettings } | { ok: false; error: string } {
  const rawList = (env.POLARITO_PAPER_WATCHLIST ?? "").trim();
  if (rawList === "") {
    return { ok: false, error: "POLARITO_PAPER_WATCHLIST is empty. Nothing to trade." };
  }
  const watchlist: string[] = [];
  for (const part of rawList.split(/[\s,]+/).filter(Boolean)) {
    const t = normalizeTicker(part);
    if (!t) return { ok: false, error: `POLARITO_PAPER_WATCHLIST has an invalid ticker: "${part.slice(0, 12)}".` };
    if (!watchlist.includes(t)) watchlist.push(t);
  }
  if (watchlist.length > MAX_WATCHLIST) {
    return { ok: false, error: `POLARITO_PAPER_WATCHLIST allows at most ${MAX_WATCHLIST} tickers.` };
  }

  const sizing = (env.POLARITO_PAPER_SIZING ?? "fixed").trim().toLowerCase();
  if (sizing !== "risk" && sizing !== "fixed") {
    return { ok: false, error: 'POLARITO_PAPER_SIZING must be "risk" or "fixed".' };
  }
  const riskPct = Number((env.POLARITO_PAPER_RISK_PCT ?? "0.5").trim());
  if (!Number.isFinite(riskPct) || riskPct < 0.05 || riskPct > 2) {
    return { ok: false, error: "POLARITO_PAPER_RISK_PCT must be between 0.05 and 2." };
  }
  const quantity = Number((env.POLARITO_PAPER_QTY ?? "1").trim());
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100_000) {
    return { ok: false, error: "POLARITO_PAPER_QTY must be a whole number from 1 to 100000." };
  }
  return {
    ok: true,
    settings: {
      watchlist,
      prefs: { enabled: true, quantity, sizingMode: sizing, riskPct, fillMode: "signal-close" },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Completed bars (New York time)                                             */
/* -------------------------------------------------------------------------- */

export function newYorkClock(now: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Drop any bar that may still be forming: today's bar before the close has
 * finalized, and anything dated in the future. A signal is only ever taken
 * from a COMPLETED bar.
 */
export function completedBars(bars: readonly Bar[], now: Date): Bar[] {
  const ny = newYorkClock(now);
  return bars.filter((b) => {
    if (b.date > ny.date) return false;
    if (b.date === ny.date && ny.minutes < BAR_FINAL_MINUTES) return false;
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Cycle                                                                      */
/* -------------------------------------------------------------------------- */

export type RunnerDeps = {
  broker: Broker;
  config: PaperBrokerConfig;
  loadBars: (ticker: string) => Promise<Bar[]>;
  audit: (record: AuditRecord) => void;
  now?: () => Date;
};

export type TickerReport = { ticker: string; outcome: AuditRecord["outcome"]; reason: string };

export type RunReport =
  | { ok: true; dryRun: boolean; ranAt: string; results: TickerReport[] }
  | { ok: false; dryRun: boolean; ranAt: string; error: string; results: TickerReport[] };

function toPosition(p: BrokerPosition): Position {
  return {
    ticker: p.ticker,
    side: p.side,
    quantity: p.quantity,
    avgPrice: p.avgEntryPrice,
    openedAt: "",
    updatedAt: "",
    fills: 1,
    polarityAtEntry: 0,
  };
}

export async function runPaperCycle(
  deps: RunnerDeps,
  settings: RunnerSettings,
  options: { dryRun: boolean },
): Promise<RunReport> {
  const now = (deps.now ?? (() => new Date()))();
  const ranAt = now.toISOString();
  const results: TickerReport[] = [];
  let dryRun = options.dryRun;

  const record = (draft: AuditDraft): void => {
    const rec = buildAuditRecord(draft, deps.now ? deps.now() : new Date());
    try {
      deps.audit(rec);
    } catch {
      /* an audit sink failure must not change what was decided or sent */
    }
    results.push({ ticker: rec.ticker, outcome: rec.outcome, reason: rec.reason });
  };
  const fail = (error: string): RunReport => {
    record({ source: "paper-runner", ticker: "-", outcome: "error", reason: error });
    return { ok: false, dryRun, ranAt, error, results };
  };

  try {
    // A real run needs the full gate (enabled, not killed, configured). A dry
    // run only reads, so it needs credentials but not the enable switch.
    // Until trading is switched on, a scheduled run observes instead of
    // refusing: it decides and logs exactly what it would do and sends nothing.
    // The kill switch and missing credentials still stop everything.
    if (!dryRun) {
      const gate = tradingGate(deps.config);
      if (!gate.ok) {
        if (gate.code !== "DISABLED") return fail(gate.error);
        if (!deps.config.configured) return fail("Paper credentials are not configured.");
        dryRun = true;
        record({
          source: "paper-runner",
          ticker: "-",
          outcome: "dry-run",
          reason: "Paper trading is not switched on, so this run only observes. No orders will be sent.",
        });
      }
    }
    if (dryRun && !deps.config.configured) {
      return fail("Paper credentials are not configured.");
    }

    const accountRes = await deps.broker.getAccount();
    if (!accountRes.ok) return fail(`Cannot read the broker account: ${accountRes.error}`);
    const account = accountRes.value;
    if (account.status !== "ACTIVE" || account.tradingBlocked || account.accountBlocked) {
      return fail("Broker account is not active or trading is blocked.");
    }
    if (!(account.equity > 0) || !(account.lastEquity > 0)) {
      return fail("Broker equity is not usable. No trading.");
    }
    const positionsRes = await deps.broker.getPositions();
    if (!positionsRes.ok) return fail(`Cannot read broker positions: ${positionsRes.error}`);
    const positions = positionsRes.value.map(toPosition);

    const dayPnl = account.equity - account.lastEquity;
    // Notional of entries queued earlier in THIS cycle (not yet in broker cash).
    let pendingNotional = 0;

    for (const ticker of settings.watchlist) {
      try {
        let bars: Bar[];
        try {
          bars = await deps.loadBars(ticker);
        } catch (e) {
          record({
            source: "paper-runner",
            ticker,
            outcome: "error",
            reason: `Could not load bars: ${e instanceof Error ? e.message : "unknown error"}`,
          });
          continue;
        }
        const completed = completedBars(bars, now);
        let input: AutoSimInput | null;
        try {
          input = buildAutoSimInput(ticker, computePolaritySeries(completed), "signal-close");
        } catch (e) {
          record({
            source: "paper-runner",
            ticker,
            outcome: "skipped",
            reason: `Bars failed validation: ${e instanceof Error ? e.message : "invalid data"}`,
          });
          continue;
        }

        const day = input?.fill.date ?? "";
        const accountOf: AccountOf = (state) => ({
          startingCash: account.lastEquity,
          closed: [{ realizedPnl: dayPnl, exitDate: day }],
          reservedNotional:
            state.positions.reduce((s, p) => s + p.quantity * p.avgPrice, 0) + pendingNotional,
          cashAvailable: Math.max(0, Math.min(account.cash, account.buyingPower) - pendingNotional),
        });

        const decision = decideAuto(input, { positions, closed: [] }, accountOf, settings.prefs, now);
        const base = {
          source: "paper-runner" as const,
          ticker,
          signalDate: input?.signal.date ?? null,
          polarity: input?.signal.polarity ?? null,
          ready: input?.signal.ready ?? null,
        };

        if (decision.kind !== "act" || !input) {
          const outcome =
            decision.kind === "hold" ? "held" : decision.kind === "aside" || decision.kind === "off" ? "aside" : decision.kind === "skip" ? "skipped" : "blocked";
          record({ ...base, outcome, reason: decision.reason, notes: decision.notes });
          continue;
        }

        if (decision.close) {
          const c = decision.close;
          const notes = [...decision.notes];
          if (decision.enter) notes.push("Flip: re-entry deferred to the next session once flat is confirmed.");
          if (dryRun) {
            record({ ...base, outcome: "dry-run", reason: `Would close ${c.side} ${c.quantity} ${ticker}. ${decision.reason}`, notes, side: c.side, quantity: c.quantity });
            continue;
          }
          const res = await placeIntent(deps.broker, deps.config, {
            action: "close",
            ticker,
            side: c.side,
            quantity: 0,
            signalDate: input.signal.date,
            timeInForce: "day",
          });
          const cid = clientOrderIdFor({ action: "close", ticker, side: c.side, signalDate: input.signal.date });
          if (!res.ok) {
            record({ ...base, outcome: res.code === "BROKER" ? "error" : "blocked", reason: res.error, notes, side: c.side, clientOrderId: cid });
          } else if (res.status === "submitted") {
            record({ ...base, outcome: "closed", reason: `${res.message} ${decision.reason}`, notes, side: c.side, quantity: res.order.quantity, orderId: res.order.id, clientOrderId: cid });
          } else {
            record({ ...base, outcome: "held", reason: res.message, notes, side: c.side, clientOrderId: cid, orderId: res.order?.id });
          }
          continue;
        }

        if (decision.enter) {
          const { side, quantity } = decision.enter;
          const price = effectiveFillPrice("enter", side, input.fill.price);
          if (dryRun) {
            record({ ...base, outcome: "dry-run", reason: `Would enter ${side} ${quantity} ${ticker}. ${decision.reason}`, notes: decision.notes, side, quantity, price });
            continue;
          }
          const res = await placeIntent(deps.broker, deps.config, {
            action: "enter",
            ticker,
            side,
            quantity,
            signalPolarity: input.signal.polarity,
            signalDate: input.signal.date,
            timeInForce: "day",
          });
          const cid = clientOrderIdFor({ action: "enter", ticker, side, signalDate: input.signal.date });
          if (!res.ok) {
            record({ ...base, outcome: res.code === "BROKER" ? "error" : "blocked", reason: res.error, notes: decision.notes, side, quantity, price, clientOrderId: cid });
          } else if (res.status === "submitted") {
            pendingNotional += quantity * price;
            record({ ...base, outcome: "entered", reason: `${res.message} ${decision.reason}`, notes: decision.notes, side, quantity, price, orderId: res.order.id, clientOrderId: cid });
          } else {
            record({ ...base, outcome: "held", reason: res.message, notes: decision.notes, side, clientOrderId: cid, orderId: res.order?.id });
          }
        }
      } catch (e) {
        record({
          source: "paper-runner",
          ticker,
          outcome: "error",
          reason: `Unexpected failure: ${e instanceof Error ? e.name : "unknown"}`,
        });
      }
    }
    return { ok: true, dryRun, ranAt, results };
  } catch (e) {
    return fail(`Unexpected runner failure: ${e instanceof Error ? e.name : "unknown"}`);
  }
}
