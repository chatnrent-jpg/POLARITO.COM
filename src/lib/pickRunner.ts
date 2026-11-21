/**
 * Live pick runner: up to LIVE_LIMITS.maxPositions (3) stocks at a time, real cash; ships switched off.
 *
 * State flow (one direction): Alpaca account + positions + working orders + today's orders -> DayState ->
 * rails -> held positions follow their own polarity -> free slots are filled from the ranked watchlist.
 *
 * Each tick (the GitHub loop calls it about every 10 seconds) it reads the live Alpaca account, positions,
 * working orders and TODAY's orders, derives the day's state from those orders alone (liveOrders.ts), and then:
 *
 *   1. stops if anything cannot be read or validated (Justice: no trade on bad data);
 *   2. skips while any order is still working;
 *   3. stop-out: the WHOLE account down dailyLossPct on the day (equity vs Alpaca's last_equity, summed over
 *      every stock) => flatten every position with the stop id and stand aside until the next session;
 *   4. end of day: flatten at flattenAt and stop entering;
 *   5. Auto gate: unless the persisted live Auto switch is ON (liveAutoStore.ts, default OFF,
 *      fail-closed), every signal-driven step below is only LOGGED as "would ..." and no
 *      order is sent. Steps 3 and 4 (and the loss-only backstop) are not gated;
 *   6. each held watchlist stock follows its own polarity: Neutral or Reverse closes it (long only, so a
 *      Reverse never opens a short);
 *   7. free slots (maxPositions minus held positions minus working orders) are filled one order at a time
 *      from the ranking (pickRank.ts), best first. Each entry is sized by the shared risk engine to at most
 *      perPositionCapPct of equity in whole shares (a stock that rounds to zero shares is skipped and the note
 *      says so), under the total exposure cap and cash. Before every entry after the first, the account,
 *      positions and working orders are re-read, and the entry waits for the previous fill, so two entries
 *      can never be sized against stale cash or push the account past the slot limit.
 *
 * Re-entry rule (per ticker): the automatic pick enters a ticker at most once per New York day
 * (LIVE_LIMITS.maxAutoEntriesPerTickerPerDay). After a signal-driven close (Neutral or Reverse) that ticker
 * stays out until the next session; its slot goes to the next-ranked candidate that has not been entered today.
 * A stop-out ends all entries for the day. Entries start at pickStart (default 10:00 New York).
 *
 * It adds no signal logic: polarity comes from computePolaritySeries /
 * buildAutoSimInput (the dashboard's own call chain) and the wanted side from
 * sideForPolarity. Only watchlist stocks are ever managed; other positions are left alone
 * (they still use up a slot and count toward exposure and cash).
 */
