/**
 * SPY desk logic: the page's data (snapshot) and the two MANUAL actions (dry-run ticket and Close).
 * Pure orchestration over injected functions; no rendering, no HTTP, no clock of its own.
 *
 * HARD SAFETY: everything here is DRY RUN. The ticket and Close change one saved "dry-run position" record
 * (DeskState) and nothing else. There is no broker, no order client and no live-trading switch in this module or
 * anything it imports; its only inputs are functions that READ market data (the same ones the dry-run engine uses).
 *
 * Unidirectional flow:  deps (read-only data) + store (DeskState) -> readings -> decision -> snapshot (view model)
 *                       manual action: request -> validate -> gate -> fresh chain read -> DeskState -> store -> read back.
 *
 * Never a false state: a store that cannot be read is "unknown" (never "no position"); a write is only reported
 * after it was read back; data that is stale or missing is "data unavailable" and blocks the ticket.
 */
import type { OptionType } from "@/lib/broker/options";
import { daysBetween, parseOccSymbol } from "@/lib/broker/options";
import {
  LONG_TIMEFRAMES,
  LONG_TIMEFRAME_NAMES,
  computeLongReadings,
  isLongTimeframe,
  type LongReading,
  type LongReadings,
  type LongTimeframe,
} from "@/lib/longPolarity";
import { etClock } from "@/lib/marketCalendar";
import { DELTA_THRESHOLDS, FALLBACK_LABEL, MIN_DAYS_TO_EXPIRY, assertContractRules, usd, type ChainRow } from "@/lib/optionsSelect";
import type { Bar } from "@/lib/polarity";
import type { SideReport, Spot } from "@/lib/spyChain";
import {
  CONTRACT_MULTIPLIER,
  EMPTY_STATE,
  runEngine,
  type Decision,
  type DryPosition,
  type EngineConfig,
  type EngineDeps,
} from "@/lib/spyEngine";

/** The feature flag (server env). Off unless it is exactly "1". */
export const DESK_FLAG = "POLARITO_SPY_DESK";
export const deskEnabled = (env: Readonly<Record<string, string | undefined>>): boolean => env[DESK_FLAG] === "1";

export const JOURNAL_MAX = 100;
export const JOURNAL_SHOWN = 20;
export const CANDIDATES_MAX = 60;
export const EVENTS_SHOWN = 12;

/** Label for a contract picked BY HAND below the 0.80 target (the engine's own picks use FALLBACK_LABEL). */
export const MANUAL_BELOW_TARGET_LABEL = `BELOW ${DELTA_THRESHOLDS.primary.toFixed(2)} (chosen by hand, floor ${DELTA_THRESHOLDS.floor.toFixed(2)})`;

/* ------------------------------------------------------------------ types */

export type DeskDeps = Pick<EngineDeps, "now" | "loadDaily" | "readSpot" | "readSide" | "readHeld">;
export type DeskConfig = Pick<EngineConfig, "timeframe" | "liveBudget">;

export type DeskPosition = DryPosition & { source: "manual" };

export type JournalEntry = {
  id: string;
  at: string;
  kind: "manual-open" | "manual-close";
  symbol: string;
  type: OptionType;
  strike: number;
  expiration: string;
  delta: number;
  /** Open: cost per contract at the ask. Close: the entry cost. */
  costUsd: number;
  /** Close only: the bid it was closed at; null when closed without a price or on open. */
  exitBid: number | null;
  /** Close only: (bid - entry ask) x 100; null when unknown. */
  pnlUsd: number | null;
  note: string;
};

export type DeskState = { version: 1; position: DeskPosition | null; journal: JournalEntry[] };
export const EMPTY_DESK: DeskState = Object.freeze({ version: 1, position: null, journal: [] }) as DeskState;

export interface DeskStore {
  read(): Promise<{ ok: true; state: DeskState } | { ok: false; error: string }>;
  write(state: DeskState): Promise<{ ok: true } | { ok: false; error: string }>;
}

export type DeskErrorCode =
  | "NO_STORE"
  | "STORE"
  | "INVALID"
  | "POSITION_OPEN"
  | "NO_POSITION"
  | "DATA_UNAVAILABLE"
  | "NOT_NEUTRAL"
  | "NO_SPOT"
  | "CHAIN"
  | "NOT_ELIGIBLE"
  | "NO_QUOTE";

export type ActionResult =
  | { ok: true; message: string; entry: JournalEntry; state: DeskState }
  | { ok: false; code: DeskErrorCode; error: string; status: number };

/** Dollars with the sign in front ("-$92.00"), unlike usd() which would print "$-92.00". */
const signedUsd = (n: number): string => (n < 0 ? `-${usd(-n)}` : usd(n));

