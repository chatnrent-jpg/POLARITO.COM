/**
 * The SPY desk's AUTOMATIC practice trader. DRY RUN ONLY: it changes the same saved practice record as the manual desk
 * (DeskState in the key-value store) and nothing else. There is no broker, no order client and no live-trading switch in
 * this module or anything it imports; its only inputs are functions that READ market data.
 *
 * Unidirectional flow of one run (scheduler -> auth is in spyAutoRoutes.ts, everything below is here):
 *   lock -> read audit log -> settled-session check -> calendar -> Auto switch -> read desk record -> guards ->
 *   daily bars -> polarity decision -> (maybe) fresh quote -> verified write of the desk record -> audit entry -> unlock.
 * State only moves forward through that chain; a failure at any step stops the chain and is logged, never papered over.
 *
 * Rules (defaults, all flagged in docs/spy-monthly-options-plan.md):
 *   - Switch OFF (the default, and whenever it cannot be read): no action.
 *   - Not a trading day, or before 16:15 ET: no action.
 *   - Data stale, crossed, missing, or the polarity unavailable: REFUSE and log. Nothing is bought or sold.
 *   - No position, Drive: open the call the contract rules pick (nearest expiry of at least 365 days, |delta| 0.80, else the
 *     cheapest at 0.60 or better, labelled). Reverse: open a put. Neutral: no action (the trader decides).
 *   - Auto position held, reading turns OPPOSITE: close at the re-fetched bid, then open the opposite side in the same run
 *     if the rules allow. Same side: hold. Neutral: leave it (the page shows a banner).
 *   - A MANUAL position is never touched by Auto. A manual action today makes Auto stand aside for the session.
 *   - Prices: in at the ask, out at the bid, fetched fresh at action time (the same convention as the manual desk).
 *   - One lock around every run; a settled session is not run twice; a second auto-open on the same session is refused.
 */
import { etClock, isTradingDay } from "@/lib/marketCalendar";
import { LONG_TIMEFRAME_NAMES } from "@/lib/longPolarity";
import { DELTA_THRESHOLDS, FALLBACK_LABEL, assertContractRules, usd, type ChainRow } from "@/lib/optionsSelect";
import type { OptionType } from "@/lib/broker/options";
import {
  deskDecision,
  readState,
  saveVerified,
  signedUsd,
  withJournal,
  type DeskConfig,
  type DeskDeps,
  type DeskPosition,
  type DeskState,
  type DeskStore,
  type JournalEntry,
} from "@/lib/spyDesk";
import {
  AUTO_LOG_MAX,
  AUTO_LOG_SHOWN,
  AUTO_SCHEDULE_TEXT,
  AUTO_UNAVAILABLE,
  SETTLED_OUTCOMES,
  parseAutoLog,
  type AutoLogEntry,
  type AutoOutcome,
  type AutoView,
} from "@/lib/spyAutoTypes";
import { CONTRACT_MULTIPLIER } from "@/lib/spyEngine";
import type { SpyKv } from "@/lib/spyKv";

export const AUTO_SWITCH_KEY = "polarito:spy:auto-switch:v1";
export const AUTO_LOG_KEY = "polarito:spy:auto-log:v1";
export const AUTO_LOCK_KEY = "polarito:spy:auto-lock:v1";
/** Longer than a run can take (each network call has a 4 s timeout); the lock expires on its own if a run dies. */
export const AUTO_LOCK_TTL_SECONDS = 120;
/** 16:15 ET: the daily bar of the session is final enough to read. */
export const AUTO_AFTER_CLOSE_MINUTES = 16 * 60 + 15;

/* --------------------------------------------------------------- switch */

export type SwitchRead = { ok: true; on: boolean; at: string | null } | { ok: false; error: string };

