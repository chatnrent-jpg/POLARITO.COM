/**
 * SPY-only options decision engine, DRY RUN ONLY.
 *
 * It reads the four period-to-date readings (longPolarity.ts), decides CALL / PUT / STAND ASIDE from the configured
 * decision timeframe (default monthly), picks the contract (nearest listed expiry of at least 365 days, |delta| >= 0.80,
 * optionsSelect.ts), and LOGS what it would do. It never submits, changes or cancels an order: it has no broker, no order
 * client and does not read POLARITO_LIVE_TRADING_ENABLED. Its only inputs are functions that read market data.
 *
 * Unidirectional flow: deps (data) -> readings -> decision -> position transition -> events + next state.
 *
 * Rules:
 *  - One position at a time. Max loss = the premium paid (long options only).
 *  - The decision uses only the decision timeframe's reading. The other three are shown for audit.
 *  - A reading that is "data unavailable" produces NO decision: nothing is bought, sold or changed.
 *  - Roll or exit ONLY when the decision timeframe's reading flips to the opposite side. A Neutral reading holds.
 *  - No automatic expiry roll: a warning is logged when the held contract has fewer than 60 days left.
 *  - Every change of any reading is logged with its timestamp, net volume and inputs.
 */
import type { BrokerErrorCode, Result } from "@/lib/broker/types";
import type { OptionType } from "@/lib/broker/options";
import { daysBetween } from "@/lib/broker/options";
import {
  LONG_TIMEFRAMES,
  LONG_TIMEFRAME_NAMES,
  NET_VOLUME_METHODS,
  computeLongReadings,
  isLongTimeframe,
  isNetVolumeMethod,
  longPeriodStart,
  readingsSummary,
  type IntradayBar,
  type LongReading,
  type LongReadings,
  type LongTimeframe,
  type NetVolumeMethod,
} from "@/lib/longPolarity";
import { etClock } from "@/lib/marketCalendar";
import { MIN_ABS_DELTA, MIN_DAYS_TO_EXPIRY, assertContractRules, usd, type ChainRow } from "@/lib/optionsSelect";
import type { Bar } from "@/lib/polarity";
import type { SideReport, Spot } from "@/lib/spyChain";

export const ENGINE_SYMBOL = "SPY";
export const EXPIRY_WARNING_DAYS = 60;
export const CONTRACT_MULTIPLIER = 100;

export type EngineConfig = {
  timeframe: LongTimeframe;
  method: NetVolumeMethod;
  /** Real account size for the plain affordability line only. The dry run always tracks one imaginary contract. */
  liveBudget: number;
};

export type EngineDeps = {
  now(): Date;
  loadDaily(): Promise<Result<Bar[], BrokerErrorCode>>;
  loadIntraday(start: string): Promise<Result<IntradayBar[], BrokerErrorCode>>;
  readSpot(): Promise<Result<Spot, BrokerErrorCode>>;
  readSide(type: OptionType, spot: number, today: string, now: Date): Promise<SideReport>;
  /** Fresh quote and delta for a contract already held (dry-run position); null when it cannot be read. */
  readHeld(p: DryPosition, spot: number, today: string, now: Date): Promise<ChainRow | null>;
};

export type DryPosition = {
  type: OptionType;
  symbol: string;
  expiration: string;
  strike: number;
  quantity: 1;
  entryAt: string;
  entryAsk: number;
  entryMid: number;
  entryDelta: number;
  decisionTimeframe: LongTimeframe;
  /** Premium paid x 100 x quantity: the most the position can lose. */
  maxLossUsd: number;
};

export type ReadingMemory = { polarity: number | null; since: string };

export type EngineState = {
  version: 1;
  readings: Partial<Record<LongTimeframe, ReadingMemory>>;
  position: DryPosition | null;
};

export const EMPTY_STATE: EngineState = Object.freeze({ version: 1, readings: {}, position: null }) as EngineState;

export type EventKind =
  | "run"
  | "reading-change"
  | "decision"
  | "would-buy"
  | "would-sell"
  | "hold"
  | "no-contract"
  | "data-unavailable"
  | "warning"
  | "error";

export type EngineEvent = { at: string; kind: EventKind; message: string; data?: Record<string, unknown> };

export type Decision = {
  action: "CALL" | "PUT" | "STAND_ASIDE" | "DATA_UNAVAILABLE";
  timeframe: LongTimeframe;
  reason: string;
};