const refuse = (code: DeskErrorCode, error: string, status: number): ActionResult => ({ ok: false, code, error, status });

/* --------------------------------------------------------- state parsing */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isOptionType = (v: unknown): v is OptionType => v === "call" || v === "put";

function parseJournalEntry(raw: unknown): JournalEntry | null {
  if (!isRecord(raw)) return null;
  const { id, at, kind, symbol, type, strike, expiration, delta, costUsd, exitBid, pnlUsd, note } = raw;
  if (
    typeof id !== "string" ||
    typeof at !== "string" ||
    (kind !== "manual-open" && kind !== "manual-close") ||
    typeof symbol !== "string" ||
    !isOptionType(type) ||
    !finite(strike) ||
    typeof expiration !== "string" ||
    !finite(delta) ||
    !finite(costUsd) ||
    !(exitBid === null || finite(exitBid)) ||
    !(pnlUsd === null || finite(pnlUsd)) ||
    typeof note !== "string"
  ) {
    return null;
  }
  return { id, at, kind, symbol, type, strike, expiration, delta, costUsd, exitBid: exitBid as number | null, pnlUsd: pnlUsd as number | null, note };
}

function parsePosition(p: unknown): DeskPosition | null {
  if (!isRecord(p)) return null;
  if (
    !isOptionType(p.type) ||
    typeof p.symbol !== "string" ||
    typeof p.expiration !== "string" ||
    !finite(p.strike) ||
    p.quantity !== 1 ||
    typeof p.entryAt !== "string" ||
    !finite(p.entryAsk) ||
    !finite(p.entryMid) ||
    !finite(p.entryDelta) ||
    (p.deltaTier !== "primary" && p.deltaTier !== "fallback") ||
    !(p.fallbackReason === null || typeof p.fallbackReason === "string") ||
    !isLongTimeframe(p.decisionTimeframe) ||
    !finite(p.maxLossUsd) ||
    p.source !== "manual"
  ) {
    return null;
  }
  return {
    type: p.type,
    symbol: p.symbol,
    expiration: p.expiration,
    strike: p.strike,
    quantity: 1,
    entryAt: p.entryAt,
    entryAsk: p.entryAsk,
    entryMid: p.entryMid,
    entryDelta: p.entryDelta,
    deltaTier: p.deltaTier,
    fallbackReason: p.fallbackReason as string | null,
    decisionTimeframe: p.decisionTimeframe,
    maxLossUsd: p.maxLossUsd,
    source: "manual",
  };
}

/** Strict shape check of a saved desk state. Never repairs a bad value by guessing. */
export function parseDeskState(raw: unknown): { ok: true; state: DeskState } | { ok: false; error: string } {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.journal)) return { ok: false, error: "The saved desk state has an unexpected shape." };
  let position: DeskPosition | null = null;
  if (raw.position !== null && raw.position !== undefined) {
    position = parsePosition(raw.position);
    if (position === null) return { ok: false, error: "The saved dry-run position is malformed." };
  }
  const journal: JournalEntry[] = [];
  for (const item of raw.journal) {
    const e = parseJournalEntry(item);
    if (e === null) return { ok: false, error: "The saved desk journal has a malformed entry." };
    journal.push(e);
  }
  return { ok: true, state: { version: 1, position, journal: journal.slice(-JOURNAL_MAX) } };
}

/* ------------------------------------------------------ payload parsing */

const OCC_SPY = /^SPY\d{6}[CP]\d{8}$/;

export type TicketRequest = { type: OptionType; symbol: string };
export type CloseRequest = { unpriced: boolean };

/** Body of POST /api/spy/ticket: { type, symbol, acknowledgeDryRun: true }. Exact keys; nothing else is accepted. */
export function parseTicketRequest(body: unknown): { ok: true; value: TicketRequest } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "Body must be a JSON object." };
  const extra = Object.keys(body).filter((k) => !["type", "symbol", "acknowledgeDryRun"].includes(k));
  if (extra.length > 0) return { ok: false, error: `Unexpected field: ${extra[0].slice(0, 30)}.` };
  if (body.acknowledgeDryRun !== true) return { ok: false, error: "acknowledgeDryRun must be true: this only records a dry-run position, no order is sent." };
  if (!isOptionType(body.type)) return { ok: false, error: 'type must be "call" or "put".' };
  if (typeof body.symbol !== "string" || !OCC_SPY.test(body.symbol)) return { ok: false, error: "symbol must be a SPY option symbol such as SPY271217C00595000." };
  const occ = parseOccSymbol(body.symbol);
  if (!occ || occ.type !== body.type) return { ok: false, error: "symbol does not match the chosen call/put." };
  return { ok: true, value: { type: body.type, symbol: body.symbol } };
}

