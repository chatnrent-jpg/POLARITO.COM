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
 *  - CALL only on Drive (+1), PUT only on Reverse (-1), STAND ASIDE on Neutral (0). The reading is Neutral when candle
 *    colour and net volume disagree (longPolarity.ts), so no new entry happens on a disagreement.
 *  - Roll or exit when the decision timeframe's reading flips to the opposite side (Drive <-> Reverse).
 *  - NEUTRAL = TRADER DECIDES. When the reading is Neutral the engine takes NO automatic action: no exit of a held
 *    position, no new entry. It only flags it clearly ("NEUTRAL: TRADER DECIDES") in the log and report. The trader then
 *    decides by hand (the SPY option ticket and a Close button are later PRs, disabled for live until Henry says).
 *    There is no config option that turns Neutral into an automatic exit or entry.
 *  - No automatic expiry roll: a warning is logged when the held contract has fewer than 60 days left.
 *  - Every change of any reading is logged with its timestamp, net volume and inputs.
 */
import type { BrokerErrorCode, Result } from "@/lib/broker/types";
import type { OptionType } from "@/lib/broker/options";
import { daysBetween } from "@/lib/broker/options";
import {
  LONG_TIMEFRAMES,
  LONG_TIMEFRAME_NAMES,
  computeLongReadings,
  isLongTimeframe,
  longPeriodStart,
  readingsSummary,
  type IntradayBar,
  type LongReading,
  type LongReadings,
  type LongTimeframe,
} from "@/lib/longPolarity";
import { etClock } from "@/lib/marketCalendar";
import { MIN_ABS_DELTA, MIN_DAYS_TO_EXPIRY, assertContractRules, usd, type ChainRow } from "@/lib/optionsSelect";
import type { Bar } from "@/lib/polarity";
import type { SideReport, Spot } from "@/lib/spyChain";

export const ENGINE_SYMBOL = "SPY";
export const EXPIRY_WARNING_DAYS = 60;
export const CONTRACT_MULTIPLIER = 100;

/** The only Neutral policy: the engine does nothing by itself and flags it; the trader decides. */
export const NEUTRAL_POLICY = "manual" as const;

export type EngineConfig = {
  timeframe: LongTimeframe;
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
  /** When the decision timeframe's reading first went Neutral in the current spell (trader decides); null otherwise. */
  neutralSince: string | null;
};

export const EMPTY_STATE: EngineState = Object.freeze({ version: 1, readings: {}, position: null, neutralSince: null }) as EngineState;

export type EventKind =
  | "run"
  | "reading-change"
  | "decision"
  | "would-buy"
  | "would-sell"
  | "hold"
  | "trader-decides"
  | "no-contract"
  | "data-unavailable"
  | "warning"
  | "error";

export type EngineEvent = { at: string; kind: EventKind; message: string; data?: Record<string, unknown> };

export type Decision = {
  action: "CALL" | "PUT" | "STAND_ASIDE" | "DATA_UNAVAILABLE";
  timeframe: LongTimeframe;
  reason: string;
  /** True when the reading is Neutral: the engine does nothing and the trader decides. */
  traderDecides: boolean;
};

export type EngineResult = {
  ok: boolean;
  state: EngineState;
  events: EngineEvent[];
  decision: Decision | null;
  readings: LongReadings | null;
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
  const neutralSince = raw.neutralSince === undefined || raw.neutralSince === null ? null : raw.neutralSince;
  if (neutralSince !== null && typeof neutralSince !== "string") return { ok: false, error: "state neutralSince is malformed" };
  return { ok: true, state: { version: 1, readings, position, neutralSince } };
}

export function parseEngineConfig(env: Readonly<Record<string, string | undefined>>): { ok: true; config: EngineConfig } | { ok: false; error: string } {
  const timeframe = (env.SPY_DECISION_TIMEFRAME ?? "M").trim().toUpperCase();
  if (!isLongTimeframe(timeframe)) return { ok: false, error: `SPY_DECISION_TIMEFRAME must be one of M, Q, H, Y (got "${timeframe}"); there is no daily or weekly option` };
  if (env.SPY_NET_VOLUME_METHOD !== undefined) return { ok: false, error: "SPY_NET_VOLUME_METHOD is no longer supported: there is exactly one net volume method (signed 5-minute volume summed over the whole period)" };
  const onNeutral = (env.SPY_ON_NEUTRAL ?? NEUTRAL_POLICY).trim().toLowerCase();
  if (onNeutral !== NEUTRAL_POLICY) return { ok: false, error: `SPY_ON_NEUTRAL, if set, must be "${NEUTRAL_POLICY}": on Neutral the trader decides; there is no automatic exit or entry` };
  const liveBudget = Number(env.SPY_LIVE_BUDGET ?? "1000");
  if (!Number.isFinite(liveBudget) || liveBudget <= 0) return { ok: false, error: "SPY_LIVE_BUDGET must be a positive number" };
  return { ok: true, config: { timeframe, liveBudget } };
}

const gear = (p: number | null): string => (p === 1 ? "Drive" : p === -1 ? "Reverse" : p === 0 ? "Neutral" : "Data unavailable");
const millions = (n: number | null): string => (n === null ? "n/a" : `${(n / 1e6).toFixed(1)}M`);