export type EngineResult = {
  ok: boolean;
  state: EngineState;
  events: EngineEvent[];
  decision: Decision | null;
  readings: LongReadings | null;
  /** The other two methods, computed from the same data for comparison only. Never used to decide. */
  comparison: Partial<Record<NetVolumeMethod, LongReadings>>;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Strict shape check for a persisted state. Never repairs a bad file by guessing. */
export function parseEngineState(raw: unknown): { ok: true; state: EngineState } | { ok: false; error: string } {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.readings)) return { ok: false, error: "state file has an unexpected shape" };
  const readings: Partial<Record<LongTimeframe, ReadingMemory>> = {};
  for (const [k, v] of Object.entries(raw.readings)) {
    if (!isLongTimeframe(k)) return { ok: false, error: `state has an unknown timeframe "${k}"` };
    if (!isRecord(v) || !(v.polarity === null || v.polarity === 1 || v.polarity === 0 || v.polarity === -1) || typeof v.since !== "string") return { ok: false, error: `state reading ${k} is malformed` };
    readings[k] = { polarity: v.polarity as number | null, since: v.since };
  }
  let position: DryPosition | null = null;
  if (raw.position !== null && raw.position !== undefined) {
    const p = raw.position;
    if (
      !isRecord(p) ||
      (p.type !== "call" && p.type !== "put") ||
      typeof p.symbol !== "string" ||
      typeof p.expiration !== "string" ||
      typeof p.strike !== "number" ||
      p.quantity !== 1 ||
      typeof p.entryAt !== "string" ||
      typeof p.entryAsk !== "number" ||
      typeof p.entryMid !== "number" ||
      typeof p.entryDelta !== "number" ||
      !isLongTimeframe(p.decisionTimeframe) ||
      typeof p.maxLossUsd !== "number"
    ) {
      return { ok: false, error: "state position is malformed" };
    }
    position = p as unknown as DryPosition;
  }
  return { ok: true, state: { version: 1, readings, position } };
}

export function parseEngineConfig(env: Readonly<Record<string, string | undefined>>): { ok: true; config: EngineConfig } | { ok: false; error: string } {
  const timeframe = (env.SPY_DECISION_TIMEFRAME ?? "M").trim().toUpperCase();
  if (!isLongTimeframe(timeframe)) return { ok: false, error: `SPY_DECISION_TIMEFRAME must be one of M, Q, H, Y (got "${timeframe}"); there is no daily or weekly option` };
  const method = (env.SPY_NET_VOLUME_METHOD ?? "signed-intraday").trim();
  if (!isNetVolumeMethod(method)) return { ok: false, error: `SPY_NET_VOLUME_METHOD must be one of ${NET_VOLUME_METHODS.join(", ")} (got "${method}")` };
  const liveBudget = Number(env.SPY_LIVE_BUDGET ?? "1000");
  if (!Number.isFinite(liveBudget) || liveBudget <= 0) return { ok: false, error: "SPY_LIVE_BUDGET must be a positive number" };
  return { ok: true, config: { timeframe, method, liveBudget } };
}

const gear = (p: number | null): string => (p === 1 ? "Drive" : p === -1 ? "Reverse" : p === 0 ? "Neutral" : "Data unavailable");
const millions = (n: number | null): string => (n === null ? "n/a" : `${(n / 1e6).toFixed(1)}M`);

function readingData(r: LongReading): Record<string, unknown> {
  return {
    timeframe: r.timeframe,
    method: r.method,
    status: r.status,
    reading: gear(r.polarity),
    periodStart: r.periodStart,
    throughDate: r.throughDate,
    asOf: r.asOf,
    lastBarAt: r.lastBarAt,
    sessions: r.sessions,
    netVolume: r.netVolume,
    upVolume: r.upVolume,
    downVolume: r.downVolume,
    reason: r.reason,
  };
}

