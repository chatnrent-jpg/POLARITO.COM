/**
 * Long-timeframe polarity for the SPY options design: month, quarter, six-month and year, period to date.
 * NO daily and NO weekly reading exists in this module.
 *
 * WHAT A READING IS (one plain sentence):
 *   For the current period so far (this month, quarter, half-year or year to date), the net volume is ONE number:
 *   the volume that traded while price was rising minus the volume that traded while price was falling, added up over
 *   the whole period from the finest bars available (5-minute bars; daily bars if 5-minute are not used); the reading
 *   is +1 Drive if that number is positive, -1 Reverse if it is negative, and it updates whenever the data does.
 *
 * Methods (`NetVolumeMethod`), all one value per period:
 *   "signed-intraday" (recommended): sum over the period's 5-minute bars of +volume (close > open) or -volume
 *      (close < open); the reading is the sign of that sum.
 *   "signed-daily": sum over the period's daily bars of the repo's own daily netVolume (green day +volume, red day
 *      -volume, flat day close-location x volume); the reading is the sign of that sum.
 *   "candle": the repo's chart rule (chartBuckets.periodBucketsFor): the period-to-date candle's colour (close vs the
 *      period's open) gives +total volume or -total volume, then the engine's gate against a noise floor (sum of the
 *      days' floors). Size of the move is ignored; kept only so the old definition can be compared and audited.
 * The two signed methods have no noise band: a positive sum is Drive, a negative sum is Reverse, exactly zero is
 * Neutral. polarity.ts is reused (netVolume, gate, computePolaritySeries, validateBars) and not edited.
 *
 * NEVER A GUESS: if the newest daily bar is not the one expected for the current session, any session in the period
 * has no bar (or zero/missing volume), the period starts before the loaded history, intraday coverage is incomplete or
 * stale, or the bars are malformed, the reading is "unavailable" (polarity null) with the reason. Nothing is decided on it.
 *
 * Each reading carries its inputs (period start, net volume, up volume, down volume, as-of time, newest bar) so it can
 * be audited. The 6-month period is Jan 1 - Jun 30 and Jul 1 - Dec 31 (polarity.ts / chartBuckets.ts have no 6-month view).
 *
 * Pure: no network, no clock (the caller passes `now`), no storage, no orders.
 */
import { COVERAGE_SLACK_DAYS, addDays, periodEnd, periodStart } from "@/lib/periodCandles";
import { expectedLatestSession, etClock, tradingDaysBetween } from "@/lib/marketCalendar";
import { computePolaritySeries, gate, metaFor, netVolume, type Bar, type CandleKind, type Polarity } from "@/lib/polarity";

export const LONG_TIMEFRAMES = Object.freeze(["M", "Q", "H", "Y"] as const);
export type LongTimeframe = (typeof LONG_TIMEFRAMES)[number];
export const DEFAULT_DECISION_TIMEFRAME: LongTimeframe = "M";

export const LONG_TIMEFRAME_NAMES: Readonly<Record<LongTimeframe, string>> = Object.freeze({
  M: "Monthly",
  Q: "Quarterly",
  H: "6-month",
  Y: "Yearly",
});

export const NET_VOLUME_METHODS = Object.freeze(["signed-intraday", "signed-daily", "candle"] as const);
export type NetVolumeMethod = (typeof NET_VOLUME_METHODS)[number];
export const DEFAULT_NET_VOLUME_METHOD: NetVolumeMethod = "signed-intraday";

export function isLongTimeframe(value: unknown): value is LongTimeframe {
  return typeof value === "string" && (LONG_TIMEFRAMES as readonly string[]).includes(value);
}

/** Anything unknown (including "1D" and "1W") falls back to the default; daily and weekly never exist here. */
export function coerceLongTimeframe(value: unknown): LongTimeframe {
  return isLongTimeframe(value) ? value : DEFAULT_DECISION_TIMEFRAME;
}

