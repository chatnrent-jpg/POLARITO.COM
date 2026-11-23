/**
 * Long-timeframe polarity for the SPY options design: month, quarter, six-month and year, period to date.
 * NO daily and NO weekly reading exists in this module, and there is exactly ONE way to compute net volume: the
 * chart definition (TradingView's Net Volume on the period's own timeframe), verified against Henry's chart
 * (SPY monthly, 20 Nov 2026: chart -957,839,594 vs -957,406,100 computed here from daily volume, 0.05% apart).
 *
 * WHAT A READING IS (the definition, one plain paragraph):
 *   For the current period so far (this month, quarter, half-year or year to date) there are two things:
 *   - the CANDLE COLOUR: green if the latest close is above the period's first open, red if below, flat if equal;
 *   - the NET VOLUME, ONE number: the SUM OF DAILY VOLUME over the period to date (consolidated SIP volume), signed
 *     by the latest close versus the PREVIOUS PERIOD'S LAST CLOSE: +total if the close is above it, -total if below.
 *   The two must ALIGN for the reading to count:
 *     green candle AND positive net volume -> +1 Drive
 *     red candle   AND negative net volume -> -1 Reverse
 *     anything else (they disagree, the candle is flat, or net volume is exactly zero or missing) -> 0 Neutral
 *   The reading is re-evaluated whenever the data updates; it can flip. Neutral is a valid reading (the trader decides).
 *
 * EXACT ZERO OR MISSING NET VOLUME is Neutral with an explicit flag (`netFlag` "zero" or "missing"): the sign is
 * never guessed. Net volume is exactly zero when the latest close equals the previous period's last close.
 * The raw signed number is always on the reading (`netVolume`) so it can be compared with the chart.
 *
 * There is no 5-minute code, no daily-signed or candle-approximation variant and no method selector. polarity.ts
 * `validateBars` is reused (not edited).
 *
 * NEVER A GUESS: if the newest daily bar is not the one expected for the current session, any session in the period
 * has no bar (or zero/missing volume), the previous period's last close is not in the loaded history, or any bar is
 * malformed, the reading is "unavailable" (polarity null, "Data unavailable") with the reason. Nothing is decided on
 * it. Unavailable (the data is bad or missing) is different from Neutral (the data is good and the answer is neutral).
 *
 * Each reading carries its inputs side by side (candle colour, open, previous close, close, total volume, net volume,
 * whether they agree, period start, as-of time) so it can be audited. The 6-month period is Jan 1 - Jun 30 and
 * Jul 1 - Dec 31.
 *
 * Pure: no network, no clock (the caller passes `now`), no storage, no orders.
 */
import { periodEnd, periodStart } from "@/lib/periodCandles";
import { expectedLatestSession, etClock, latestPossibleSession, previousTradingDay, sessionInProgress, tradingDaysBetween } from "@/lib/marketCalendar";
import { metaFor, validateBars, type Bar, type CandleKind, type Polarity } from "@/lib/polarity";

export const LONG_TIMEFRAMES = Object.freeze(["M", "Q", "H", "Y"] as const);
export type LongTimeframe = (typeof LONG_TIMEFRAMES)[number];
export const DEFAULT_DECISION_TIMEFRAME: LongTimeframe = "M";

export const LONG_TIMEFRAME_NAMES: Readonly<Record<LongTimeframe, string>> = Object.freeze({
  M: "Monthly",
  Q: "Quarterly",
  H: "6-month",
  Y: "Yearly",
});

export function isLongTimeframe(value: unknown): value is LongTimeframe {
  return typeof value === "string" && (LONG_TIMEFRAMES as readonly string[]).includes(value);
}

/** Anything unknown (including "1D" and "1W") falls back to the default; daily and weekly never exist here. */
export function coerceLongTimeframe(value: unknown): LongTimeframe {
  return isLongTimeframe(value) ? value : DEFAULT_DECISION_TIMEFRAME;
}

export function longPeriodStart(iso: string, tf: LongTimeframe): string {
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  switch (tf) {
    case "M":
      return periodStart(iso, "month");
    case "Q":
      return periodStart(iso, "quarter");
    case "H":
      return `${y}-${m <= 6 ? "01" : "07"}-01`;
    case "Y":
      return periodStart(iso, "year");
  }
}