/** Body of POST /api/spy/close: { acknowledgeDryRun: true, unpriced?: boolean }. */
export function parseCloseRequest(body: unknown): { ok: true; value: CloseRequest } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "Body must be a JSON object." };
  const extra = Object.keys(body).filter((k) => !["acknowledgeDryRun", "unpriced"].includes(k));
  if (extra.length > 0) return { ok: false, error: `Unexpected field: ${extra[0].slice(0, 30)}.` };
  if (body.acknowledgeDryRun !== true) return { ok: false, error: "acknowledgeDryRun must be true: this only closes the dry-run position, no order is sent." };
  if (body.unpriced !== undefined && typeof body.unpriced !== "boolean") return { ok: false, error: "unpriced must be true or false." };
  return { ok: true, value: { unpriced: body.unpriced === true } };
}

/* -------------------------------------------------------------- decision */

export type DeskDecision =
  | { status: "ok"; action: "CALL" | "PUT" | "STAND_ASIDE"; reading: LongReading; readings: LongReadings }
  | { status: "unavailable"; reason: string };

/** The same decision the engine makes (Drive CALL, Reverse PUT, Neutral STAND ASIDE), without reading any option data. */
export function deskDecision(daily: readonly Bar[], now: Date, timeframe: LongTimeframe): DeskDecision {
  const readings = computeLongReadings({ daily: [...daily], now });
  const reading = readings[timeframe];
  if (reading.status !== "ok" || reading.polarity === null) return { status: "unavailable", reason: reading.reason ?? "unknown" };
  return { status: "ok", action: reading.polarity === 1 ? "CALL" : reading.polarity === -1 ? "PUT" : "STAND_ASIDE", reading, readings };
}

export type TicketGate = { open: boolean; reason: string | null };

/** The ticket is open only on a Neutral reading with good data, no dry-run position, and a store that works. */
export function ticketGate(decision: Pick<Decision, "action" | "reason"> | null, positionStatus: "none" | "held" | "unknown", storeAvailable: boolean): TicketGate {
  if (!storeAvailable) return { open: false, reason: "No desk store is available, so a dry-run position cannot be saved. The ticket stays off." };
  if (decision === null) return { open: false, reason: "No decision could be made, so the ticket stays off." };
  if (decision.action === "DATA_UNAVAILABLE") return { open: false, reason: `Data unavailable (${decision.reason}). The ticket stays off until the reading can be trusted.` };
  if (decision.action !== "STAND_ASIDE") return { open: false, reason: `The reading is not Neutral (the engine says ${decision.action}). The manual ticket is only for a Neutral reading.` };
  if (positionStatus === "unknown") return { open: false, reason: "The saved dry-run position could not be read, so the ticket stays off." };
  if (positionStatus === "held") return { open: false, reason: "A dry-run position is already held. Close it first (one position at a time)." };
  return { open: true, reason: null };
}

/* -------------------------------------------------------- manual actions */

async function readState(store: DeskStore | null): Promise<{ ok: true; state: DeskState } | { ok: false; result: ActionResult }> {
  if (!store) return { ok: false, result: refuse("NO_STORE", "No desk store is configured (KV_REST_API_URL / KV_REST_API_TOKEN), so nothing can be saved. Nothing was changed.", 503) };
  try {
    const r = await store.read();
    if (!r.ok) return { ok: false, result: refuse("STORE", `${r.error} Nothing was changed.`, 502) };
    return { ok: true, state: r.state };
  } catch {
    return { ok: false, result: refuse("STORE", "The desk store failed. Nothing was changed.", 502) };
  }
}

/** Write, then read back: the answer reflects what the store really holds. */
async function saveVerified(store: DeskStore, next: DeskState): Promise<{ ok: true; state: DeskState } | { ok: false; error: string }> {
  try {
    const w = await store.write(next);
    if (!w.ok) return { ok: false, error: `${w.error} Nothing was changed.` };
    const back = await store.read();
    if (!back.ok) return { ok: false, error: `The change was sent but could not be read back (${back.error}). Check the state shown.` };
    if (JSON.stringify(back.state) !== JSON.stringify(next)) return { ok: false, error: "The store did not keep the change. Check the state shown." };
    return { ok: true, state: back.state };
  } catch {
    return { ok: false, error: "The desk store failed while saving. Check the state shown." };
  }
}

const withJournal = (state: DeskState, entry: JournalEntry): JournalEntry[] => [...state.journal, entry].slice(-JOURNAL_MAX);