/** One evaluation. Never throws; every problem becomes an event. Never places an order. */
export async function runEngine(deps: EngineDeps, config: EngineConfig, previous: EngineState): Promise<EngineResult> {
  const now = deps.now();
  const at = now.toISOString();
  const events: EngineEvent[] = [];
  const emit = (kind: EventKind, message: string, data?: Record<string, unknown>): void => {
    events.push({ at, kind, message, ...(data ? { data } : {}) });
  };
  const state: EngineState = { version: 1, readings: { ...previous.readings }, position: previous.position };
  const base: EngineResult = { ok: false, state, events, decision: null, readings: null, comparison: {} };

  try {
    emit("run", `Dry run (no orders can be sent). Decision timeframe ${LONG_TIMEFRAME_NAMES[config.timeframe]}, net volume method ${config.method}.`, { timeframe: config.timeframe, method: config.method, dryRun: true });

    const today = etClock(now).date;
    const dailyRes = await deps.loadDaily();
    if (!dailyRes.ok) {
      emit("data-unavailable", `Data unavailable: daily bars could not be read (${dailyRes.error}). No decision.`);
      return { ...base, decision: { action: "DATA_UNAVAILABLE", timeframe: config.timeframe, reason: dailyRes.error } };
    }
    const daily = dailyRes.value;

    let intraday: IntradayBar[] | undefined;
    let intradayError: string | null = null;
    const intradayRes = await deps.loadIntraday(longPeriodStart(today, "Y"));
    if (intradayRes.ok) intraday = intradayRes.value;
    else intradayError = intradayRes.error;

    const withNote = (rs: LongReadings): LongReadings => {
      if (!intradayError) return rs;
      const out = { ...rs } as Record<LongTimeframe, LongReading>;
      for (const tf of LONG_TIMEFRAMES) {
        const r = rs[tf];
        if (r.status === "unavailable" && r.reason?.startsWith("no 5-minute bars")) out[tf] = { ...r, reason: `5-minute bars could not be read (${intradayError})` };
      }
      return out;
    };
    const readings = withNote(computeLongReadings({ daily, intraday, now, method: config.method }));
    const comparison: Partial<Record<NetVolumeMethod, LongReadings>> = {};
    for (const m of NET_VOLUME_METHODS) if (m !== config.method) comparison[m] = withNote(computeLongReadings({ daily, intraday, now, method: m }));
    const result: EngineResult = { ...base, readings, comparison };

    emit("run", `Readings as of ${at}: ${readingsSummary(readings)} (D = Drive, R = Reverse, - = data unavailable).`, {
      readings: Object.fromEntries(LONG_TIMEFRAMES.map((tf) => [tf, readingData(readings[tf])])),
      comparison: Object.fromEntries(Object.entries(comparison).map(([m, rs]) => [m, readingsSummary(rs as LongReadings)])),
    });

    for (const tf of LONG_TIMEFRAMES) {
      const r = readings[tf];
      const prev = state.readings[tf];
      if (prev !== undefined && prev.polarity !== r.polarity) {
        emit("reading-change", `${LONG_TIMEFRAME_NAMES[tf]} reading changed ${gear(prev.polarity)} -> ${gear(r.polarity)} (net volume ${millions(r.netVolume)}, period from ${r.periodStart}).`, { from: prev.polarity, to: r.polarity, since: prev.since, ...readingData(r) });
      }
      if (prev === undefined || prev.polarity !== r.polarity) state.readings[tf] = { polarity: r.polarity, since: at };
    }

    const primary = readings[config.timeframe];
    if (primary.status !== "ok" || primary.polarity === null) {
      const reason = primary.reason ?? "unknown";
      const decision: Decision = { action: "DATA_UNAVAILABLE", timeframe: config.timeframe, reason };
      emit("data-unavailable", `Data unavailable for the ${LONG_TIMEFRAME_NAMES[config.timeframe]} reading: ${reason}. No decision; nothing changes.`, { reason });
      return { ...result, decision };
    }

    const action: Decision["action"] = primary.polarity === 1 ? "CALL" : primary.polarity === -1 ? "PUT" : "STAND_ASIDE";
    const decision: Decision = {
      action,
      timeframe: config.timeframe,
      reason: `${LONG_TIMEFRAME_NAMES[config.timeframe]} net volume ${millions(primary.netVolume)} since ${primary.periodStart} reads ${gear(primary.polarity)}`,
    };
    emit("decision", `Decision: ${action.replace("_", " ")}. ${decision.reason}.`, { action, ...readingData(primary) });

    const held = state.position;
    const wantType: OptionType | null = action === "CALL" ? "call" : action === "PUT" ? "put" : null;

    if (held && daysBetween(today, held.expiration) < EXPIRY_WARNING_DAYS) {
      emit("warning", `The held contract ${held.symbol} has ${daysBetween(today, held.expiration)} days left. There is no automatic roll: it changes only when the ${LONG_TIMEFRAME_NAMES[config.timeframe]} reading flips.`);
    }

    if (held && (wantType === null || wantType === held.type)) {
      emit("hold", wantType === null ? `Reading is Neutral: nothing new; holding ${held.symbol}.` : `Holding ${held.symbol}: the ${LONG_TIMEFRAME_NAMES[config.timeframe]} reading still says ${action}.`, { symbol: held.symbol });
      return { ...result, ok: true, decision };
    }

    if (!held && wantType === null) {
      emit("hold", "Stand aside: no position and no side to take.");
      return { ...result, ok: true, decision };
    }

    const spotRes = await deps.readSpot();
    if (!spotRes.ok) {
      emit("no-contract", `Cannot price a contract: the SPY price could not be read (${spotRes.error}). Nothing changes.`);
      return { ...result, ok: true, decision };
    }
    const spot = spotRes.value;

    if (held) {
      const quote = await deps.readHeld(held, spot.price, today, now);
      const exitBid = quote ? quote.bid : null;
      const pnl = exitBid === null ? null : (exitBid - held.entryAsk) * CONTRACT_MULTIPLIER;
      emit(
        "would-sell",
        `WOULD SELL ${held.symbol} because the ${LONG_TIMEFRAME_NAMES[config.timeframe]} reading flipped to ${gear(primary.polarity)}${exitBid === null ? " (no usable quote to price the sale)" : ` at the bid ${usd(exitBid)}; result versus the entry ask ${pnl === null ? "n/a" : usd(pnl)} per contract`}. Dry run: no order sent.`,
        { symbol: held.symbol, exitBid, pnlUsd: pnl, maxLossUsd: held.maxLossUsd },
      );
      state.position = null;
    }

    if (wantType === null) return { ...result, ok: true, decision };

    const side = await deps.readSide(wantType, spot.price, today, now);
    if (side.error) emit("warning", `Chain read problem (${wantType}s): ${side.error}`);
    if (!side.pick.ok) {
      emit("no-contract", `No ${wantType} bought: ${side.pick.reason}. Rules: expiry at least ${MIN_DAYS_TO_EXPIRY} days out (nearest listed), |delta| >= ${MIN_ABS_DELTA}. Nothing is substituted.`, { rejected: side.rejected });
      return { ...result, ok: true, decision };
    }
    const row = side.pick.row;
    const broken = assertContractRules(row, wantType, today);
    if (broken) {
      emit("error", `Refusing ${row.symbol}: ${broken}.`);
      return { ...result, ok: false, decision };
    }
    const cost = row.costAtAsk;
    const budgetNote = cost > config.liveBudget ? `NOT affordable on the ${usd(config.liveBudget)} live account (short by ${usd(cost - config.liveBudget)}); dry run tracks one imaginary contract` : `fits the ${usd(config.liveBudget)} live account`;
    emit(
      "would-buy",
      `WOULD BUY 1 ${wantType.toUpperCase()} ${row.symbol} (strike ${row.strike}, expires ${row.expiration}, ${side.pick.daysToExpiry} days out), delta ${row.delta.toFixed(3)} (${row.deltaSource}), ask ${usd(row.ask)}, cost ${usd(cost)} per contract; max loss = premium ${usd(cost)}; ${budgetNote}. Dry run: no order sent.`,
      { symbol: row.symbol, type: wantType, strike: row.strike, expiration: row.expiration, daysToExpiry: side.pick.daysToExpiry, delta: row.delta, deltaSource: row.deltaSource, bid: row.bid, ask: row.ask, mid: row.mid, spreadPct: row.spreadPct, iv: row.iv, costAtAsk: cost, quoteAt: row.quoteAt },
    );
    state.position = {
      type: wantType,
      symbol: row.symbol,
      expiration: row.expiration,
      strike: row.strike,
      quantity: 1,
      entryAt: at,
      entryAsk: row.ask,
      entryMid: row.mid,
      entryDelta: row.delta,
      decisionTimeframe: config.timeframe,
      maxLossUsd: cost,
    };
    return { ...result, ok: true, decision };
  } catch (e) {
    emit("error", `Unexpected error: ${e instanceof Error ? e.message : "unknown"}. State unchanged.`);
    return { ...base, state: previous, ok: false };
  }
}
