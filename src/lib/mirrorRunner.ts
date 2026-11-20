/**
 * Live mirror (paper only): Alpaca follows POLARITO's SPY polarity tick by tick.
 *
 * POLARITO's principle is lockstep with the market: no prediction, no filter,
 * no lag. So this module adds NO signal logic of its own. Each tick it runs the
 * exact functions the dashboard runs, on the same live bars (today's forming
 * bar included, nothing dropped):
 *
 *   fetchRealMarketData -> computePolaritySeries -> buildAutoSimInput("signal-close")
 *     -> decideAuto (fixed sizing)
 *
 * and sends whatever that decision says: close + enter on a flip, close on
 * Neutral, enter on a fresh Drive/Reverse, nothing when already aligned. No
 * confirmation bars, no minimum hold, no hysteresis, no completed-bars filter.
 *
 * What it may refuse is only a safety rail, never the signal itself:
 *   - kill switch / enable flag / credentials (broker/config.ts)
 *   - market closed, or the latest bar is not today's (stale / holiday)
 *   - the daily loss limit: flatten SPY and stand aside until the next session
 *   - an SPY order that is still working at the broker
 *   - the shared risk caps already used by the sim (risk.ts) and a hard share cap
 *
 * Source of truth for equity, cash and positions is the Alpaca paper account.
 * Only plain SPY shares are traded; option positions are never touched.
 */
import { buildAuditRecord, type AuditDraft, type AuditRecord } from "@/lib/audit";
import { buildAutoSimInput, decideAuto, type AccountOf } from "@/lib/autoDecision";
import { DEFAULT_AUTO_SIM_PREFS, type AutoSimPrefs } from "@/lib/autoSimPrefs";
import { parseOccSymbol } from "@/lib/broker/options";
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import { placeIntent } from "@/lib/broker/execute";
import type { Broker, BrokerErrorCode, BrokerPosition, Result } from "@/lib/broker/types";
import { effectiveFillPrice } from "@/lib/fillModel";
import type { Position } from "@/lib/ledger";
import { newYorkClock, type RunReport, type TickerReport } from "@/lib/paperRunner";
import { computePolaritySeries, type Bar } from "@/lib/polarity";
import { MAX_SHARES } from "@/lib/risk";

export const MIRROR_TICKER = "SPY";
/** Same cadence as the dashboard's 5s refresh (PageRefresher.tsx PAGE_REFRESH_MS). */
export const MIRROR_TICK_GAP_MS = 5_000;
export const SESSION_OPEN_MINUTES = 9 * 60 + 30;
export const SESSION_CLOSE_MINUTES = 16 * 60;
export const DEFAULT_MIRROR_MAX_SHARES = 100;
export const DEFAULT_MIRROR_DAILY_LOSS_PCT = 2;

export type MirrorSettings = {
  /** Shares per entry, already clamped to maxShares. */
  quantity: number;
  maxShares: number;
  /** Flatten and stand aside once the account is down this percent on the day. */
  dailyLossPct: number;
  /** True when POLARITO_MIRROR_QTY was above the cap and had to be reduced. */
  clamped: boolean;
};

export interface MirrorBroker extends Broker {
  /** Number of still-working orders for one symbol. */
  openOrderCount(ticker: string): Promise<Result<number, BrokerErrorCode>>;
}

export type MirrorDeps = {
  broker: MirrorBroker;
  config: PaperBrokerConfig;
  loadBars: (ticker: string) => Promise<Bar[]>;
  audit: (record: AuditRecord) => void;
  now?: () => Date;
  /** Execution plumbing only (waiting for a close to fill); never delays the decision. */
  sleep?: (ms: number) => Promise<void>;
};

export function mirrorSettings(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; settings: MirrorSettings } | { ok: false; error: string } {
  const qty = Number((env.POLARITO_MIRROR_QTY ?? String(DEFAULT_AUTO_SIM_PREFS.quantity)).trim());
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_SHARES) {
    return { ok: false, error: `POLARITO_MIRROR_QTY must be a whole number from 1 to ${MAX_SHARES}.` };
  }
  const max = Number((env.POLARITO_MIRROR_MAX_SHARES ?? String(DEFAULT_MIRROR_MAX_SHARES)).trim());
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_SHARES) {
    return { ok: false, error: `POLARITO_MIRROR_MAX_SHARES must be a whole number from 1 to ${MAX_SHARES}.` };
  }
  const loss = Number((env.POLARITO_MIRROR_DAILY_LOSS_PCT ?? String(DEFAULT_MIRROR_DAILY_LOSS_PCT)).trim());
  if (!Number.isFinite(loss) || loss < 0.25 || loss > 10) {
    return { ok: false, error: "POLARITO_MIRROR_DAILY_LOSS_PCT must be between 0.25 and 10." };
  }
  return {
    ok: true,
    settings: { quantity: Math.min(qty, max), maxShares: max, dailyLossPct: loss, clamped: qty > max },
  };
}