/** Record a MANUAL dry-run buy of a contract from the rules-filtered chain. Only valid on a Neutral reading. Sends no order. */
export async function openManual(deps: DeskDeps, config: DeskConfig, store: DeskStore | null, req: TicketRequest): Promise<ActionResult> {
  try {
    const st = await readState(store);
    if (!st.ok) return st.result;
    if (st.state.position) return refuse("POSITION_OPEN", `A dry-run position is already held (${st.state.position.symbol}). Close it first.`, 409);

    const now = deps.now();
    const dailyRes = await deps.loadDaily();
    if (!dailyRes.ok) return refuse("DATA_UNAVAILABLE", `Data unavailable: daily bars could not be read (${dailyRes.error}). Nothing was recorded.`, 409);
    const decision = deskDecision(dailyRes.value, now, config.timeframe);
    if (decision.status === "unavailable") return refuse("DATA_UNAVAILABLE", `Data unavailable for the ${LONG_TIMEFRAME_NAMES[config.timeframe]} reading: ${decision.reason}. Nothing was recorded.`, 409);
    if (decision.action !== "STAND_ASIDE") return refuse("NOT_NEUTRAL", `The ${LONG_TIMEFRAME_NAMES[config.timeframe]} reading is ${decision.action === "CALL" ? "Drive" : "Reverse"}, not Neutral: the engine decides, the manual ticket is closed.`, 409);

    const spotRes = await deps.readSpot();
    if (!spotRes.ok) return refuse("NO_SPOT", `The SPY price could not be read (${spotRes.error}). Nothing was recorded.`, 502);
    const today = etClock(now).date;
    const side = await deps.readSide(req.type, spotRes.value.price, today, now);
    if (side.error && side.eligible.length === 0) return refuse("CHAIN", `The ${req.type} chain could not be read (${side.error}). Nothing was recorded.`, 502);

    const row = side.eligible.find((r) => r.symbol === req.symbol);
    const broken = row ? assertContractRules(row, req.type, today, DELTA_THRESHOLDS.floor) : "not in the rules-filtered chain right now";
    if (!row || broken) {
      return refuse("NOT_ELIGIBLE", `${req.symbol} is not available under the rules (nearest expiry of at least ${MIN_DAYS_TO_EXPIRY} days, |delta| at least ${DELTA_THRESHOLDS.floor}, usable quote): ${broken}. Refresh and choose again. Nothing was recorded.`, 409);
    }

    const at = now.toISOString();
    const belowTarget = Math.abs(row.delta) < DELTA_THRESHOLDS.primary;
    const position: DeskPosition = {
      type: req.type,
      symbol: row.symbol,
      expiration: row.expiration,
      strike: row.strike,
      quantity: 1,
      entryAt: at,
      entryAsk: row.ask,
      entryMid: row.mid,
      entryDelta: row.delta,
      deltaTier: belowTarget ? "fallback" : "primary",
      fallbackReason: belowTarget ? `chosen by hand: |delta| ${Math.abs(row.delta).toFixed(3)} is below the ${DELTA_THRESHOLDS.primary.toFixed(2)} target (the ${DELTA_THRESHOLDS.floor.toFixed(2)} floor still applies)` : null,
      decisionTimeframe: config.timeframe,
      maxLossUsd: row.costAtAsk,
      source: "manual",
    };
    const entry: JournalEntry = {
      id: `manual-open-${at}`,
      at,
      kind: "manual-open",
      symbol: row.symbol,
      type: req.type,
      strike: row.strike,
      expiration: row.expiration,
      delta: row.delta,
      costUsd: row.costAtAsk,
      exitBid: null,
      pnlUsd: null,
      note: `MANUAL dry-run buy (Neutral reading, trader decided): 1 ${req.type.toUpperCase()} ${row.symbol}, ask ${usd(row.ask)}, cost ${usd(row.costAtAsk)}, delta ${row.delta.toFixed(3)}${belowTarget ? ` [${MANUAL_BELOW_TARGET_LABEL}]` : ""}. No order sent.`,
    };
    const saved = await saveVerified(store as DeskStore, { version: 1, position, journal: withJournal(st.state, entry) });
    if (!saved.ok) return refuse("STORE", saved.error, 502);
    return { ok: true, message: entry.note, entry, state: saved.state };
  } catch (e) {
    return refuse("CHAIN", `Unexpected error (${e instanceof Error ? e.name : "unknown"}). Nothing was recorded.`, 500);
  }
}