/** Fail-closed: ON only when the store answers and says so. A missing key is OFF. */
export async function readSwitch(kv: SpyKv): Promise<SwitchRead> {
  try {
    const r = await kv.get(AUTO_SWITCH_KEY);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.value === null) return { ok: true, on: false, at: null };
    const v = JSON.parse(r.value) as unknown;
    if (typeof v !== "object" || v === null || typeof (v as { auto?: unknown }).auto !== "boolean") return { ok: false, error: "The Auto switch value is malformed. Treating Auto as OFF." };
    const at = (v as { at?: unknown }).at;
    return { ok: true, on: (v as { auto: boolean }).auto, at: typeof at === "string" ? at : null };
  } catch {
    return { ok: false, error: "The Auto switch value is unreadable. Treating Auto as OFF." };
  }
}

/* ------------------------------------------------------------------ log */

export async function readLog(kv: SpyKv): Promise<{ ok: true; log: AutoLogEntry[] } | { ok: false; error: string }> {
  try {
    const r = await kv.get(AUTO_LOG_KEY);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.value === null) return { ok: true, log: [] };
    return parseAutoLog(JSON.parse(r.value) as unknown);
  } catch {
    return { ok: false, error: "The saved Auto log is unreadable." };
  }
}

/** Write the whole log, then read it back: an entry is only reported as logged when the store really holds it. */
async function writeLogVerified(kv: SpyKv, log: AutoLogEntry[]): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const body = JSON.stringify(log.slice(-AUTO_LOG_MAX));
    const w = await kv.set(AUTO_LOG_KEY, body);
    if (!w.ok) return { ok: false, error: w.error };
    const back = await kv.get(AUTO_LOG_KEY);
    if (!back.ok) return { ok: false, error: back.error };
    return back.value === body ? { ok: true } : { ok: false, error: "The Auto log was not kept by the store." };
  } catch {
    return { ok: false, error: "The Auto log could not be saved." };
  }
}

/* ----------------------------------------------------------------- lock */

export type Lock = { ok: true; token: string } | { ok: false; busy: boolean; error: string };

export async function acquireLock(kv: SpyKv): Promise<Lock> {
  try {
    const token = globalThis.crypto.randomUUID();
    const r = await kv.setNx(AUTO_LOCK_KEY, token, AUTO_LOCK_TTL_SECONDS);
    if (!r.ok) return { ok: false, busy: false, error: r.error };
    return r.value ? { ok: true, token } : { ok: false, busy: true, error: "Another Auto or desk action is running right now." };
  } catch {
    return { ok: false, busy: false, error: "The lock could not be requested." };
  }
}

async function holdsLock(kv: SpyKv, token: string): Promise<boolean> {
  try {
    const r = await kv.get(AUTO_LOCK_KEY);
    return r.ok && r.value === token;
  } catch {
    return false;
  }
}

export async function releaseLock(kv: SpyKv, token: string): Promise<void> {
  try {
    if (await holdsLock(kv, token)) await kv.del(AUTO_LOCK_KEY);
  } catch {
    /* the lock expires by itself after AUTO_LOCK_TTL_SECONDS */
  }
}

/** Run `fn` while holding the lock. A busy or broken lock means `fn` does not run. */
export async function withLock<T>(kv: SpyKv, fn: (token: string) => Promise<T>): Promise<{ ran: true; value: T } | { ran: false; busy: boolean; error: string }> {
  const lock = await acquireLock(kv);
  if (!lock.ok) return { ran: false, busy: lock.busy, error: lock.error };
  try {
    return { ran: true, value: await fn(lock.token) };
  } finally {
    await releaseLock(kv, lock.token);
  }
}

/* ------------------------------------------------------------- the view */

/** What /spy shows about Auto. Reads only. Never throws; anything doubtful is OFF with the reason. */
export async function buildAutoView(kv: SpyKv | null): Promise<AutoView> {
  if (!kv) return AUTO_UNAVAILABLE;
  const sw = await readSwitch(kv);
  const log = await readLog(kv);
  return {
    available: true,
    on: sw.ok ? sw.on : false,
    reason: sw.ok ? (sw.on ? "Auto is ON." : "Auto is OFF.") : `${sw.error} Auto is OFF until the store answers.`,
    at: sw.ok ? sw.at : null,
    schedule: AUTO_SCHEDULE_TEXT,
    log: log.ok ? log.log.slice(-AUTO_LOG_SHOWN).reverse() : [],
    logError: log.ok ? null : log.error,
    banner: null,
  };
}