import { buildAuditRecord, type AuditDraft, type AuditRecord } from "@/lib/audit";
import { buildAutoSimInput, isStale, sideForPolarity } from "@/lib/autoDecision";
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import { LIVE_SHORT_MIN_EQUITY, type LiveSettings } from "@/lib/broker/liveConfig";
import { placeLiveClose, placeLiveEntry, type LiveOrderResult } from "@/lib/broker/liveExecute";
import { closeBreakerTripped, deriveDayState, entriesTodayFor, entryNumberFor, MAX_CLOSE_ATTEMPTS, type DayState } from "@/lib/broker/liveOrders";
import { parseOccSymbol } from "@/lib/broker/options";
import type { BrokerAccount, BrokerPosition, LiveBroker } from "@/lib/broker/types";
import { sessionOpen } from "@/lib/mirrorRunner";
import { newYorkClock, type RunReport, type TickerReport } from "@/lib/paperRunner";
import { computePolaritySeries, type Bar, type DayResult } from "@/lib/polarity";
import type { AutoState } from "@/lib/liveAutoStore";
import { LIVE_LIMITS, slotUse } from "@/lib/liveLimits";
import { checkReading, companyKey, rankCandidates, sizeLiveEntry, toReading, type Reading } from "@/lib/pickRank";

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
    let allPositions = positionsRes.value;
    let stock = allPositions.filter(isStockPosition);

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

    const longOnlyReason: string | null = LIVE_LIMITS.longOnly ? "this live account trades long only (no shorts)." : shortBlockedReason(account);
    const maxPositions = settings.maxPositions;

    let lastEntered: string | null = null;
    /**
     * Wait for the entry just sent to show as a position, then re-read account, positions and working orders.
     * Returns a reason to stop, or null when it is safe to size the next entry.
     */
    const refreshAfterEntry = async (): Promise<string | null> => {
      let filled = false;
      for (let i = 0; i < FLAT_CHECKS && !filled; i++) {
        const again = await deps.broker.getPositions();
        if (again.ok) {
          allPositions = again.value;
          stock = again.value.filter(isStockPosition);
          filled = lastEntered !== null && again.value.some((p) => p.ticker === lastEntered);
        }
        if (!filled) await sleep(FLAT_CHECK_MS);
      }
      if (!filled) return `The ${lastEntered ?? "previous"} entry is not filled yet.`;
      const acc = await deps.broker.getAccount();
      if (!acc.ok) return `Cannot re-read the account after the entry: ${acc.error}.`;
      if (!(acc.value.equity > 0) || !(acc.value.lastEquity > 0)) return "Broker equity is not usable after the entry.";
      const open = await deps.broker.listOpenOrders();
      if (!open.ok) return `Cannot re-read working orders: ${open.error}.`;
      if (open.value.length > 0) return `A ${open.value[0].ticker} order (${open.value[0].clientOrderId}) is still working.`;
      account = acc.value;
      return null;
    };

    /**
     * Fill free slots, one order at a time, from the ranked `tickers`. Live ticks wait for each fill and re-read
     * the account before the next order; dry and observe-only ticks plan against what they would have bought.
     */
    const attemptEntries = async (tickers: readonly string[], why: string, preNotes: string[]): Promise<void> => {
      const readings: Reading[] = [];
      const skips: string[] = [...preNotes];
      for (const t of tickers) {
        const a = await analyze(t);
        if ("error" in a) skips.push(`${t}: ${a.error}`);
        else readings.push(toReading(t, a.bars, a.series));
      }
      const ranked = rankCandidates(readings);
      const rankLine = `Ranked: ${ranked.map((c) => `${c.key} ${c.score.toFixed(2)}`).join(", ") || "none"}.`;

      const plannedTickers: string[] = [];
      let plannedNotional = 0;
      const reserved = () => stock.reduce((sum, p) => sum + p.quantity * p.avgEntryPrice, 0) + plannedNotional;
      const slotsFree = () => slotUse([...allPositions, ...plannedTickers.map((ticker) => ({ ticker }))], [], maxPositions).free;
      const slotsAtStart = slotsFree();

      let placed = 0;
      let asideMsg: string | null = null;
      let stopped = false;

      const checkAsset = async (ticker: string, side: "long" | "short") => {
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
      };

      for (const cand of ranked) {
        if (stopped) break;
        if (slotsFree() <= 0) {
          skips.push(`${cand.key}: all ${maxPositions} position slots are in use.`);
          break;
        }
        for (const reading of cand.members) {
          const checked = await checkReading(reading, { today, shortBlocked: longOnlyReason, longOnlyFallback: settings.longOnlyFallback, checkAsset });
          if (!checked.ok) {
            skips.push(`${reading.ticker}: ${checked.skip}`);
            if (checked.aside) {
              asideMsg = checked.aside;
              stopped = true;
              break;
            }
            continue;
          }
          const side = checked.side;

          // Live: the previous entry must have filled, and the account is read again before the next order.
          if (!signalDry && placed > 0) {
            const again = await refreshAfterEntry();
            if (again) {
              record({ ticker: reading.ticker, outcome: "held", reason: `${again} The next entry waits for the next tick.` });
              stopped = true;
              break;
            }
            if (slotsFree() <= 0) {
              skips.push(`${reading.ticker}: all ${maxPositions} position slots are in use.`);
              stopped = true;
              break;
            }
          }

          const sized = sizeLiveEntry(
            {
              price: reading.price,
              equity: account.equity,
              lastEquity: account.lastEquity,
              cash: account.cash - plannedNotional,
              buyingPower: account.buyingPower - plannedNotional,
              reservedNotional: reserved(),
              today,
              quantity: settings.quantity,
              maxPositionPct: settings.maxPositionPct,
              dailyLossPct: settings.dailyLossPct,
            },
            side,
          );
          if (sized.quantity < 1) {
            skips.push(`${reading.ticker}: ${sized.reason ?? "no room for one share."}`);
            continue;
          }

          const nn = state.maxEntry + 1 + placed;
          const base = {
            ticker: reading.ticker,
            signalDate: reading.barDate,
            polarity: reading.polarity,
            ready: reading.ready,
            side,
            quantity: sized.quantity,
            price: reading.price,
            notes: [...(placed === 0 ? [rankLine] : []), ...sized.notes],
          };
          if (signalDry) {
            record({ ...base, outcome: "dry-run", reason: `Would enter ${side} ${sized.quantity} ${reading.ticker} as entry ${nn}. ${why}${autoOffNote()}`.trim() });
            plannedTickers.push(reading.ticker);
            plannedNotional += sized.quantity * reading.price;
            placed++;
            break;
          }
          const res = await placeLiveEntry({
            broker: deps.broker,
            config: deps.config,
            date: today,
            nn,
            ticker: reading.ticker,
            side,
            quantity: sized.quantity,
            polarity: reading.polarity,
            signalDate: reading.barDate,
          });
          if (!res.ok) {
            record({ ...base, outcome: res.code === "BROKER" ? "error" : "blocked", reason: res.error, clientOrderId: res.clientOrderId });
            stopped = true;
            break;
          }
          if (res.status === "submitted") {
            record({ ...base, outcome: "entered", reason: `${res.message} ${why}`.trim(), orderId: res.order.id, clientOrderId: res.clientOrderId });
          } else {
            record({ ...base, outcome: "held", reason: res.message, clientOrderId: res.clientOrderId, orderId: res.order?.id });
          }
          placed++;
          lastEntered = reading.ticker;
          break;
        }
      }

      const allNotes = [rankLine, ...skips];
      if (placed === 0) {
        record({ ticker: PICK_LABEL, outcome: "aside", reason: asideMsg ?? `No eligible candidate right now. ${why}`.trim(), notes: allNotes });
        return;
      }
      if (skips.length > 0 || asideMsg) {
        record({
          ticker: PICK_LABEL,
          outcome: "aside",
          reason: `${signalDry ? "Would enter" : "Entered"} ${placed} of ${slotsAtStart} open slot${slotsAtStart === 1 ? "" : "s"}. ${asideMsg ?? `${skips.length} passed over (reasons in notes).`}`,
          notes: skips,
        });
      }
    };

    // Each held watchlist stock follows its own polarity. Long only: Neutral and Reverse both just close it.
    let breaker = false;
    for (const pos of managed) {
      const nn = entryNumberFor(state, pos.ticker);
      if (closeBreakerTripped(state, pos.ticker, nn)) {
        breaker = true;
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
          : `Polarity flipped to ${wanted === "short" ? "Reverse" : "Drive"}. Closed the ${pos.side}; this account is long only, so nothing is opened the other way.`;
      await closeManaged(pos, "close", why, sig, signalDry);
    }
    if (breaker) return done();

    if (ny.minutes < settings.pickStartMinutes) {
      record({ ticker: PICK_LABEL, outcome: "aside", reason: `Pick starts at ${clock(settings.pickStartMinutes)} New York.`, notes });
      return done();
    }

    // Free slots: every watchlist stock that is not held and has not used its automatic entry today.
    const heldKeys = new Set(allPositions.map((p) => companyKey(p.ticker)));
    const preNotes: string[] = [];
    const candidates: string[] = [];
    for (const t of settings.watchlist) {
      const key = companyKey(t);
      if (heldKeys.has(key)) {
        preNotes.push(`${t}: already held.`);
      } else if (entriesTodayFor(state, (x) => companyKey(x) === key) >= LIVE_LIMITS.maxAutoEntriesPerTickerPerDay) {
        preNotes.push(`${t}: already entered today (the pick enters a ticker once a day; after a close it waits for the next session).`);
      } else {
        candidates.push(t);
      }
    }
    const free = slotUse(allPositions, [], maxPositions);
    if (free.free <= 0) {
      record({ ticker: PICK_LABEL, outcome: "held", reason: `All ${maxPositions} position slots are in use (${[...free.companies].join(", ")}). No new entries.`, notes });
      return done();
    }
    await attemptEntries(candidates, "", preNotes);
    return done();
  } catch (e) {
    return fail(`Unexpected pick failure: ${e instanceof Error ? e.name : "unknown"}`);
  }
}