/** Close the dry-run position by hand, priced at the current bid. Sends no order. */
export async function closeManual(deps: DeskDeps, store: DeskStore | null, req: CloseRequest): Promise<ActionResult> {
  try {
    const st = await readState(store);
    if (!st.ok) return st.result;
    const held = st.state.position;
    if (!held) return refuse("NO_POSITION", "There is no dry-run position to close. Nothing was changed.", 409);

    const now = deps.now();
    const at = now.toISOString();
    let exitBid: number | null = null;
    if (!req.unpriced) {
      const spotRes = await deps.readSpot();
      const quote = spotRes.ok ? await deps.readHeld(held, spotRes.value.price, etClock(now).date, now) : null;
      if (!quote) return refuse("NO_QUOTE", `No usable quote for ${held.symbol} right now, so the close cannot be priced. Try again, or close it without a price (the result is then recorded as unknown). Nothing was changed.`, 409);
      exitBid = quote.bid;
    }
    const pnl = exitBid === null ? null : (exitBid - held.entryAsk) * CONTRACT_MULTIPLIER;
    const entry: JournalEntry = {
      id: `manual-close-${at}`,
      at,
      kind: "manual-close",
      symbol: held.symbol,
      type: held.type,
      strike: held.strike,
      expiration: held.expiration,
      delta: held.entryDelta,
      costUsd: held.entryAsk * CONTRACT_MULTIPLIER,
      exitBid,
      pnlUsd: pnl,
      note: `MANUAL dry-run close of ${held.symbol}: ${exitBid === null ? "closed WITHOUT a price, result unknown" : `sold at the bid ${usd(exitBid)} against the entry ask ${usd(held.entryAsk)}, result ${signedUsd(pnl as number)} per contract`}. No order sent.`,
    };
    const saved = await saveVerified(store as DeskStore, { version: 1, position: null, journal: withJournal(st.state, entry) });
    if (!saved.ok) return refuse("STORE", saved.error, 502);
    return { ok: true, message: entry.note, entry, state: saved.state };
  } catch (e) {
    return refuse("STORE", `Unexpected error (${e instanceof Error ? e.name : "unknown"}). Check the state shown.`, 500);
  }
}

/* -------------------------------------------------------------- snapshot */

export type ReadingView = {
  timeframe: LongTimeframe;
  name: string;
  isDecision: boolean;
  status: "ok" | "unavailable";
  /** Drive / Neutral / Reverse / Data unavailable. */
  label: string;
  candle: "green" | "red" | "flat" | null;
  open: number | null;
  close: number | null;
  previousClose: number | null;
  /** The raw signed net volume (shares), to compare with the chart. */
  netVolume: number | null;
  netFlag: "zero" | "missing" | null;
  match: "agree" | "disagree" | null;
  periodStart: string | null;
  asOf: string | null;
  reason: string | null;
};

export type ContractView = {
  symbol: string;
  type: OptionType;
  strike: number;
  expiration: string;
  daysToExpiry: number;
  delta: number;
  deltaSource: string;
  bid: number;
  ask: number;
  mid: number;
  spreadPct: number;
  costAtAsk: number;
  quoteAt: string;
  belowTarget: boolean;
};

export type EnginePickView =
  | { status: "contract"; type: OptionType; contract: ContractView; tier: "primary" | "fallback"; fallbackLabel: string | null; fallbackReason: string | null; budget: number; affordable: boolean; shortfall: number }
  | { status: "none"; type: OptionType; reason: string }
  | { status: "not-applicable"; reason: string };

export type PositionView =
  | { status: "none" }
  | { status: "unknown"; reason: string }
  | {
      status: "held";
      type: OptionType;
      symbol: string;
      strike: number;
      expiration: string;
      entryAt: string;
      entryAsk: number;
      entryDelta: number;
      costUsd: number;
      deltaTier: "primary" | "fallback";
      belowTargetLabel: string | null;
      source: "manual";
      quote: { bid: number; ask: number; pnlUsd: number } | null;
    };

export type CandidateList = { type: OptionType; expiration: string | null; total: number; shown: ContractView[]; error: string | null };

export type DeskSnapshot = {
  ok: true;
  dryRun: true;
  generatedAt: string;
  timeframe: LongTimeframe;
  liveBudget: number;
  spot: Spot | null;
  readings: ReadingView[];
  decision: { action: Decision["action"] | "UNKNOWN"; reason: string; traderDecides: boolean };
  enginePick: EnginePickView;
  position: PositionView;
  ticket: { open: boolean; reason: string | null; calls: CandidateList | null; puts: CandidateList | null };
  store: { available: boolean; error: string | null };
  journal: JournalEntry[];
  events: Array<{ at: string; kind: string; message: string }>;
  notes: string[];
  rules: { minDays: number; primary: number; floor: number; fallbackLabel: string };
};