/** Regular session, weekdays, New York time. Holidays are caught by the stale-bar check. */
export function sessionOpen(now: Date): boolean {
  const ny = newYorkClock(now);
  const day = new Date(`${ny.date}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return false;
  return ny.minutes >= SESSION_OPEN_MINUTES && ny.minutes < SESSION_CLOSE_MINUTES;
}

/** One id per action per minute: a retried tick in the same minute is a no-op, a later flip is not. */
export function mirrorClientOrderId(action: "enter" | "close", side: "long" | "short", now: Date): string {
  const minute = now.toISOString().replace(/\D/g, "").slice(0, 12);
  return `pol-mir-${MIRROR_TICKER}-${action}-${side}-${minute}`;
}

const isStockPosition = (p: BrokerPosition): boolean => parseOccSymbol(p.ticker) === null;

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

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FLAT_CHECKS = 10;
const FLAT_CHECK_MS = 300;

export async function runMirrorTick(
  deps: MirrorDeps,
  settings: MirrorSettings,
  options: { dryRun: boolean },
): Promise<RunReport> {
  const now = (deps.now ?? (() => new Date()))();
  const ranAt = now.toISOString();
  const sleep = deps.sleep ?? defaultSleep;
  const results: TickerReport[] = [];
  let dryRun = options.dryRun;
  const ticker = MIRROR_TICKER;

  const record = (draft: Omit<AuditDraft, "source" | "ticker">): void => {
    const rec = buildAuditRecord({ ...draft, source: "mirror-runner", ticker }, deps.now ? deps.now() : new Date());
    try {
      deps.audit(rec);
    } catch {
      /* an audit sink failure must not change what was decided or sent */
    }
    results.push({ ticker: rec.ticker, outcome: rec.outcome, reason: rec.reason });
  };
  const fail = (error: string): RunReport => {
    record({ outcome: "error", reason: error });
    return { ok: false, dryRun, ranAt, error, results };
  };

  try {
    if (!dryRun) {
      const gate = tradingGate(deps.config);
      if (!gate.ok) {
        if (gate.code !== "DISABLED") return fail(gate.error);
        if (!deps.config.configured) return fail("Paper credentials are not configured.");
        dryRun = true;
        record({ outcome: "dry-run", reason: "Paper trading is not switched on, so this tick only observes. No orders will be sent." });
      }
    }
    if (dryRun && !deps.config.configured) return fail("Paper credentials are not configured.");

    if (!sessionOpen(now)) {
      record({ outcome: "skipped", reason: "US market is closed. No orders outside 09:30-16:00 New York." });
      return { ok: true, dryRun, ranAt, results };
    }

    const accountRes = await deps.broker.getAccount();
    if (!accountRes.ok) return fail(`Cannot read the broker account: ${accountRes.error}`);
    const account = accountRes.value;
    if (account.status !== "ACTIVE" || account.tradingBlocked || account.accountBlocked) {
      return fail("Broker account is not active or trading is blocked.");
    }
    if (!(account.equity > 0) || !(account.lastEquity > 0)) return fail("Broker equity is not usable. No trading.");

    const positionsRes = await deps.broker.getPositions();
    if (!positionsRes.ok) return fail(`Cannot read broker positions: ${positionsRes.error}`);
    const stock = positionsRes.value.filter(isStockPosition);
    const held = stock.find((p) => p.ticker === ticker) ?? null;

    const openRes = await deps.broker.openOrderCount(ticker);
    if (!openRes.ok) return fail(`Cannot read open ${ticker} orders: ${openRes.error}`);
    if (openRes.value > 0) {
      record({ outcome: "skipped", reason: `A ${ticker} order is still working at the broker. Next tick decides again.` });
      return { ok: true, dryRun, ranAt, results };
    }

    let bars: Bar[];
    try {
      bars = await deps.loadBars(ticker);
    } catch (e) {
      return fail(`Could not load bars: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    // The same call chain the dashboard uses: live bars (forming bar included), signal-close.
    let input: ReturnType<typeof buildAutoSimInput>;
    try {
      input = buildAutoSimInput(ticker, computePolaritySeries(bars), "signal-close");
    } catch (e) {
      record({ outcome: "skipped", reason: `Bars failed validation: ${e instanceof Error ? e.message : "invalid data"}` });
      return { ok: true, dryRun, ranAt, results };
    }
    const today = newYorkClock(now).date;
    if (input && input.fill.date !== today) {
      record({
        signalDate: input.signal.date,
        polarity: input.signal.polarity,
        ready: input.signal.ready,
        outcome: "skipped",
        reason: `Latest bar (${input.fill.date}) is not today (${today}). No trade on stale data.`,
      });
      return { ok: true, dryRun, ranAt, results };
    }

    const base = {
      signalDate: input?.signal.date ?? null,
      polarity: input?.signal.polarity ?? null,
      ready: input?.signal.ready ?? null,
    };
    const notes: string[] = [];
    if (settings.clamped) notes.push(`Shares capped at ${settings.maxShares} (POLARITO_MIRROR_MAX_SHARES).`);

    const dayPnl = account.equity - account.lastEquity;
    const dayLossPct = (dayPnl / account.lastEquity) * 100;

    const sendClose = async (side: "long" | "short", why: string): Promise<boolean> => {
      if (dryRun) {
        record({ ...base, outcome: "dry-run", reason: `Would close ${side} ${held?.quantity ?? 0} ${ticker}. ${why}`, notes, side, quantity: held?.quantity });
        return true;
      }
      const cid = mirrorClientOrderId("close", side, now);
      const res = await placeIntent(deps.broker, deps.config, {
        action: "close",
        ticker,
        side,
        quantity: 0,
        signalDate: base.signalDate ?? today,
        timeInForce: "day",
        clientOrderId: cid,
      });
      if (!res.ok) {
        record({ ...base, outcome: res.code === "BROKER" ? "error" : "blocked", reason: res.error, notes, side, clientOrderId: cid });
        return false;
      }
      if (res.status === "submitted") {
        record({ ...base, outcome: "closed", reason: `${res.message} ${why}`, notes, side, quantity: res.order.quantity, orderId: res.order.id, clientOrderId: cid });
        return true;
      }
      record({ ...base, outcome: "held", reason: res.message, notes, side, clientOrderId: cid, orderId: res.order?.id });
      return false;
    };

    // Safety rail: daily loss limit. Flatten SPY and stand aside until the next session.
    if (dayLossPct <= -settings.dailyLossPct) {
      const why = `Daily loss limit (${settings.dailyLossPct}%) reached (${dayLossPct.toFixed(2)}% today). Standing aside until the next session.`;
      if (held) {
        await sendClose(held.side, why);
      } else {
        record({ ...base, outcome: "aside", reason: why, notes });
      }
      return { ok: true, dryRun, ranAt, results };
    }

    const accountOf: AccountOf = (state) => ({
      startingCash: account.lastEquity,
      closed: [{ realizedPnl: dayPnl, exitDate: today }],
      reservedNotional: state.positions.reduce((s, p) => s + p.quantity * p.avgPrice, 0),
      cashAvailable: Math.max(0, Math.min(account.cash, account.buyingPower)),
    });
    const prefs: AutoSimPrefs = {
      enabled: true,
      quantity: settings.quantity,
      sizingMode: "fixed",
      riskPct: DEFAULT_AUTO_SIM_PREFS.riskPct,
      fillMode: "signal-close",
    };
    const decision = decideAuto(input, { positions: stock.map(toPosition), closed: [] }, accountOf, prefs, now);
    notes.push(...decision.notes);

    if (decision.kind !== "act" || !input) {
      const outcome =
        decision.kind === "hold"
          ? "held"
          : decision.kind === "aside" || decision.kind === "off"
            ? "aside"
            : decision.kind === "skip"
              ? "skipped"
              : "blocked";
      record({ ...base, outcome, reason: decision.reason, notes });
      return { ok: true, dryRun, ranAt, results };
    }

    if (decision.close) {
      const closed = await sendClose(decision.close.side, decision.reason);
      if (!closed || !decision.enter) return { ok: true, dryRun, ranAt, results };
    }

    if (decision.enter) {
      const { side } = decision.enter;
      const quantity = Math.min(decision.enter.quantity, settings.maxShares);
      const price = effectiveFillPrice("enter", side, input.fill.price);
      if (dryRun) {
        record({ ...base, outcome: "dry-run", reason: `Would enter ${side} ${quantity} ${ticker}. ${decision.reason}`, notes, side, quantity, price });
        return { ok: true, dryRun, ranAt, results };
      }
      // A flip enters in the same tick: wait only for the close to show as filled.
      if (decision.close) {
        let flat = false;
        for (let i = 0; i < FLAT_CHECKS && !flat; i++) {
          const again = await deps.broker.getPositions();
          if (again.ok) flat = !again.value.some((p) => p.ticker === ticker);
          if (!flat) await sleep(FLAT_CHECK_MS);
        }
        if (!flat) {
          record({ ...base, outcome: "held", reason: `The ${ticker} close is not filled yet. The next tick enters the ${side} (the signal is unchanged).`, notes });
          return { ok: true, dryRun, ranAt, results };
        }
      }
      const cid = mirrorClientOrderId("enter", side, now);
      const res = await placeIntent(deps.broker, deps.config, {
        action: "enter",
        ticker,
        side,
        quantity,
        signalPolarity: input.signal.polarity,
        signalDate: input.signal.date,
        timeInForce: "day",
        clientOrderId: cid,
      });
      if (!res.ok) {
        record({ ...base, outcome: res.code === "BROKER" ? "error" : "blocked", reason: res.error, notes, side, quantity, price, clientOrderId: cid });
      } else if (res.status === "submitted") {
        record({ ...base, outcome: "entered", reason: `${res.message} ${decision.reason}`, notes, side, quantity, price, orderId: res.order.id, clientOrderId: cid });
      } else {
        record({ ...base, outcome: "held", reason: res.message, notes, side, clientOrderId: cid, orderId: res.order?.id });
      }
    }
    return { ok: true, dryRun, ranAt, results };
  } catch (e) {
    return fail(`Unexpected mirror failure: ${e instanceof Error ? e.name : "unknown"}`);
  }
}
