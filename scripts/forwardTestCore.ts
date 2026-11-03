/**
 * Pure logic for the forward test of the capitulation fade (no IO, fully testable).
 *
 * RULE (frozen; see forward-test/PROTOCOL.md): a "Reverse" session at a 1.5x Noise
 * Floor (red candle on volume > 1.5x the 20-day average) -> buy the NEXT session's
 * open, sell that same session's close. Exactly the rule replicated in
 * reports/capitulation-validation.md.
 */
import { computePolaritySeries, type Bar } from "../src/lib/polarity";

export const RATIO = 1.5;
/** 39-stock validation list + the top-10 SPY holdings used in top10-study (deduplicated). */
export const UNIVERSE = [
  "KO", "PEP", "WMT", "HD", "UNH", "JNJ", "PG", "V", "MA", "BAC", "WFC", "GS", "CVX", "COP",
  "CAT", "DE", "BA", "GE", "INTC", "CSCO", "ORCL", "CRM", "ADBE", "NFLX", "DIS", "NKE", "MCD",
  "SBUX", "COST", "LLY", "PFE", "MRK", "ABBV", "T", "VZ", "QCOM", "TXN", "AVGO", "MU",
  "NVDA", "MSFT", "AAPL", "AMZN", "GOOG", "META", "TSLA", "BRK.B", "JPM",
] as const;
/** Calendar reference only (never a signal). */
export const REFERENCE = "SPY";
/** A session counts as finished (final prints in) after 16:20 ET. */
export const COMPLETE_AFTER_MIN = 16 * 60 + 20;
export const COST_SCENARIOS_BPS = [2, 4, 10] as const; // per side

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
export function etParts(now: Date): { date: string; minutes: number } {
  const p = etFmt.formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: Number(g("hour")) * 60 + Number(g("minute")) };
}

/** Bars whose session is finished. Today's bar is excluded until 16:20 ET (it would be partial). */
export function completedBars(bars: readonly Bar[], now: Date): Bar[] {
  const { date, minutes } = etParts(now);
  return bars.filter((b) => b.date < date || (b.date === date && minutes >= COMPLETE_AFTER_MIN));
}

export type Fire = {
  date: string;
  fires: boolean;
  ready: boolean;
  volume: number;
  avgVolume: number | null;
  volRatio: number | null;
  close: number;
};

/** Evaluate the rule at `date` using ONLY bars up to and including that date (no lookahead). */
export function evaluateAt(bars: readonly Bar[], date: string): Fire | null {
  const i = bars.findIndex((b) => b.date === date);
  if (i < 0) return null;
  const upto = bars.slice(0, i + 1);
  const r = computePolaritySeries(upto, { noiseFloorRatio: RATIO })[i];
  const avg = r.avgVolume;
  return {
    date,
    fires: r.ready && r.polarity === -1,
    ready: r.ready,
    volume: bars[i].volume,
    avgVolume: avg,
    volRatio: avg ? bars[i].volume / avg : null,
    close: bars[i].close,
  };
}

/** A signal is live only if no later session bar exists yet (the entry open has not happened). */
export function isLive(signalDate: string, allBars: readonly Bar[]): boolean {
  return !allBars.some((b) => b.date > signalDate);
}

export type Settled = {
  entry_date: string;
  entry_open: number;
  exit_close: number;
  ret: number;
  universe_oc_mean: number;
  excess: number;
  still_fires: boolean;
  volume_final: number;
};

/**
 * Settle one logged signal: buy the first later session's open, sell its close.
 * `completed` must contain only finished sessions. `universeOc(date)` is the mean
 * open->close return across the universe on that date (the same-day baseline).
 */
export function settleOne(
  signal: { signal_date: string; ticker: string },
  completed: readonly Bar[],
  universeOc: (date: string) => number | null,
): Settled | null {
  const entry = completed.find((b) => b.date > signal.signal_date);
  if (!entry) return null;
  const base = universeOc(entry.date);
  if (base === null) return null;
  const ret = entry.close / entry.open - 1;
  const again = evaluateAt(completed, signal.signal_date);
  return {
    entry_date: entry.date,
    entry_open: entry.open,
    exit_close: entry.close,
    ret,
    universe_oc_mean: base,
    excess: ret - base,
    still_fires: again ? again.fires : false,
    volume_final: again ? again.volume : NaN,
  };
}

/* ---------------- CSV (values never contain commas or newlines) ---------------- */
export function toCsvLine(values: ReadonlyArray<string | number | boolean>): string {
  return values.map((v) => String(v)).join(",");
}
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
  });
}

/* ---------------- summary statistics ---------------- */
export type ResultRow = { entry_date: string; ret: number; excess: number; still_fires: boolean };
export type Summary = {
  n: number;
  days: number;
  meanRet: number;
  meanExcess: number;
  seExcess: number;
  tExcess: number;
  winRate: number;
  stillFiresShare: number;
  net: { bps: number; ret: number; excess: number }[];
};

/** Excess standard error clustered by entry date (same-day signals share the market move). */
export function summarize(rows: readonly ResultRow[]): Summary {
  const n = rows.length;
  if (n === 0) {
    return { n: 0, days: 0, meanRet: NaN, meanExcess: NaN, seExcess: NaN, tExcess: NaN, winRate: NaN, stillFiresShare: NaN, net: [] };
  }
  const meanRet = rows.reduce((s, r) => s + r.ret, 0) / n;
  const meanExcess = rows.reduce((s, r) => s + r.excess, 0) / n;
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.entry_date, (byDay.get(r.entry_date) ?? 0) + (r.excess - meanExcess));
  let ss = 0;
  for (const s of byDay.values()) ss += s * s;
  const seExcess = Math.sqrt(ss) / n;
  return {
    n,
    days: byDay.size,
    meanRet,
    meanExcess,
    seExcess,
    tExcess: seExcess > 0 ? meanExcess / seExcess : NaN,
    winRate: rows.filter((r) => r.ret > 0).length / n,
    stillFiresShare: rows.filter((r) => r.still_fires).length / n,
    net: COST_SCENARIOS_BPS.map((bps) => ({ bps, ret: meanRet - (2 * bps) / 1e4, excess: meanExcess - (2 * bps) / 1e4 })),
  };
}