function readingView(r: LongReading, isDecision: boolean): ReadingView {
  return {
    timeframe: r.timeframe,
    name: LONG_TIMEFRAME_NAMES[r.timeframe],
    isDecision,
    status: r.status,
    label: r.label,
    candle: r.kind,
    open: r.open,
    close: r.close,
    previousClose: r.previousClose,
    netVolume: r.netVolume,
    netFlag: r.netFlag,
    match: r.agreement,
    periodStart: r.periodStart,
    asOf: r.asOf,
    reason: r.reason,
  };
}

export function contractView(row: ChainRow, today: string): ContractView {
  return {
    symbol: row.symbol,
    type: row.type,
    strike: row.strike,
    expiration: row.expiration,
    daysToExpiry: daysBetween(today, row.expiration),
    delta: row.delta,
    deltaSource: row.deltaSource,
    bid: row.bid,
    ask: row.ask,
    mid: row.mid,
    spreadPct: row.spreadPct,
    costAtAsk: row.costAtAsk,
    quoteAt: row.quoteAt,
    belowTarget: Math.abs(row.delta) < DELTA_THRESHOLDS.primary,
  };
}

function candidateList(side: SideReport, today: string): CandidateList {
  const expiration = side.pick.expiration ?? side.eligible[0]?.expiration ?? null;
  return { type: side.type, expiration, total: side.eligible.length, shown: side.eligible.slice(0, CANDIDATES_MAX).map((r) => contractView(r, today)), error: side.error };
}

const rulesView = (): DeskSnapshot["rules"] => ({ minDays: MIN_DAYS_TO_EXPIRY, primary: DELTA_THRESHOLDS.primary, floor: DELTA_THRESHOLDS.floor, fallbackLabel: FALLBACK_LABEL });

/**
 * Everything the page shows, in one JSON-serialisable object. Reads market data and the saved desk state; writes nothing.
 * Never throws: every failure becomes visible text ("data unavailable", "unknown"), never a made-up value.
 */