export type SwitchResult = { ok: true; on: boolean; message: string } | { ok: false; status: number; error: string };

/** Turn Auto on or off (the trader's own action). Takes the run lock, writes the switch, verifies it, logs the change. */
export async function setAutoSwitch(kv: SpyKv | null, on: boolean, now: Date): Promise<SwitchResult> {
  if (!kv) return { ok: false, status: 503, error: "No Auto store is configured (KV_REST_API_URL / KV_REST_API_TOKEN), so Auto cannot be switched. It stays OFF." };
  try {
    const out = await withLock(kv, async (): Promise<SwitchResult> => {
      const logRead = await readLog(kv);
      if (!logRead.ok) return { ok: false, status: 502, error: `${logRead.error} The switch was not changed.` };
      const at = now.toISOString();
      const body = JSON.stringify({ auto: on, at });
      const w = await kv.set(AUTO_SWITCH_KEY, body);
      if (!w.ok) return { ok: false, status: 502, error: `${w.error} The switch was not changed.` };
      const back = await readSwitch(kv);
      if (!back.ok || back.on !== on) return { ok: false, status: 502, error: "The store did not keep the switch. Check the state shown." };
      const entry: AutoLogEntry = {
        id: `auto-${at}-switch`,
        at,
        session: etClock(now).date,
        outcome: on ? "switch-on" : "switch-off",
        message: on
          ? "Auto switched ON by the trader. From the next scheduled run it opens and closes the practice position by itself (practice record only, no orders)."
          : "Auto switched OFF by the trader. Open positions stay as they are.",
        reading: null,
        symbol: null,
        bid: null,
        ask: null,
        pnlUsd: null,
      };
      const logged = await writeLogVerified(kv, [...logRead.log, entry]);
      return { ok: true, on, message: `${entry.message}${logged.ok ? "" : " (The change could not be written to the audit log.)"}` };
    });
    if (!out.ran) return { ok: false, status: out.busy ? 409 : 502, error: `${out.error} The switch was not changed.` };
    return out.value;
  } catch {
    return { ok: false, status: 500, error: "Unexpected error. Check the state shown." };
  }
}

/* ------------------------------------------------------------ the cycle */

export type AutoContext = { desk: DeskStore | null; kv: SpyKv | null };
export type AutoRunOptions = { dryRun?: boolean };

export type AutoRunResult = {
  /** The outcome logged (or, for a dry run, the one that would be). "busy": the lock was taken and nothing ran. */
  outcome: AutoOutcome | "busy";
  /** HTTP status the scheduler route answers with: 200 for a decision, 409 busy, 503/502 when it had to refuse or fail. */
  status: number;
  message: string;
  dryRun: boolean;
  /** The audit entry written (null for busy, dry runs and silent repeats). */
  entry: AutoLogEntry | null;
  /** False when the audit entry could not be saved (the journal still holds any trade). */
  logged: boolean;
  /** True when the session had already been settled and this run did nothing at all. */
  repeat: boolean;
};

const READING_NAME: Record<1 | 0 | -1, string> = { 1: "Drive", 0: "Neutral", [-1]: "Reverse" };

function sessionOf(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : etClock(d).date;
}

function autoPosition(row: ChainRow, type: OptionType, tier: "primary" | "fallback", fallbackReason: string | null, timeframe: DeskConfig["timeframe"], at: string): DeskPosition {
  return {
    type,
    symbol: row.symbol,
    expiration: row.expiration,
    strike: row.strike,
    quantity: 1,
    entryAt: at,
    entryAsk: row.ask,
    entryMid: row.mid,
    entryDelta: row.delta,
    deltaTier: tier,
    fallbackReason: tier === "fallback" ? fallbackReason : null,
    decisionTimeframe: timeframe,
    maxLossUsd: row.costAtAsk,
    source: "auto",
  };
}

