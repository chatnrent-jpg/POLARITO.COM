/**
 * Live "one stock a day" runner (real cash; ships switched off).
 *
 * Each tick (the GitHub loop calls it about every 10 seconds) it reads the live
 * Alpaca account, positions, working orders and TODAY's orders, derives the day's
 * state from those orders alone (liveOrders.ts), and then:
 *
 *   1. stops if anything cannot be read or validated (Justice: no trade on bad data);
 *   2. skips while any order is still working;
 *   3. stop-out: account down dailyLossPct on the day => flatten with the stop id
 *      and stand aside until the next session (no re-entry, by automation or by hand);
 *   4. end of day: flatten at flattenAt and stop entering;
 *   5. Auto gate: unless the persisted live Auto switch is ON (liveAutoStore.ts, default OFF,
 *      fail-closed), every signal-driven step below is only LOGGED as "would ..." and no
 *      order is sent. Steps 3 and 4 (and the loss-only backstop) are not gated;
 *   6. a held stock follows its own polarity (Neutral closes, a flip closes then enters
 *      the other side), exactly the rule the dashboard sim uses;
 *   7. when flat, the first entry of the day is the first ELIGIBLE name in the ranking
 *      (pickRank.ts); once an entry exists the day is locked to that one stock and
 *      later re-entries are for it only. Re-entry has no count limit: it is decided by
 *      market polarity alone. Only a stop-out or a 3-attempt close failure stops it.
 *
 * It adds no signal logic: polarity comes from computePolaritySeries /
 * buildAutoSimInput (the dashboard's own call chain) and the wanted side from
 * sideForPolarity. Sizing uses the shared risk engine with the live cap.
 * Only watchlist stocks are ever managed; other positions are left alone.
 */
import { buildAuditRecord, type AuditDraft, type AuditRecord } from "@/lib/audit";
import { buildAutoSimInput, isStale, sideForPolarity } from "@/lib/autoDecision";
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import { LIVE_SHORT_MIN_EQUITY, type LiveSettings } from "@/lib/broker/liveConfig";
import { placeLiveClose, placeLiveEntry, type LiveOrderResult } from "@/lib/broker/liveExecute";
import { closeBreakerTripped, deriveDayState, entryNumberFor, MAX_CLOSE_ATTEMPTS, type DayState } from "@/lib/broker/liveOrders";
import { parseOccSymbol } from "@/lib/broker/options";
import type { BrokerAccount, BrokerPosition, LiveBroker } from "@/lib/broker/types";
import { sessionOpen } from "@/lib/mirrorRunner";
import { newYorkClock, type RunReport, type TickerReport } from "@/lib/paperRunner";
import { computePolaritySeries, type Bar, type DayResult } from "@/lib/polarity";
import type { AutoState } from "@/lib/liveAutoStore";
import { rankCandidates, sizeLiveEntry, toReading, walkCandidates, type Reading } from "@/lib/pickRank";