export async function buildDeskSnapshot(deps: DeskDeps, config: DeskConfig, store: DeskStore | null): Promise<DeskSnapshot> {
  const now = deps.now();
  const notes: string[] = [];
  const base: DeskSnapshot = {
    ok: true,
    dryRun: true,
    generatedAt: now.toISOString(),
    timeframe: config.timeframe,
    liveBudget: config.liveBudget,
    spot: null,
    readings: [],
    decision: { action: "UNKNOWN", reason: "not evaluated", traderDecides: false },
    enginePick: { status: "not-applicable", reason: "No decision yet." },
    position: { status: "unknown", reason: "not read" },
    ticket: { open: false, reason: "not evaluated", calls: null, puts: null },
    store: { available: store !== null, error: null },
    journal: [],
    events: [],
    notes,
    rules: rulesView(),
  };

  let state: DeskState | null = null;
  if (!store) {
    base.store = { available: false, error: "No desk store is configured (KV_REST_API_URL / KV_REST_API_TOKEN). The dry-run position cannot be read or saved, so the manual ticket and Close are off." };
    base.position = { status: "unknown", reason: "No desk store is configured." };
  } else {
    try {
      const r = await store.read();
      if (r.ok) state = r.state;
      else {
        base.store = { available: false, error: r.error };
        base.position = { status: "unknown", reason: r.error };
      }
    } catch {
      base.store = { available: false, error: "The desk store failed." };
      base.position = { status: "unknown", reason: "The desk store failed." };
    }
  }
  if (state) {
    base.journal = state.journal.slice(-JOURNAL_SHOWN).reverse();
    base.position = { status: "none" };
  }

  try {
    const cap: { spot: Spot | null } = { spot: null };
    const spotOrRead = async (): Promise<Spot | null> => {
      if (cap.spot) return cap.spot;
      const r = await deps.readSpot();
      if (r.ok) cap.spot = r.value;
      return cap.spot;
    };
    const captured = new Map<OptionType, SideReport>();
    const spied: EngineDeps = {
      now: deps.now,
      loadDaily: deps.loadDaily,
      readSpot: async () => {
        const r = await deps.readSpot();
        if (r.ok) cap.spot = r.value;
        return r;
      },
      readSide: async (type, spot, today, at) => {
        const s = await deps.readSide(type, spot, today, at);
        captured.set(type, s);
        return s;
      },
      readHeld: deps.readHeld,
    };
    const engineConfig: EngineConfig = { timeframe: config.timeframe, liveBudget: config.liveBudget };
    const result = await runEngine(spied, engineConfig, { ...EMPTY_STATE, position: state?.position ?? null });
    base.events = result.events.slice(-EVENTS_SHOWN).map((e) => ({ at: e.at, kind: e.kind, message: e.message }));
    if (result.readings) base.readings = LONG_TIMEFRAMES.map((tf) => readingView(result.readings![tf], tf === config.timeframe));
    if (!result.decision) {
      base.decision = { action: "UNKNOWN", reason: "The engine could not evaluate (see the log below). Nothing is assumed.", traderDecides: false };
    } else {
      base.decision = { action: result.decision.action, reason: result.decision.reason, traderDecides: result.decision.traderDecides };
    }
    const today = etClock(now).date;
    base.spot = cap.spot;

    const action = result.decision?.action ?? null;
    const wantType: OptionType | null = action === "CALL" ? "call" : action === "PUT" ? "put" : null;

    if (action === "DATA_UNAVAILABLE" || action === null) {
      base.enginePick = { status: "not-applicable", reason: "Data unavailable: no decision, so no contract is chosen." };
    } else if (wantType === null) {
      base.enginePick = { status: "not-applicable", reason: "NEUTRAL: TRADER DECIDES. The engine picks nothing on a Neutral reading; use the manual ticket below." };
    } else {
      let side = captured.get(wantType) ?? null;
      if (!side) {
        const spot = await spotOrRead();
        if (spot) {
          base.spot = base.spot ?? spot;
          side = await deps.readSide(wantType, spot.price, today, now);
        }
      }
      if (!side) base.enginePick = { status: "none", type: wantType, reason: "The SPY price could not be read, so no contract was priced." };
      else if (!side.pick.ok) base.enginePick = { status: "none", type: wantType, reason: `${side.pick.reason}. Nothing is substituted.` };
      else {
        const row = side.pick.row;
        const afford = row.costAtAsk <= config.liveBudget;
        base.enginePick = {
          status: "contract",
          type: wantType,
          contract: contractView(row, today),
          tier: side.pick.tier,
          fallbackLabel: side.pick.tier === "fallback" ? FALLBACK_LABEL : null,
          fallbackReason: side.pick.fallbackReason,
          budget: config.liveBudget,
          affordable: afford,
          shortfall: afford ? 0 : row.costAtAsk - config.liveBudget,
        };
      }
      if (side?.error) notes.push(`Chain read problem (${wantType}s): ${side.error}`);
    }

    if (state?.position) {
      const p = state.position;
      let quote: { bid: number; ask: number; pnlUsd: number } | null = null;
      try {
        const spot = await spotOrRead();
        const q = spot ? await deps.readHeld(p, spot.price, today, now) : null;
        if (q) quote = { bid: q.bid, ask: q.ask, pnlUsd: (q.bid - p.entryAsk) * CONTRACT_MULTIPLIER };
      } catch {
        notes.push(`The quote for ${p.symbol} could not be read.`);
      }
      base.position = {
        status: "held",
        type: p.type,
        symbol: p.symbol,
        strike: p.strike,
        expiration: p.expiration,
        entryAt: p.entryAt,
        entryAsk: p.entryAsk,
        entryDelta: p.entryDelta,
        costUsd: p.entryAsk * CONTRACT_MULTIPLIER,
        deltaTier: p.deltaTier,
        belowTargetLabel: p.deltaTier === "fallback" ? MANUAL_BELOW_TARGET_LABEL : null,
        source: p.source,
        quote,
      };
    }

    const positionStatus = base.position.status === "held" ? "held" : base.position.status === "none" ? "none" : "unknown";
    const gate = ticketGate(result.decision, positionStatus, base.store.available);
    base.ticket = { open: gate.open, reason: gate.reason, calls: null, puts: null };
    if (gate.open) {
      const spot = await spotOrRead();
      if (!spot) {
        base.ticket = { open: false, reason: "The SPY price could not be read, so the chain cannot be priced. The ticket stays off.", calls: null, puts: null };
      } else {
        base.spot = base.spot ?? spot;
        const [calls, puts] = await Promise.all([deps.readSide("call", spot.price, today, now), deps.readSide("put", spot.price, today, now)]);
        const callList = candidateList(calls, today);
        const putList = candidateList(puts, today);
        base.ticket = { open: true, reason: null, calls: callList, puts: putList };
        if (calls.error) notes.push(`Chain read problem (calls): ${calls.error}`);
        if (puts.error) notes.push(`Chain read problem (puts): ${puts.error}`);
        if (callList.total === 0 && putList.total === 0) base.ticket = { ...base.ticket, open: false, reason: "No contract passes the rules right now (nearest expiry of at least 365 days, |delta| at least 0.60, usable quote). Nothing to choose." };
      }
    }
    if (!result.ok && result.decision && result.decision.action !== "DATA_UNAVAILABLE") notes.push("The engine reported a problem; see the log below.");
  } catch {
    notes.push("Unexpected error while building the page data. Nothing is assumed.");
  }
  return base;
}