const quoteProblem = (q: ChainRow): string | null => {
  if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask) || q.bid <= 0 || q.ask <= 0) return "the quote is empty";
  if (q.bid > q.ask) return "the quote is crossed (bid above ask)";
  return null;
};

/**
 * One scheduled evaluation. Never throws. Never places an order. Safe to run twice: a settled session is skipped, the lock
 * serialises runs, and the saved position is re-read inside the lock before anything changes.
 */
export async function runAutoCycle(deps: DeskDeps, config: DeskConfig, ctx: AutoContext, opts: AutoRunOptions = {}): Promise<AutoRunResult> {
  const dry = opts.dryRun === true;
  const base = { dryRun: dry, entry: null, logged: false, repeat: false };
  const { kv, desk } = ctx;
  if (!kv || !desk) {
    return { ...base, outcome: "refused", status: 503, message: "No store is configured (KV_REST_API_URL / KV_REST_API_TOKEN), so Auto cannot run and cannot keep its audit log. Nothing was done." };
  }
  const lock = await acquireLock(kv);
  if (!lock.ok) {
    return lock.busy
      ? { ...base, outcome: "busy", status: 409, message: `${lock.error} Nothing was done; the other run decides.` }
      : { ...base, outcome: "refused", status: 502, message: `${lock.error} Nothing was done.` };
  }
  try {
    return await runLocked(deps, config, { kv, desk }, lock.token, dry);
  } catch (e) {
    return { ...base, outcome: "error", status: 500, message: `Unexpected error (${e instanceof Error ? e.name : "unknown"}). Nothing further was done; check the desk record.` };
  } finally {
    await releaseLock(kv, lock.token);
  }
}