export type PickDeps = {
  broker: LiveBroker;
  config: PaperBrokerConfig;
  loadBars: (ticker: string) => Promise<Bar[]>;
  audit: (record: AuditRecord) => void;
  now?: () => Date;
  /** Waiting for a close to fill only; never delays a decision. */
  sleep?: (ms: number) => Promise<void>;
  /** Reads the persisted live Auto switch. Missing or throwing means OFF (fail-closed). */
  readAuto?: () => Promise<AutoState>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FLAT_CHECKS = 10;
const FLAT_CHECK_MS = 300;
/** Order lookback: wide enough to cover any New York session date in UTC. */
const ORDER_LOOKBACK_MS = 36 * 3_600_000;
const PICK_LABEL = "PICK";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Watchlist is at most 10 names: the rank line plus one skip line each fits. */
const MAX_REPORT_NOTES = 25;
const MAX_NOTE_CHARS = 220;

export const isStockPosition = (p: BrokerPosition): boolean => parseOccSymbol(p.ticker) === null;

/** Why Alpaca would refuse a short on this account, or null when shorting is allowed. */
export function shortBlockedReason(account: BrokerAccount): string | null {
  if (account.equity < LIVE_SHORT_MIN_EQUITY) {
    return `shorting needs ${money(LIVE_SHORT_MIN_EQUITY)} of equity at Alpaca (equity is ${money(account.equity)}).`;
  }
  if (account.shortingEnabled !== true) return "the account does not report shorting as enabled.";
  return null;
}

const EASY_BORROW = /^(easy[_ -]?to[_ -]?borrow|etb)$/i;

export async function runPickTick(
  deps: PickDeps,
  settings: LiveSettings,
  options: { dryRun: boolean; lossOnly?: boolean },
): Promise<RunReport> {
  const now = (deps.now ?? (() => new Date()))();
  const ranAt = now.toISOString();
  const sleep = deps.sleep ?? defaultSleep;
  const results: TickerReport[] = [];
  let dryRun = options.dryRun;

  const record = (draft: Omit<AuditDraft, "source">): void => {
    const rec = buildAuditRecord({ ...draft, source: "pick-runner" }, deps.now ? deps.now() : new Date());
    try {
      deps.audit(rec);
    } catch {
      /* an audit sink failure must not change what was decided or sent */
    }
    // Dry and observe-only ticks also return the ranked list and each skipped stock's reason (no orders are sent
    // on them). Live ticks keep the full notes in the audit log only.
    const notes = dryRun && draft.notes && draft.notes.length > 0 ? draft.notes.slice(0, MAX_REPORT_NOTES).map((n) => n.slice(0, MAX_NOTE_CHARS)) : undefined;
    results.push({ ticker: rec.ticker, outcome: rec.outcome, reason: rec.reason, ...(notes ? { notes } : {}) });
  };
  const fail = (error: string): RunReport => {
    record({ ticker: PICK_LABEL, outcome: "error", reason: error });
    return { ok: false, dryRun, ranAt, error, results };
  };
  const done = (): RunReport => ({ ok: true, dryRun, ranAt, results });

  try {
    if (!dryRun) {
      const gate = tradingGate(deps.config);
      if (!gate.ok) {
        if (gate.code !== "DISABLED") return fail(gate.code === "NOT_CONFIGURED" ? "Live credentials are not configured." : gate.error);
        if (!deps.config.configured) return fail("Live credentials are not configured.");
        dryRun = true;
        record({ ticker: PICK_LABEL, outcome: "dry-run", reason: "Live trading is not switched on, so this tick only observes. No orders will be sent." });
      }
    }
    if (dryRun && !deps.config.configured) return fail("Live credentials are not configured.");

    if (!sessionOpen(now)) {
      record({ ticker: PICK_LABEL, outcome: "skipped", reason: "US market is closed. No orders outside 09:30-16:00 New York." });
      return done();
    }
    const ny = newYorkClock(now);
    const today = ny.date;

    const accountRes = await deps.broker.getAccount();
    if (!accountRes.ok) return fail(`Cannot read the broker account: ${accountRes.error}`);
    let account = accountRes.value;
    if (account.status !== "ACTIVE" || account.tradingBlocked || account.accountBlocked) {
      return fail("Broker account is not active or trading is blocked.");
    }
    if (!(account.equity > 0) || !(account.lastEquity > 0)) return fail("Broker equity is not usable. No trading.");

    const positionsRes = await deps.broker.getPositions();
    if (!positionsRes.ok) return fail(`Cannot read broker positions: ${positionsRes.error}`);
    let stock = positionsRes.value.filter(isStockPosition);

    const openRes = await deps.broker.listOpenOrders();
    if (!openRes.ok) return fail(`Cannot read working orders: ${openRes.error}`);
    const ordersRes = await deps.broker.listOrdersSince(new Date(now.getTime() - ORDER_LOOKBACK_MS).toISOString());
    if (!ordersRes.ok) return fail(`Cannot read today's orders: ${ordersRes.error}`);
    const state: DayState = deriveDayState(ordersRes.value, today);

    if (openRes.value.length > 0) {
      const first = openRes.value[0];
      record({
        ticker: first.ticker,
        outcome: "skipped",
        reason: `A ${first.ticker} order (${first.clientOrderId}) is still working at the broker. Next tick decides again.`,
      });
      return done();
    }

    // Set once the stop-out and flatten rails have passed (they ignore Auto).
    let auto: AutoState | null = null;
    const autoOffNote = (): string => (!dryRun && auto !== null && !auto.on ? ` Nothing was sent: ${auto.reason}` : "");

    const managed = stock.filter((p) => settings.watchlist.includes(p.ticker));
    const dayPnl = account.equity - account.lastEquity;
    const dayLossPct = (dayPnl / account.lastEquity) * 100;
    const notes: string[] = [];

    const closeManaged = async (pos: BrokerPosition, kind: "close" | "stop", why: string, signal: Partial<AuditDraft> = {}, dry: boolean = dryRun): Promise<boolean> => {
      if (dry) {
        record({ ...signal, ticker: pos.ticker, outcome: "dry-run", reason: `Would ${kind === "stop" ? "stop out and flatten" : "close"} ${pos.side} ${pos.quantity} ${pos.ticker}. ${why}${autoOffNote()}`, side: pos.side, quantity: pos.quantity });
        return true;
      }
      const res: LiveOrderResult = await placeLiveClose({ broker: deps.broker, config: deps.config, state, ticker: pos.ticker, side: pos.side, kind });
      if (!res.ok) {
        record({ ...signal, ticker: pos.ticker, outcome: res.code === "BROKER" || res.code === "BREAKER" ? "error" : "blocked", reason: res.error, side: pos.side, clientOrderId: res.clientOrderId });
        return false;
      }
      if (res.status === "submitted") {
        record({ ...signal, ticker: pos.ticker, outcome: "closed", reason: `${res.message} ${why}`, side: pos.side, quantity: res.order.quantity, orderId: res.order.id, clientOrderId: res.clientOrderId });
        return true;
      }
      record({ ...signal, ticker: pos.ticker, outcome: "held", reason: res.message, side: pos.side, clientOrderId: res.clientOrderId, orderId: res.order?.id });
      return false;
    };

    // Safety rail: daily account stop. Flatten the managed stock and stand aside until the next session.
    if (dayLossPct <= -settings.dailyLossPct || state.stoppedToday) {
      const why =
        dayLossPct <= -settings.dailyLossPct
          ? `Daily stop (${settings.dailyLossPct}%) reached (${dayLossPct.toFixed(2)}% today). Standing aside until the next session.`
          : "Stopped out earlier today. Standing aside until the next session.";
      if (managed.length === 0) {
        record({ ticker: state.lockTicker ?? PICK_LABEL, outcome: "aside", reason: why });
      }
      for (const pos of managed) await closeManaged(pos, "stop", why);
      return done();
    }

    const afterFlatten = settings.flattenAtMinutes !== null && ny.minutes >= settings.flattenAtMinutes;
    if (afterFlatten) {
      const why = `End-of-day flatten (${clock(settings.flattenAtMinutes as number)} New York). No new entries today.`;
      if (managed.length === 0) record({ ticker: state.lockTicker ?? PICK_LABEL, outcome: "aside", reason: why });
      for (const pos of managed) await closeManaged(pos, "close", why);
      return done();
    }

    if (options.lossOnly) {
      record({ ticker: PICK_LABEL, outcome: "held", reason: `Loss check: ${dayLossPct.toFixed(2)}% today, stop at -${settings.dailyLossPct}%. No action.` });
      return done();
    }

    // Auto gate for everything signal-driven. Stop-out and end-of-day flatten above ignore it.
    let autoRead: AutoState;
    try {
      autoRead = deps.readAuto
        ? await deps.readAuto()
        : { on: false, available: false, at: null, reason: "No Auto source is wired up. Auto is OFF." };
    } catch {
      autoRead = { on: false, available: true, at: null, reason: "Reading Auto failed. Auto is OFF." };
    }
    auto = autoRead;
    const signalDry = dryRun || !autoRead.on;
    if (!dryRun && !autoRead.on) {
      record({
        ticker: PICK_LABEL,
        outcome: "aside",
        reason: `Live Auto is OFF: no entries, re-entries or signal-driven closes are sent (only the ${settings.dailyLossPct}% stop-out and the end-of-day flatten still run). ${autoRead.reason}`,
      });
    }

    const barsCache = new Map<string, { bars: Bar[]; series: DayResult[] } | { error: string }>();
    const analyze = async (ticker: string) => {
      const cached = barsCache.get(ticker);
      if (cached) return cached;
      let entry: { bars: Bar[]; series: DayResult[] } | { error: string };
      try {
        const bars = await deps.loadBars(ticker);
        entry = { bars, series: computePolaritySeries(bars) };
        if (entry.series.length === 0) entry = { error: "no bars." };
      } catch (e) {
        entry = { error: e instanceof Error ? e.message.slice(0, 120) : "bars could not be loaded." };
      }
      barsCache.set(ticker, entry);
      return entry;
    };

    const attemptEntry = async (tickers: readonly string[], why: string): Promise<void> => {
      const readings: Reading[] = [];
      const skips: string[] = [];
      for (const t of tickers) {
        const a = await analyze(t);
        if ("error" in a) skips.push(`${t}: ${a.error}`);
        else readings.push(toReading(t, a.bars, a.series));
      }
      const ranked = rankCandidates(readings);
      const rankLine = `Ranked: ${ranked.map((c) => `${c.key} ${c.score.toFixed(2)}`).join(", ") || "none"}.`;
      const reserved = () => stock.reduce((s, p) => s + p.quantity * p.avgEntryPrice, 0);
      const shortBlocked = shortBlockedReason(account);

      const walked = await walkCandidates(ranked, {
        today,
        shortBlocked,
        longOnlyFallback: settings.longOnlyFallback,
        checkAsset: async (ticker, side) => {
          const asset = await deps.broker.getAsset(ticker);
          if (!asset.ok) return `asset check failed (${asset.error}).`;
          if (!asset.value) return "asset not found at Alpaca.";
          if (asset.value.status.toLowerCase() !== "active") return `asset is ${asset.value.status}, not active.`;
          if (!asset.value.tradable) return "asset is not tradable.";
          if (side === "short") {
            if (!asset.value.shortable) return "asset is not shortable.";
            if (asset.value.borrowStatus === null || !EASY_BORROW.test(asset.value.borrowStatus)) {
              return `borrow status is ${asset.value.borrowStatus ?? "unknown"}, not easy to borrow.`;
            }
          }
          return null;
        },
        size: (r, side) =>
          sizeLiveEntry(
            {
              price: r.price,
              equity: account.equity,
              lastEquity: account.lastEquity,
              cash: account.cash,
              buyingPower: account.buyingPower,
              reservedNotional: reserved(),
              today,
              quantity: settings.quantity,
              maxPositionPct: settings.maxPositionPct,
              dailyLossPct: settings.dailyLossPct,
            },
            side,
          ),
      });
      const allNotes = [rankLine, ...skips, ...walked.skips];

      if (walked.aside) {
        record({ ticker: PICK_LABEL, outcome: "aside", reason: walked.aside, notes: allNotes });
        return;
      }
      if (!walked.pick) {
        record({ ticker: PICK_LABEL, outcome: "aside", reason: `No eligible candidate right now. ${why}`.trim(), notes: allNotes });
        return;
      }
      const { reading, side, quantity } = walked.pick;
      const base = {
        ticker: reading.ticker,
        signalDate: reading.barDate,
        polarity: reading.polarity,
        ready: reading.ready,
        side,
        quantity,
        price: reading.price,
        notes: [...allNotes, ...walked.pick.notes],
      };
      if (signalDry) {
        record({ ...base, outcome: "dry-run", reason: `Would enter ${side} ${quantity} ${reading.ticker} as entry ${state.maxEntry + 1}. ${why}${autoOffNote()}`.trim() });
        return;
      }
      const res = await placeLiveEntry({
        broker: deps.broker,
        config: deps.config,
        date: today,
        nn: state.maxEntry + 1,
        ticker: reading.ticker,
        side,
        quantity,
        polarity: reading.polarity,
        signalDate: reading.barDate,
      });
      if (!res.ok) {
        record({ ...base, outcome: res.code === "BROKER" ? "error" : "blocked", reason: res.error, clientOrderId: res.clientOrderId });
      } else if (res.status === "submitted") {
        record({ ...base, outcome: "entered", reason: `${res.message} ${why}`.trim(), orderId: res.order.id, clientOrderId: res.clientOrderId });
      } else {
        record({ ...base, outcome: "held", reason: res.message, clientOrderId: res.clientOrderId, orderId: res.order?.id });
      }
    };

    const entryBlocker = (): string | null => {
      if (state.stoppedToday) return "Stopped out today. No re-entry until the next session.";
      if (state.lockTicker && !settings.watchlist.includes(state.lockTicker)) {
        return `Today's stock ${state.lockTicker} is no longer on the watchlist. Standing aside.`;
      }
      if (!state.lockTicker && ny.minutes < settings.pickStartMinutes) {
        return `Pick starts at ${clock(settings.pickStartMinutes)} New York.`;
      }
      return null;
    };

    // A held watchlist stock follows its own polarity.
    if (managed.length > 0) {
      for (const pos of managed) {
        const nn = entryNumberFor(state, pos.ticker);
        if (closeBreakerTripped(state, pos.ticker, nn)) {
          record({
            ticker: pos.ticker,
            outcome: "error",
            reason: `${MAX_CLOSE_ATTEMPTS} close attempts for ${pos.ticker} failed. Circuit breaker: no new entries. Close it in Alpaca's own dashboard.`,
            side: pos.side,
          });
          continue;
        }
        const a = await analyze(pos.ticker);
        if ("error" in a) {
          record({ ticker: pos.ticker, outcome: "skipped", reason: `Could not read bars for the held ${pos.ticker}: ${a.error} Holding.`, side: pos.side });
          continue;
        }
        const input = buildAutoSimInput(pos.ticker, a.series, "signal-close");
        const sig = input ? { signalDate: input.signal.date, polarity: input.signal.polarity, ready: input.signal.ready } : {};
        if (!input || input.fill.date !== today || isStale(input.fill.date, now)) {
          record({ ticker: pos.ticker, ...sig, outcome: "skipped", reason: `Latest bar is not today's (${today}). No trade on stale data. Holding.`, side: pos.side });
          continue;
        }
        const wanted = sideForPolarity(input.signal);
        if (wanted === pos.side) {
          record({ ticker: pos.ticker, ...sig, outcome: "held", reason: `Already ${pos.side} ${pos.quantity} ${pos.ticker}. Polarity unchanged.`, side: pos.side, quantity: pos.quantity });
          continue;
        }
        const why =
          wanted === null
            ? input.signal.ready ? "Polarity went to 0 (Neutral). Closed the position." : "Not enough history yet. Closed the position."
            : `Polarity flipped. Closed the ${pos.side} and going ${wanted}.`;
        const closed = await closeManaged(pos, "close", why, sig, signalDry);
        if (!closed || wanted === null) continue;

        // Flip: enter the other side of the SAME stock once the close shows as filled.
        const blocker = entryBlocker();
        if (blocker) {
          record({ ticker: pos.ticker, ...sig, outcome: "aside", reason: blocker });
          continue;
        }
        if (signalDry) {
          await attemptEntry([pos.ticker], "Flip entry.");
          continue;
        }
        let flat = false;
        for (let i = 0; i < FLAT_CHECKS && !flat; i++) {
          const again = await deps.broker.getPositions();
          if (again.ok) {
            flat = !again.value.some((p) => p.ticker === pos.ticker);
            if (flat) stock = again.value.filter(isStockPosition);
          }
          if (!flat) await sleep(FLAT_CHECK_MS);
        }
        if (!flat) {
          record({ ticker: pos.ticker, ...sig, outcome: "held", reason: `The ${pos.ticker} close is not filled yet. The next tick enters the ${wanted} (the signal is unchanged).` });
          continue;
        }
        const fresh = await deps.broker.getAccount();
        if (!fresh.ok) {
          record({ ticker: pos.ticker, ...sig, outcome: "skipped", reason: `Cannot re-read the account after the close: ${fresh.error} Next tick decides again.` });
          continue;
        }
        account = fresh.value;
        await attemptEntry([pos.ticker], "Flip entry.");
      }
      return done();
    }

    // Flat in every watchlist stock: re-enter the day's stock, or pick one.
    const blocker = entryBlocker();
    if (blocker) {
      record({ ticker: state.lockTicker ?? PICK_LABEL, outcome: "aside", reason: blocker, notes });
      return done();
    }
    const candidates = state.lockTicker ? [state.lockTicker] : settings.watchlist;
    await attemptEntry(candidates, state.lockTicker ? `Re-entry in today's stock ${state.lockTicker}.` : "");
    return done();
  } catch (e) {
    return fail(`Unexpected pick failure: ${e instanceof Error ? e.name : "unknown"}`);
  }
}