export function longPeriodEnd(iso: string, tf: LongTimeframe): string {
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  switch (tf) {
    case "M":
      return periodEnd(iso, "month");
    case "Q":
      return periodEnd(iso, "quarter");
    case "H":
      return m <= 6 ? `${y}-06-30` : `${y}-12-31`;
    case "Y":
      return periodEnd(iso, "year");
  }
}

export type LongInput = {
  /**
   * Chronological daily bars (consolidated volume); the newest may be the session in progress. The history must
   * reach back to the last session before the longest period starts (the previous period's last close).
   */
  daily: readonly Bar[];
  now: Date;
};

/** Why the net volume is not a usable signed number: exactly zero, or missing/not finite. Never a guessed sign. */
export type NetFlag = "zero" | "missing";

export type LongReading = {
  timeframe: LongTimeframe;
  status: "ok" | "unavailable";
  /** null when unavailable: no guessed Drive/Reverse. */
  polarity: Polarity | null;
  label: "Drive" | "Neutral" | "Reverse" | "Data unavailable";
  reason: string | null;
  /** Audit inputs. */
  periodStart: string;
  periodEnd: string;
  /** Date of the newest daily bar included. */
  throughDate: string;
  /** True when that newest bar is today's session and it is still open: the reading uses the partial day and can change until the close. */
  inProgress: boolean;
  /** The `now` the reading was evaluated at (ISO). */
  asOf: string;
  sessions: number;
  /** The raw signed net volume to compare with the chart: +/- the period's total volume; null when unavailable or missing. */
  netVolume: number | null;
  /** The period's total volume (sum of daily volume to date); null when unavailable. */
  totalVolume: number | null;
  /** Explicit flag when the net volume is exactly zero or missing (the reading is then Neutral); null otherwise. */
  netFlag: NetFlag | null;
  /** The first open of the period. */
  open: number | null;
  /** The previous period's last close, the reference for the net volume sign. */
  previousClose: number | null;
  /** The latest close. */
  close: number | null;
  /** Candle colour of the period to date: close vs the period's first open. */
  kind: CandleKind | null;
  /** Sign of the net volume alone (before the alignment rule); null when unavailable or missing. */
  netSign: Polarity | null;
  /** Whether candle colour and net volume agree (green+positive or red+negative); null when unavailable. */
  agreement: "agree" | "disagree" | null;
};

export type LongReadings = Readonly<Record<LongTimeframe, LongReading>>;

function candleKind(open: number, close: number): CandleKind {
  return close > open ? "green" : close < open ? "red" : "flat";
}

const polarityOfSign = (n: number): Polarity => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** The alignment rule: green + positive net = Drive (+1), red + negative net = Reverse (-1), anything else Neutral (0). */
export function alignedPolarity(kind: CandleKind, net: number): Polarity {
  if (kind === "green" && net > 0) return 1;
  if (kind === "red" && net < 0) return -1;
  return 0;
}

function unavailable(tf: LongTimeframe, reason: string, throughDate: string, now: Date, extra: Partial<LongReading> = {}): LongReading {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(throughDate) ? throughDate : etClock(now).date;
  return {
    timeframe: tf,
    status: "unavailable",
    polarity: null,
    label: "Data unavailable",
    reason,
    periodStart: longPeriodStart(anchor, tf),
    periodEnd: longPeriodEnd(anchor, tf),
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
    ...extra,
  };
}

function allUnavailable(reason: string, throughDate: string, now: Date): LongReadings {
  const out = {} as Record<LongTimeframe, LongReading>;
  for (const tf of LONG_TIMEFRAMES) out[tf] = unavailable(tf, reason, throughDate, now);
  return out;
}

/**
 * Freshness of the daily series. Null when fine. Only an OLDER bar than the session needed is stale; a bar that is the
 * current session's (including today's in-progress bar, even before the 9:50 ET due time) is accepted; a bar dated after the
 * latest session that can exist right now (tomorrow, a weekend or holiday, today before the open) is future-dated and rejected.
 */
export function dailyStaleReason(daily: readonly Bar[], now: Date): string | null {
  if (daily.length === 0) return "no daily bars";
  const expected = expectedLatestSession(now);
  const latest = latestPossibleSession(now);
  const newest = daily[daily.length - 1].date;
  if (newest < expected) return `the newest daily bar is ${newest} but the current session needs ${expected}`;
  if (newest > latest) return `the newest daily bar is ${newest}, which is dated after the latest session that can exist now (${latest}); future-dated data is rejected`;
  return null;
}