async function runLocked(deps: DeskDeps, config: DeskConfig, ctx: { kv: SpyKv; desk: DeskStore }, token: string, dry: boolean): Promise<AutoRunResult> {
  const { kv, desk } = ctx;
  const now = deps.now();
  const at = now.toISOString();
  const { date: session, minutes } = etClock(now);
  const tfName = LONG_TIMEFRAME_NAMES[config.timeframe];
  const prefix = dry ? "DRY RUN, nothing saved: " : "";

  const logRead = await readLog(kv);
  if (!logRead.ok) {
    return { outcome: "refused", status: 502, message: `${logRead.error} Auto does not trade without its audit log. Nothing was done.`, dryRun: dry, entry: null, logged: false, repeat: false };
  }
  let log = logRead.log;
  let reading: string | null = null;

  const finish = async (outcome: AutoOutcome, message: string, extra: Partial<AutoLogEntry> = {}): Promise<AutoRunResult> => {
    const status = outcome === "refused" ? 503 : outcome === "error" ? 502 : 200;
    const entry: AutoLogEntry = { id: `auto-${at}-${outcome}`, at, session, outcome, message: `${prefix}${message}`, reading, symbol: null, bid: null, ask: null, pnlUsd: null, ...extra };
    if (dry) return { outcome, status, message: entry.message, dryRun: true, entry: null, logged: false, repeat: false };
    log = [...log, entry].slice(-AUTO_LOG_MAX);
    const w = await writeLogVerified(kv, log);
    return { outcome, status, message: w.ok ? entry.message : `${entry.message} (The audit entry could not be saved: ${w.error})`, dryRun: false, entry, logged: w.ok, repeat: false };
  };

  if (log.some((e) => e.session === session && (SETTLED_OUTCOMES as readonly string[]).includes(e.outcome))) {
    return { outcome: "skipped", status: 200, message: `${session} was already settled by an earlier run (see the audit log). Nothing was done.`, dryRun: dry, entry: null, logged: false, repeat: true };
  }
  if (!isTradingDay(session)) return finish("skipped", `${session} is not a trading day. No action.`);
  if (minutes < AUTO_AFTER_CLOSE_MINUTES) return finish("skipped", `The market has not closed yet (16:15 ET needed, it is ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} ET). No action.`);

  const sw = await readSwitch(kv);
  if (!sw.ok) return finish("off", `Auto is OFF: ${sw.error} No action.`);
  if (!sw.on) return finish("off", "Auto is OFF. No action.");

  const st = await readState(desk);
  if (!st.ok) return finish("refused", `The desk record could not be read (${st.result.ok ? "unknown" : st.result.error}). Nothing was changed.`);
  let state: DeskState = st.state;
  const held = state.position;

  const todays = state.journal.filter((j) => sessionOf(j.at) === session);
  if (todays.some((j) => j.kind === "manual-open" || j.kind === "manual-close")) {
    return finish("no-action", `You acted by hand today (${session}), so Auto stands aside for this session. No action.`);
  }
  const autoOpenedToday = todays.some((j) => j.kind === "auto-open");
  if (autoOpenedToday && !held) return finish("no-action", "Auto already opened a position today and it was closed since; it does not re-enter in the same session. No action.");

  const dailyRes = await deps.loadDaily();
  if (!dailyRes.ok) return finish("refused", `Data unavailable: daily bars could not be read (${dailyRes.error}). Nothing was bought or sold.`);
  const decision = deskDecision(dailyRes.value, now, config.timeframe);
  if (decision.status === "unavailable") return finish("refused", `Data unavailable for the ${tfName} polarity: ${decision.reason}. Nothing was bought or sold.`);
  reading = READING_NAME[decision.reading.polarity as 1 | 0 | -1];
  const readingText = `${tfName} reading ${reading}`;

  if (held && held.source === "manual") {
    return finish("no-action", `The ${readingText}. A MANUAL position (${held.symbol}) is held; Auto only manages positions it opened, so it is left alone. No action.`, { symbol: held.symbol });
  }
  if (decision.action === "STAND_ASIDE") {
    return finish("neutral", held ? `NEUTRAL: TRADER DECIDES. The ${readingText}. ${held.symbol} (AUTO) is left as it is; close it by hand if you want out.` : `NEUTRAL: TRADER DECIDES. The ${readingText}. No position and no automatic entry.`, { symbol: held?.symbol ?? null });
  }
  const want: OptionType = decision.action === "CALL" ? "call" : "put";
  if (held && held.type === want) return finish("hold", `Holding ${held.symbol} (AUTO): the ${readingText} still says ${want.toUpperCase()}. No action.`, { symbol: held.symbol });
  if (held && autoOpenedToday) {
    return finish("no-action", `The ${readingText} is opposite to ${held.symbol}, but Auto opened it today and does not reverse within one session. No action.`, { symbol: held.symbol });
  }

  const spotRes = await deps.readSpot();
  if (!spotRes.ok) return finish("refused", `Data unavailable: the SPY price could not be read (${spotRes.error}). Nothing was bought or sold.`);
  const today = session;

  const commit = async (next: DeskState): Promise<{ ok: true; state: DeskState } | { ok: false; error: string }> => {
    if (dry) return { ok: true, state: next };
    if (!(await holdsLock(kv, token))) return { ok: false, error: "The run lock was lost, so this run stopped before saving. Nothing was changed." };
    return saveVerified(desk, next);
  };

  let closed: { symbol: string; bid: number; pnlUsd: number } | null = null;
  if (held) {
    let quote: ChainRow | null = null;
    try {
      quote = await deps.readHeld(held, spotRes.value.price, today, now);
    } catch {
      quote = null;
    }
    if (!quote) return finish("refused", `The ${readingText} flipped against ${held.symbol}, but no usable quote could be read to price the close. The position is left as it is.`, { symbol: held.symbol });
    const bad = quoteProblem(quote);
    if (bad) return finish("refused", `The ${readingText} flipped against ${held.symbol}, but ${bad}. The position is left as it is.`, { symbol: held.symbol, bid: quote.bid, ask: quote.ask });
    const pnl = (quote.bid - held.entryAsk) * CONTRACT_MULTIPLIER;
    const closeEntry: JournalEntry = {
      id: `auto-close-${at}`,
      at,
      kind: "auto-close",
      symbol: held.symbol,
      type: held.type,
      strike: held.strike,
      expiration: held.expiration,
      delta: held.entryDelta,
      costUsd: held.entryAsk * CONTRACT_MULTIPLIER,
      exitBid: quote.bid,
      pnlUsd: pnl,
      note: `AUTO dry-run close of ${held.symbol}: the ${readingText} turned against it; sold at the bid ${usd(quote.bid)} against the entry ask ${usd(held.entryAsk)}, result ${signedUsd(pnl)} per contract. No order sent.`,
    };
    const saved = await commit({ version: 1, position: null, journal: withJournal(state, closeEntry) });
    if (!saved.ok) return finish("refused", `Could not record the close of ${held.symbol}: ${saved.error}`, { symbol: held.symbol, bid: quote.bid });
    state = saved.state;
    closed = { symbol: held.symbol, bid: quote.bid, pnlUsd: pnl };
  }

  const closedText = closed ? `Closed ${closed.symbol} at the bid ${usd(closed.bid)} (result ${signedUsd(closed.pnlUsd)} per contract). ` : "";
  const closedExtra: Partial<AutoLogEntry> = closed ? { symbol: closed.symbol, bid: closed.bid, pnlUsd: closed.pnlUsd } : {};
  const notOpened = (why: string): Promise<AutoRunResult> =>
    closed ? finish("closed", `${closedText}The ${want.toUpperCase()} was not opened: ${why}.`, closedExtra) : finish("refused", `The ${readingText} says ${want.toUpperCase()}, but ${why}. Nothing was bought.`);

  let side;
  try {
    side = await deps.readSide(want, spotRes.value.price, today, now);
  } catch {
    return notOpened("the option chain could not be read");
  }
  if (!side.pick.ok) return notOpened(`no contract passes the rules (${side.pick.reason})${side.error ? `; chain problem: ${side.error}` : ""}`);
  const row = side.pick.row;
  const tier = side.pick.tier;
  const broken = assertContractRules(row, want, today, tier === "fallback" ? DELTA_THRESHOLDS.floor : DELTA_THRESHOLDS.primary);
  if (broken) return notOpened(`${row.symbol} was refused (${broken})`);
  const bad = quoteProblem(row);
  if (bad) return notOpened(`${row.symbol}: ${bad}`);

  const position = autoPosition(row, want, tier, side.pick.fallbackReason, config.timeframe, at);
  const label = tier === "fallback" ? ` [${FALLBACK_LABEL}: why: ${side.pick.fallbackReason}]` : "";
  const openEntry: JournalEntry = {
    id: `auto-open-${at}`,
    at,
    kind: "auto-open",
    symbol: row.symbol,
    type: want,
    strike: row.strike,
    expiration: row.expiration,
    delta: row.delta,
    costUsd: row.costAtAsk,
    exitBid: null,
    pnlUsd: null,
    note: `AUTO dry-run buy (${readingText}): 1 ${want.toUpperCase()} ${row.symbol}, ask ${usd(row.ask)}, cost ${usd(row.costAtAsk)}, delta ${row.delta.toFixed(3)}${label}. No order sent.`,
  };
  const saved = await commit({ version: 1, position, journal: withJournal(state, openEntry) });
  if (!saved.ok) {
    return closed
      ? finish("error", `${closedText}The ${want.toUpperCase()} could not be recorded: ${saved.error}`, closedExtra)
      : finish("error", `The ${want.toUpperCase()} ${row.symbol} could not be recorded: ${saved.error}`);
  }
  return finish(closed ? "closed-and-opened" : "opened", `${closedText}Opened 1 ${want.toUpperCase()} ${row.symbol} at the ask ${usd(row.ask)} (cost ${usd(row.costAtAsk)}, delta ${row.delta.toFixed(3)})${label}. ${readingText}.`, {
    ...closedExtra,
    symbol: row.symbol,
    ask: row.ask,
  });
}