function readingData(r: LongReading): Record<string, unknown> {
  return {
    timeframe: r.timeframe,
    status: r.status,
    reading: gear(r.polarity),
    candle: r.kind,
    open: r.open,
    close: r.close,
    netSign: r.netSign,
    agreement: r.agreement,
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
  const state: EngineState = { version: 1, readings: { ...previous.readings }, position: previous.position, neutralSince: previous.neutralSince };
  const base: EngineResult = { ok: false, state, events, decision: null, readings: null };

  try {
    emit("run", `Dry run (no orders can be sent). Decision timeframe ${LONG_TIMEFRAME_NAMES[config.timeframe]}, net volume = signed 5-minute volume summed over the whole period.`, { timeframe: config.timeframe, dryRun: true });

    const today = etClock(now).date;
    const dailyRes = await deps.loadDaily();
    if (!dailyRes.ok) {
      emit("data-unavailable", `Data unavailable: daily bars could not be read (${dailyRes.error}). No decision.`);
      return { ...base, decision: { action: "DATA_UNAVAILABLE", timeframe: config.timeframe, reason: dailyRes.error, traderDecides: false } };
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
    const readings = withNote(computeLongReadings({ daily, intraday, now }));
    const result: EngineResult = { ...base, readings };

    emit("run", `Readings as of ${at}: ${readingsSummary(readings)} (D = Drive, R = Reverse, - = data unavailable).`, {
      readings: Object.fromEntries(LONG_TIMEFRAMES.map((tf) => [tf, readingData(readings[tf])])),
    });

    for (const tf of LONG_TIMEFRAMES) {
      const r = readings[tf];
      const prev = state.readings[tf];
      if (prev !== undefined && prev.polarity !== r.polarity) {
        emit("reading-change", `${LONG_TIMEFRAME_NAMES[tf]} reading changed ${gear(prev.polarity)} -> ${gear(r.polarity)} (candle ${r.kind ?? "n/a"}, net volume ${millions(r.netVolume)}${r.agreement === "disagree" ? ", they disagree" : ""}, period from ${r.periodStart}).`, { from: prev.polarity, to: r.polarity, since: prev.since, ...readingData(r) });
      }
      if (prev === undefined || prev.polarity !== r.polarity) state.readings[tf] = { polarity: r.polarity, since: at };
    }

    const primary = readings[config.timeframe];
    if (primary.status !== "ok" || primary.polarity === null) {
      const reason = primary.reason ?? "unknown";
      const decision: Decision = { action: "DATA_UNAVAILABLE", timeframe: config.timeframe, reason, traderDecides: false };
      emit("data-unavailable", `Data unavailable for the ${LONG_TIMEFRAME_NAMES[config.timeframe]} reading: ${reason}. No decision; nothing changes.`, { reason });
      return { ...result, decision };
    }

    const action: Decision["action"] = primary.polarity === 1 ? "CALL" : primary.polarity === -1 ? "PUT" : "STAND_ASIDE";
    const decision: Decision = {
      action,
      timeframe: config.timeframe,
      traderDecides: action === "STAND_ASIDE",
      reason: `${LONG_TIMEFRAME_NAMES[config.timeframe]} since ${primary.periodStart}: candle ${primary.kind}, net volume ${millions(primary.netVolume)}, ${primary.agreement === "agree" ? "they agree" : "they do not agree"}, so the reading is ${gear(primary.polarity)}`,
    };
    emit("decision", `Decision: ${action.replace("_", " ")}. ${decision.reason}.`, { action, ...readingData(primary) });

    const held = state.position;
    const wantType: OptionType | null = action === "CALL" ? "call" : action === "PUT" ? "put" : null;

    if (held && daysBetween(today, held.expiration) < EXPIRY_WARNING_DAYS) {
      emit("warning", `The held contract ${held.symbol} has ${daysBetween(today, held.expiration)} days left. There is no automatic roll: it changes only when the ${LONG_TIMEFRAME_NAMES[config.timeframe]} reading flips.`);
    }

    if (wantType === null) {
      const since = state.neutralSince ?? at;
      const first = state.neutralSince === null;
      state.neutralSince = since;
      const why = `${LONG_TIMEFRAME_NAMES[config.timeframe]} candle ${primary.kind} and net volume ${millions(primary.netVolume)} do not agree`;
      let extra = "";
      let data: Record<string, unknown> = { held: held ? held.symbol : null, neutralSince: since, automatic: false };
      if (held) {
        const spotRead = await deps.readSpot();
        const quote = spotRead.ok ? await deps.readHeld(held, spotRead.value.price, today, now) : null;
        if (quote) {
          const pnl = (quote.bid - held.entryAsk) * CONTRACT_MULTIPLIER;
          extra = ` Held ${held.symbol} now bids ${usd(quote.bid)} / asks ${usd(quote.ask)} (entry ask ${usd(held.entryAsk)}; result if sold at the bid ${usd(pnl)} per contract; max loss ${usd(held.maxLossUsd)}).`;
          data = { ...data, bid: quote.bid, ask: quote.ask, pnlUsd: pnl };
        } else {
          extra = ` Held ${held.symbol}: no usable quote right now.`;
        }
      }
      emit(
        "trader-decides",
        `NEUTRAL: TRADER DECIDES. ${why}${first ? "" : ` (Neutral since ${since})`}. ${held ? `No automatic exit: ${held.symbol} stays as it is.` : "No position and no automatic entry."}${extra} Decide by hand (the SPY option ticket and Close button come in later PRs, disabled for live).`,
        data,
      );
      return { ...result, ok: true, decision };
    }
    state.neutralSince = null;

    if (held && wantType === held.type) {
      emit("hold", `Holding ${held.symbol}: the ${LONG_TIMEFRAME_NAMES[config.timeframe]} reading still says ${action}.`, { symbol: held.symbol });
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