/**
 * The four readings, period to date, as of `now`. Never throws and never guesses: any problem with the data makes
 * the affected reading "unavailable" with the reason.
 */
export function computeLongReadings(input: LongInput): LongReadings {
  const { daily, now } = input;
  const newest = daily.length ? daily[daily.length - 1].date : "";

  try {
    validateBars(daily); // every bar finite, ordered, high >= low, ...
  } catch (e) {
    return allUnavailable(`daily bars rejected: ${e instanceof Error ? e.message : "malformed"}`, newest, now);
  }
  const stale = dailyStaleReason(daily, now);
  if (stale) return allUnavailable(`stale data: ${stale}`, newest, now);

  const out = {} as Record<LongTimeframe, LongReading>;
  for (const tf of LONG_TIMEFRAMES) out[tf] = readOne(tf, input);
  return out;
}

/**
 * The chart's Net Volume for one period: +total when the close is above the previous period's last close, -total when
 * below. An exactly equal close is a zero net volume and a non-finite input is a missing one; both are flagged and
 * neither gets a guessed sign.
 */
export function chartNetVolume(previousClose: number, close: number, totalVolume: number): { net: number | null; flag: NetFlag | null } {
  if (![previousClose, close, totalVolume].every(Number.isFinite)) return { net: null, flag: "missing" };
  if (close > previousClose) return { net: totalVolume, flag: null };
  if (close < previousClose) return { net: -totalVolume, flag: null };
  return { net: 0, flag: "zero" };
}

function readOne(tf: LongTimeframe, input: LongInput): LongReading {
  const { daily, now } = input;
  const last = daily[daily.length - 1];
  const start = longPeriodStart(last.date, tf);
  const end = longPeriodEnd(last.date, tf);
  const fail = (reason: string, extra: Partial<LongReading> = {}) => unavailable(tf, reason, last.date, now, extra);

  let first = daily.length - 1;
  while (first > 0 && daily[first - 1].date >= start) first--;
  const days = daily.slice(first);

  // The previous period's last close must be in the loaded history: it is the reference for the net volume sign.
  const prevDate = previousTradingDay(start);
  const prev = daily.find((d) => d.date === prevDate);
  if (!prev) return fail(daily[0].date > prevDate ? `the loaded history does not reach the previous period's last session (${prevDate})` : `no daily bar for the previous period's last session (${prevDate})`);

  // Every trading session of the period so far must have a daily bar with real volume.
  const have = new Set(days.map((d) => d.date));
  const missing = tradingDaysBetween(start, last.date).filter((d) => !have.has(d));
  if (missing.length > 0) return fail(`incomplete: no daily bar for ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""}`);
  const noVolume = days.find((d) => !(d.volume > 0));
  if (noVolume) return fail(`volume missing or zero on ${noVolume.date}`);

  const open = days[0].open;
  const close = last.close;
  const kind = candleKind(open, close);
  const totalVolume = days.reduce((n, d) => n + d.volume, 0);
  const { net, flag } = chartNetVolume(prev.close, close, totalVolume);
  const polarity: Polarity = net === null ? 0 : alignedPolarity(kind, net);
  return {
    timeframe: tf,
    status: "ok",
    polarity,
    label: metaFor(polarity).label,
    reason: flag === "zero" ? "net volume is exactly zero (close equals the previous period's last close): Neutral" : flag === "missing" ? "net volume is missing: Neutral" : null,
    periodStart: start,
    periodEnd: end,
    throughDate: last.date,
    inProgress: sessionInProgress(last.date, now),
    asOf: now.toISOString(),
    sessions: days.length,
    netVolume: net,
    totalVolume: Number.isFinite(totalVolume) ? totalVolume : null,
    netFlag: flag,
    open,
    previousClose: prev.close,
    close,
    kind,
    netSign: net === null ? null : polarityOfSign(net),
    agreement: polarity === 0 ? "disagree" : "agree",
  };
}

/** Compact text such as "M:D Q:R H:R Y:- (unavailable)" for logs. */
export function readingsSummary(r: LongReadings): string {
  return LONG_TIMEFRAMES.map((tf) => `${tf}:${r[tf].polarity === null ? "-" : metaFor(r[tf].polarity as Polarity).gear}`).join(" ");
}