export function isNetVolumeMethod(value: unknown): value is NetVolumeMethod {
  return typeof value === "string" && (NET_VOLUME_METHODS as readonly string[]).includes(value);
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

/** One intraday (5-minute) bar. `t` is the bar's start as an ISO UTC timestamp, `date` its New York session date. */
export type IntradayBar = { t: string; date: string; open: number; close: number; volume: number };

export type LongInput = {
  /** Chronological daily bars; the newest may be the session in progress. */
  daily: readonly Bar[];
  /** 5-minute bars covering at least the longest period to date; required only for "signed-intraday". */
  intraday?: readonly IntradayBar[];
  now: Date;
  method?: NetVolumeMethod;
  /** Allowed gap between the sum of a day's 5-minute volume and its daily-bar volume (0.1 = 10%). */
  intradayTolerance?: number;
  /** During the session the newest 5-minute bar must start within this many minutes of now. */
  maxIntradayLagMinutes?: number;
};

export type LongReading = {
  timeframe: LongTimeframe;
  method: NetVolumeMethod;
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
  /** The `now` the reading was evaluated at (ISO). */
  asOf: string;
  /** Start of the newest intraday bar included (signed-intraday only). */
  lastBarAt: string | null;
  sessions: number;
  netVolume: number | null;
  upVolume: number | null;
  downVolume: number | null;
  /** Candle method only (the signed methods have no noise band). */
  noiseFloor: number | null;
  open: number | null;
  close: number | null;
  kind: CandleKind | null;
  /** Candle method only: the price at which the reading flips (the period's open). */
  flipPrice: number | null;
};

export type LongReadings = Readonly<Record<LongTimeframe, LongReading>>;

function candleKind(open: number, close: number): CandleKind {
  return close > open ? "green" : close < open ? "red" : "flat";
}

const polarityOfSign = (n: number): Polarity => (n > 0 ? 1 : n < 0 ? -1 : 0);

function unavailable(tf: LongTimeframe, method: NetVolumeMethod, reason: string, throughDate: string, now: Date, extra: Partial<LongReading> = {}): LongReading {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(throughDate) ? throughDate : etClock(now).date;
  return {
    timeframe: tf,
    method,
    status: "unavailable",
    polarity: null,
    label: "Data unavailable",
    reason,
    periodStart: longPeriodStart(anchor, tf),
    periodEnd: longPeriodEnd(anchor, tf),
    throughDate,
    asOf: now.toISOString(),
    lastBarAt: null,
    sessions: 0,
    netVolume: null,
    upVolume: null,
    downVolume: null,
    noiseFloor: null,
    open: null,
    close: null,
    kind: null,
    flipPrice: null,
    ...extra,
  };
}

function allUnavailable(method: NetVolumeMethod, reason: string, throughDate: string, now: Date): LongReadings {
  const out = {} as Record<LongTimeframe, LongReading>;
  for (const tf of LONG_TIMEFRAMES) out[tf] = unavailable(tf, method, reason, throughDate, now);
  return out;
}

/** Freshness of the daily series: the newest bar must be the one expected for the current session. Null when fine. */
export function dailyStaleReason(daily: readonly Bar[], now: Date): string | null {
  if (daily.length === 0) return "no daily bars";
  const expected = expectedLatestSession(now);
  const newest = daily[daily.length - 1].date;
  if (newest !== expected) return `the newest daily bar is ${newest} but the current session needs ${expected}`;
  return null;
}

/**
 * The four readings, period to date, as of `now`. Never throws and never guesses: any problem with the data makes
 * the affected reading "unavailable" with the reason.
 */
export function computeLongReadings(input: LongInput): LongReadings {
  const method = input.method ?? DEFAULT_NET_VOLUME_METHOD;
  const { daily, now } = input;
  const newest = daily.length ? daily[daily.length - 1].date : "";

  if (!isNetVolumeMethod(method)) return allUnavailable(DEFAULT_NET_VOLUME_METHOD, `unknown net volume method "${String(method)}"`, newest, now);
  let series;
  try {
    series = computePolaritySeries(daily); // validates every bar (finite, ordered, high >= low, ...)
  } catch (e) {
    return allUnavailable(method, `daily bars rejected: ${e instanceof Error ? e.message : "malformed"}`, newest, now);
  }
  const stale = dailyStaleReason(daily, now);
  if (stale) return allUnavailable(method, `stale data: ${stale}`, newest, now);

  const out = {} as Record<LongTimeframe, LongReading>;
  for (const tf of LONG_TIMEFRAMES) out[tf] = readOne(tf, method, input, series.map((r) => r.noiseFloor));
  return out;
}

function readOne(tf: LongTimeframe, method: NetVolumeMethod, input: LongInput, dayFloors: ReadonlyArray<number | null>): LongReading {
  const { daily, now } = input;
  const last = daily[daily.length - 1];
  const start = longPeriodStart(last.date, tf);
  const end = longPeriodEnd(last.date, tf);
  const fail = (reason: string, extra: Partial<LongReading> = {}) => unavailable(tf, method, reason, last.date, now, extra);

  let first = daily.length - 1;
  while (first > 0 && daily[first - 1].date >= start) first--;
  const days = daily.slice(first);

  if (daily[0].date > addDays(start, COVERAGE_SLACK_DAYS)) return fail("the loaded history does not reach the start of the period");

  // Every trading session of the period so far must have a daily bar with real volume.
  const have = new Set(days.map((d) => d.date));
  const missing = tradingDaysBetween(start, last.date).filter((d) => !have.has(d));
  if (missing.length > 0) return fail(`incomplete: no daily bar for ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""}`);
  const noVolume = days.find((d) => !(d.volume > 0));
  if (noVolume) return fail(`volume missing or zero on ${noVolume.date}`);

  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const d of days) {
    if (d.high > high) high = d.high;
    if (d.low < low) low = d.low;
    volume += d.volume;
  }
  const open = days[0].open;
  const close = last.close;
  const base: Partial<LongReading> = { sessions: days.length, open, close, kind: candleKind(open, close) };
  const ok = (polarity: Polarity, net: number, up: number, down: number, extra: Partial<LongReading> = {}): LongReading => ({
    timeframe: tf,
    method,
    status: "ok",
    polarity,
    label: metaFor(polarity).label,
    reason: null,
    periodStart: start,
    periodEnd: end,
    throughDate: last.date,
    asOf: now.toISOString(),
    lastBarAt: null,
    sessions: days.length,
    netVolume: net,
    upVolume: up,
    downVolume: down,
    noiseFloor: null,
    open,
    close,
    kind: candleKind(open, close),
    flipPrice: null,
    ...extra,
  });

  if (method === "candle") {
    // The old chart rule needs each day's floor (20 bars of history) and complete history before the period.
    const floors = dayFloors.slice(first);
    if (floors.some((f) => f === null)) return fail("a day in the period has fewer than 20 bars of history, so there is no noise floor", base);
    const noiseFloor = floors.reduce<number>((s, f) => s + (f as number), 0);
    const net = netVolume({ date: last.date, open, high, low, close, volume });
    return ok(gate(net, noiseFloor), net, net > 0 ? volume : 0, net < 0 ? volume : 0, { noiseFloor, flipPrice: open });
  }

  if (method === "signed-daily") {
    let up = 0;
    let down = 0;
    for (const d of days) {
      const n = netVolume(d);
      if (n > 0) up += n;
      else if (n < 0) down += -n;
    }
    const net = up - down;
    return ok(polarityOfSign(net), net, up, down);
  }

  // signed-intraday
  const bars = (input.intraday ?? []).filter((b) => b.date >= start && b.date <= last.date);
  if (bars.length === 0) return fail("no 5-minute bars for the period", base);
  const tol = input.intradayTolerance ?? 0.1;
  const byDay = new Map<string, number>();
  let up = 0;
  let down = 0;
  let newestAt = "";
  for (const b of bars) {
    if (![b.open, b.close, b.volume].every(Number.isFinite) || b.volume < 0 || !Number.isFinite(Date.parse(b.t))) return fail(`malformed 5-minute bar at ${b.t}`, base);
    if (b.close > b.open) up += b.volume;
    else if (b.close < b.open) down += b.volume;
    byDay.set(b.date, (byDay.get(b.date) ?? 0) + b.volume);
    if (b.t > newestAt) newestAt = b.t;
  }
  for (const d of days) {
    const got = byDay.get(d.date);
    if (got === undefined) return fail(`incomplete: no 5-minute bars on ${d.date}`, base);
    if (d.date !== last.date) {
      const ratio = got / d.volume;
      if (!(Math.abs(ratio - 1) <= tol)) return fail(`5-minute volume on ${d.date} is ${(ratio * 100).toFixed(0)}% of the daily volume (allowed ${((1 - tol) * 100).toFixed(0)}-${((1 + tol) * 100).toFixed(0)}%)`, base);
    }
  }
  const lag = input.maxIntradayLagMinutes ?? 20;
  const nowEt = etClock(now);
  const inSession = nowEt.date === last.date && nowEt.minutes >= 9 * 60 + 30 && nowEt.minutes < 16 * 60;
  if (inSession && (now.getTime() - Date.parse(newestAt)) / 60_000 > lag) return fail(`the newest 5-minute bar (${newestAt}) is more than ${lag} minutes old during the session`, base);
  if (!inSession && etClock(new Date(Date.parse(newestAt))).date !== last.date) return fail(`the newest 5-minute bar (${newestAt}) is not from ${last.date}`, base);
  const net = up - down;
  return ok(polarityOfSign(net), net, up, down, { lastBarAt: newestAt });
}

/** Compact text such as "M:D Q:R H:R Y:- (unavailable)" for logs. */
export function readingsSummary(r: LongReadings): string {
  return LONG_TIMEFRAMES.map((tf) => `${tf}:${r[tf].polarity === null ? "-" : metaFor(r[tf].polarity as Polarity).gear}`).join(" ");
}

