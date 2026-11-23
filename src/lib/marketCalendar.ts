/**
 * US equity market calendar helpers (pure): full-day NYSE closures, trading days, and which daily bar must exist "now".
 *
 * Used to reject stale or incomplete data. Only the scheduled full-day closures are known here (New Year's Day,
 * Martin Luther King Jr. Day, Presidents' Day, Good Friday, Memorial Day, Juneteenth, Independence Day, Labor Day,
 * Thanksgiving, Christmas, with the usual weekend observance). An unscheduled closure is not known, so a missing bar
 * that day makes the data look incomplete and the reading becomes "data unavailable": the safe direction.
 */
const pad2 = (n: number): string => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;
const dow = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday

export function addCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** nth (1-based) given weekday (0 = Sunday) of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = dow(iso(year, month, 1));
  return iso(year, month, 1 + ((weekday - first + 7) % 7) + 7 * (n - 1));
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = dow(iso(year, month, last));
  return iso(year, month, last - ((lastDow - weekday + 7) % 7));
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** A fixed-date holiday: Saturday is observed on Friday, Sunday on Monday. */
function observed(year: number, month: number, day: number): string {
  const date = iso(year, month, day);
  const w = dow(date);
  if (w === 6) return addCalendarDays(date, -1);
  if (w === 0) return addCalendarDays(date, 1);
  return date;
}

const cache = new Map<number, Set<string>>();

export function nyseHolidays(year: number): ReadonlySet<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const s = new Set<string>();
  // New Year's Day is not moved to the previous Friday when it falls on a Saturday.
  const ny = iso(year, 1, 1);
  if (dow(ny) !== 6) s.add(dow(ny) === 0 ? iso(year, 1, 2) : ny);
  s.add(nthWeekday(year, 1, 1, 3)); // Martin Luther King Jr. Day
  s.add(nthWeekday(year, 2, 1, 3)); // Presidents' Day
  s.add(addCalendarDays(easterSunday(year), -2)); // Good Friday
  s.add(lastWeekday(year, 5, 1)); // Memorial Day
  if (year >= 2022) s.add(observed(year, 6, 19)); // Juneteenth
  s.add(observed(year, 7, 4));
  s.add(nthWeekday(year, 9, 1, 1)); // Labor Day
  s.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
  s.add(observed(year, 12, 25));
  cache.set(year, s);
  return s;
}

export function isTradingDay(date: string): boolean {
  const w = dow(date);
  if (w === 0 || w === 6) return false;
  return !nyseHolidays(Number(date.slice(0, 4))).has(date);
}

/** Every trading day from `from` to `to`, both inclusive. */
export function tradingDaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addCalendarDays(d, 1)) if (isTradingDay(d)) out.push(d);
  return out;
}

export function previousTradingDay(date: string): string {
  let d = addCalendarDays(date, -1);
  while (!isTradingDay(d)) d = addCalendarDays(d, -1);
  return d;
}

export function etClock(now: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export const MARKET_OPEN_MINUTES = 9 * 60 + 30;
export const MARKET_CLOSE_MINUTES = 16 * 60;

/** Minutes after midnight ET at which today's daily bar must exist (20 minutes after the 9:30 open). */
export const DAILY_BAR_DUE_MINUTES = 9 * 60 + 50;

/**
 * The OLDEST session date the newest daily bar may have right now (anything older is stale):
 * today on a trading day from 9:50 ET on (during the session and after the close), otherwise the previous trading day.
 * Between the 9:30 open and 9:50 the provider may already show today's in-progress bar or may not yet, so either is fine
 * (see latestPossibleSession); the 20 minutes only give it time to appear.
 */
export function expectedLatestSession(now: Date): string {
  const { date, minutes } = etClock(now);
  if (isTradingDay(date) && minutes >= DAILY_BAR_DUE_MINUTES) return date;
  return previousTradingDay(date);
}

/**
 * The NEWEST session date a daily bar can have right now (anything later is future-dated and rejected):
 * today once the 9:30 ET open has passed on a trading day (that bar is the session in progress, then final after 16:00),
 * otherwise the previous trading day (before the open, weekends and holidays have no bar of their own).
 */
export function latestPossibleSession(now: Date): string {
  const { date, minutes } = etClock(now);
  if (isTradingDay(date) && minutes >= MARKET_OPEN_MINUTES) return date;
  return previousTradingDay(date);
}

/** True while `barDate` is today's session and it is still open (9:30 to 16:00 ET): the bar's close is the last price and can still change. */
export function sessionInProgress(barDate: string, now: Date): boolean {
  const { date, minutes } = etClock(now);
  return barDate === date && isTradingDay(date) && minutes >= MARKET_OPEN_MINUTES && minutes < MARKET_CLOSE_MINUTES;
}