/* ------------------------------------------------- client-side validation */

const isStr = (v: unknown): v is string => typeof v === "string";
const orNull = (guard: (v: unknown) => boolean, v: unknown): boolean => v === null || guard(v);

function isContractView(v: unknown): boolean {
  return isRecord(v) && isStr(v.symbol) && isOptionType(v.type) && finite(v.strike) && isStr(v.expiration) && finite(v.daysToExpiry) && finite(v.delta) && finite(v.bid) && finite(v.ask) && finite(v.mid) && finite(v.spreadPct) && finite(v.costAtAsk) && isStr(v.quoteAt) && typeof v.belowTarget === "boolean";
}

function isCandidateList(v: unknown): boolean {
  return isRecord(v) && isOptionType(v.type) && finite(v.total) && Array.isArray(v.shown) && v.shown.every(isContractView) && orNull(isStr, v.expiration) && orNull(isStr, v.error);
}

function isReadingView(v: unknown): boolean {
  return (
    isRecord(v) &&
    isLongTimeframe(v.timeframe) &&
    isStr(v.name) &&
    typeof v.isDecision === "boolean" &&
    (v.status === "ok" || v.status === "unavailable") &&
    isStr(v.label) &&
    orNull((x) => x === "green" || x === "red" || x === "flat", v.candle) &&
    orNull(finite, v.open) &&
    orNull(finite, v.close) &&
    orNull(finite, v.previousClose) &&
    orNull(finite, v.netVolume) &&
    orNull((x) => x === "zero" || x === "missing", v.netFlag) &&
    orNull((x) => x === "agree" || x === "disagree", v.match) &&
    orNull(isStr, v.periodStart) &&
    orNull(isStr, v.asOf) &&
    orNull(isStr, v.reason)
  );
}

/** Strict shape check of the snapshot the server sent, run in the browser before anything is drawn. */
export function parseDeskSnapshot(raw: unknown): { ok: true; snapshot: DeskSnapshot } | { ok: false; error: string } {
  const bad = (what: string) => ({ ok: false as const, error: `The server sent data in an unexpected shape (${what}). Nothing is shown rather than guessing.` });
  if (!isRecord(raw) || raw.ok !== true || raw.dryRun !== true) return bad("header");
  if (!isStr(raw.generatedAt) || !isLongTimeframe(raw.timeframe) || !finite(raw.liveBudget)) return bad("meta");
  if (!Array.isArray(raw.readings) || !raw.readings.every(isReadingView)) return bad("readings");
  if (!isRecord(raw.decision) || !isStr(raw.decision.action) || !isStr(raw.decision.reason) || typeof raw.decision.traderDecides !== "boolean") return bad("decision");
  const pick = raw.enginePick;
  if (!isRecord(pick) || !["contract", "none", "not-applicable"].includes(String(pick.status))) return bad("engine pick");
  if (pick.status === "contract" && !(isContractView(pick.contract) && (pick.tier === "primary" || pick.tier === "fallback") && finite(pick.budget) && typeof pick.affordable === "boolean" && finite(pick.shortfall))) return bad("engine pick contract");
  const pos = raw.position;
  if (!isRecord(pos) || !["none", "unknown", "held"].includes(String(pos.status))) return bad("position");
  if (pos.status === "held" && !(isStr(pos.symbol) && isOptionType(pos.type) && finite(pos.strike) && isStr(pos.expiration) && finite(pos.entryAsk) && finite(pos.costUsd) && finite(pos.entryDelta))) return bad("position details");
  const t = raw.ticket;
  if (!isRecord(t) || typeof t.open !== "boolean" || !orNull(isStr, t.reason) || !orNull(isCandidateList, t.calls) || !orNull(isCandidateList, t.puts)) return bad("ticket");
  if (!isRecord(raw.store) || typeof raw.store.available !== "boolean") return bad("store");
  if (!Array.isArray(raw.journal) || !raw.journal.every((e) => parseJournalEntry(e) !== null)) return bad("journal");
  if (!Array.isArray(raw.events) || !Array.isArray(raw.notes) || !raw.notes.every(isStr)) return bad("log");
  if (!isRecord(raw.rules) || !finite(raw.rules.minDays) || !finite(raw.rules.primary) || !finite(raw.rules.floor)) return bad("rules");
  return { ok: true, snapshot: raw as unknown as DeskSnapshot };
}
