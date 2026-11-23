/**
 * Daily Weis Wave Volume (WWV) for the SPY DESK WWV: pure functions, no I/O, no clock of their own (the caller passes `now`),
 * no orders. Setting fixed at 1: a bar's direction is its close against the PREVIOUS bar's close, one bar back.
 *
 * WAVES (the interpretation, one paragraph):
 *   Each daily bar after the first has a direction: close above the previous close = UP, below = DOWN, equal = it CONTINUES
 *   the wave already running (an equal close never starts or ends a wave; with no wave yet it belongs to none). A wave is a
 *   run of bars of the same direction. Wave volume is the sum of the bars' volume in the wave and restarts at every turn:
 *   standard Weis, the TURNING bar belongs to the NEW wave (its volume is the first volume of the new total), and a bar that
 *   continues on an equal close adds its volume to the running wave. The gap between yesterday's close and today's open does
 *   not matter: only close against close sets the direction. The very first bar of the history has no previous close, so it
 *   has no direction and belongs to no wave.
 *
 * THE READING (the latest daily bar decides):
 *   latest candle GREEN (close > open) and current wave UP   -> +1 Drive
 *   latest candle RED   (close < open) and current wave DOWN -> -1 Reverse
 *   anything else (colour and wave disagree, or a flat candle) -> 0 Neutral (the trader decides)
 *
 * WHICH BAR: exactly as the monthly desk (longPolarity.dailyStaleReason): the newest daily bar must be today's session or the
 * last completed one, never older (stale) and never later than the latest session that can exist now (future-dated). During
 * the session (9:30 to 16:00 ET, including 9:30 to 9:50 when the provider already shows today's partial bar) that bar is IN PROGRESS (its close is the last price, so the reading
 * can flip until 16:00 ET and the page says so); after the close it is final. The scheduled auto run only acts from 16:15 ET,
 * so it always reads a final bar.
 *
 * NEVER A GUESS: a bar that fails the usual checks (finite numbers, ordered, high >= low, ...), a stale or missing newest
 * bar, a trading session missing inside the current wave (or the bar before it, whose close sets its direction), a zero or
 * missing volume in the current wave, or no direction at all (every close equal) make the reading "unavailable" with the
 * reason. The PREVIOUS wave is shown for context only: if it cannot be trusted (a missing session, zero volume, or it began
 * at the first bar of the history) it is shown as unavailable with the reason and the reading is NOT blocked by it.
 */
import { dailyStaleReason, type LongReading } from "@/lib/longPolarity";
import { etClock, sessionInProgress, tradingDaysBetween } from "@/lib/marketCalendar";
import { metaFor, validateBars, type Bar, type CandleKind, type Polarity } from "@/lib/polarity";

/** How far back (calendar days) the daily bars are loaded: about 140 sessions, ample for several waves. */
export const WWV_HISTORY_CALENDAR_DAYS = 200;

export type WaveDirection = "up" | "down";

export type Wave = {
  direction: WaveDirection;
  /** Index (in the bar array) of the bar that started the wave: the turning bar. */
  startIndex: number;
  endIndex: number;
  startDate: string;
  endDate: string;
  bars: number;
  volume: number;
};

/** The waves of a validated, chronological bar series. Pure; never throws on well-formed bars. */
export function buildWaves(bars: readonly Bar[]): Wave[] {
  const waves: Wave[] = [];
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i].close - bars[i - 1].close;
    const current = waves[waves.length - 1];
    const direction: WaveDirection | null = change > 0 ? "up" : change < 0 ? "down" : null;
    if (direction === null) {
      if (current) {
        current.endIndex = i;
        current.endDate = bars[i].date;
        current.bars++;
        current.volume += bars[i].volume;
      }
      continue;
    }
    if (current && current.direction === direction) {
      current.endIndex = i;
      current.endDate = bars[i].date;
      current.bars++;
      current.volume += bars[i].volume;
    } else {
      waves.push({ direction, startIndex: i, endIndex: i, startDate: bars[i].date, endDate: bars[i].date, bars: 1, volume: bars[i].volume });
    }
  }
  return waves;
}

export type PreviousWave = { direction: WaveDirection; volume: number; bars: number; start: string; end: string };

export type WwvDetail = {
  /** Direction of the wave running at the latest bar. */
  direction: WaveDirection;
  /** Volume of that wave so far (shares), always positive. */
  waveVolume: number;
  waveBars: number;
  waveStart: string;
  /** The wave before it, or null with `previousNote` saying why it is not shown. */
  previous: PreviousWave | null;
  previousNote: string | null;
  /** The date of the daily bar the reading uses. */
  barDate: string;
  /** True while that bar's session is still running (before 16:00 ET): its close can still change. */
  inProgress: boolean;
};

export type WwvReading = Omit<LongReading, "timeframe"> & { timeframe: "D"; wwv: WwvDetail | null };

export type WwvInput = { daily: readonly Bar[]; now: Date };

function unavailable(reason: string, throughDate: string, now: Date): WwvReading {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(throughDate) ? throughDate : etClock(now).date;
  return {
    timeframe: "D",
    status: "unavailable",
    polarity: null,
    label: "Data unavailable",
    reason,
    periodStart: anchor,
    periodEnd: anchor,
    throughDate,
    inProgress: false,
    asOf: now.toISOString(),
    sessions: 0,
    netVolume: null,
    totalVolume: null,
    netFlag: null,
    open: null,
    previousClose: null,
    close: null,
    kind: null,
    netSign: null,
    agreement: null,
    wwv: null,
  };
}

const kindOf = (open: number, close: number): CandleKind => (close > open ? "green" : close < open ? "red" : "flat");

/** The alignment rule: green + up wave = Drive, red + down wave = Reverse, anything else Neutral. */
export function wwvPolarity(kind: CandleKind, direction: WaveDirection): Polarity {
  if (kind === "green" && direction === "up") return 1;
  if (kind === "red" && direction === "down") return -1;
  return 0;
}

/**
 * First problem that makes the wave in bars[from+1..to] untrustworthy, else null: a missing session anywhere in from..to (bar `from`
 * is the one before the wave, whose close sets the direction of the first wave bar) or a zero/missing volume inside the wave.
 */
function windowProblem(bars: readonly Bar[], from: number, to: number): string | null {
  const have = new Set<string>();
  for (let i = from; i <= to; i++) have.add(bars[i].date);
  const missing = tradingDaysBetween(bars[from].date, bars[to].date).filter((d) => !have.has(d));
  if (missing.length > 0) return `no daily bar for ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""}`;
  for (let i = from + 1; i <= to; i++) if (!(bars[i].volume > 0)) return `volume missing or zero on ${bars[i].date}`;
  return null;
}

/** The daily WWV reading as of `now`. Never throws, never guesses. */
export function computeWwvReading(input: WwvInput): WwvReading {
  const { daily, now } = input;
  const newest = daily.length ? daily[daily.length - 1].date : "";
  try {
    validateBars(daily);
  } catch (e) {
    return unavailable(`daily bars rejected: ${e instanceof Error ? e.message : "malformed"}`, newest, now);
  }
  const stale = dailyStaleReason(daily, now);
  if (stale) return unavailable(`stale data: ${stale}`, newest, now);

  const waves = buildWaves(daily);
  const cur = waves[waves.length - 1];
  if (!cur) return unavailable("no wave yet: every close in the loaded history is equal to the one before it, so there is no direction", newest, now);

  // The bar before the wave sets the direction of its first bar, so it must be part of the checked window.
  const problem = windowProblem(daily, cur.startIndex - 1, daily.length - 1);
  if (problem) return unavailable(`the current wave cannot be trusted: ${problem}`, newest, now);

  const last = daily[daily.length - 1];
  const prevBar = daily[daily.length - 2];
  const kind = kindOf(last.open, last.close);
  const polarity = wwvPolarity(kind, cur.direction);

  const prevWave = waves.length >= 2 ? waves[waves.length - 2] : null;
  let previous: PreviousWave | null = null;
  let previousNote: string | null = null;
  if (!prevWave) {
    previousNote = "no earlier wave in the loaded history";
  } else if (prevWave.startIndex - 1 < 0) {
    previousNote = "the earlier wave began at the first bar of the loaded history, so its start is not known";
  } else {
    const p = windowProblem(daily, prevWave.startIndex - 1, cur.startIndex - 1);
    if (p) previousNote = `the earlier wave cannot be trusted: ${p}`;
    else previous = { direction: prevWave.direction, volume: prevWave.volume, bars: prevWave.bars, start: prevWave.startDate, end: prevWave.endDate };
  }

  const inProgress = sessionInProgress(last.date, now);
  const dirText = cur.direction === "up" ? "up" : "down";
  const signed = cur.direction === "up" ? cur.volume : -cur.volume;
  return {
    timeframe: "D",
    status: "ok",
    polarity,
    label: metaFor(polarity).label,
    reason:
      polarity === 0
        ? kind === "flat"
          ? `the latest candle is flat while the wave is ${dirText}: they do not agree, Neutral`
          : `the latest candle is ${kind} but the wave is ${dirText}: they do not agree, Neutral`
        : null,
    periodStart: cur.startDate,
    periodEnd: last.date,
    throughDate: last.date,
    inProgress,
    asOf: now.toISOString(),
    sessions: cur.bars,
    netVolume: signed,
    totalVolume: cur.volume,
    netFlag: null,
    open: last.open,
    previousClose: prevBar.close,
    close: last.close,
    kind,
    netSign: cur.direction === "up" ? 1 : -1,
    agreement: polarity === 0 ? "disagree" : "agree",
    wwv: { direction: cur.direction, waveVolume: cur.volume, waveBars: cur.bars, waveStart: cur.startDate, previous, previousNote, barDate: last.date, inProgress },
  };
}
