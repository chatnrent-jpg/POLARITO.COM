/**
 * Pure helpers for the live pick (up to LIVE_LIMITS.maxPositions stocks at a time). No I/O. The polarity
 * engine is only READ here: a stock's reading is the latest DayResult the
 * engine already produced; nothing is recomputed or filtered.
 *
 * Rank score = |netVolume| / noiseFloor of the latest bar, i.e. how far the
 * volume-weighted candle sits outside the Neutral band (Neutral scores 0).
 *
 * GOOGL and GOOG are one company: they are collapsed into a single candidate
 * before ranking (best score of the two), the more liquid share class is tried
 * first and the other class second, and one day only ever trades one of them.
 */
import { effectiveFillPrice } from "@/lib/fillModel";
import type { Bar, DayResult, Polarity } from "@/lib/polarity";
import { assessEntry } from "@/lib/risk";

/** Tickers that are the same company. Keep short; ties inside a group are decided by liquidity. */
export const COMPANY_GROUPS: readonly (readonly string[])[] = [["GOOGL", "GOOG"]];

/** GOOGL and GOOG share one key; every other ticker is its own company. */
export const companyKey = (ticker: string): string => COMPANY_GROUPS.find((g) => g.includes(ticker))?.[0] ?? ticker;

export type Reading = {
  ticker: string;
  polarity: Polarity;
  ready: boolean;
  /** |netVolume| / noiseFloor of the latest bar; 0 when Neutral or not ready. */
  score: number;
  /** Mean of volume x close over the latest 20 bars. */
  dollarVolume20: number;
  /** Latest close: the price an entry is sized against. */
  price: number;
  /** Date of the latest bar. */
  barDate: string;
};

export function readingScore(latest: DayResult): number {
  if (!latest.ready || latest.polarity === 0) return 0;
  if (latest.noiseFloor === null || !(latest.noiseFloor > 0)) return 0;
  const s = Math.abs(latest.netVolume) / latest.noiseFloor;
  return Number.isFinite(s) ? s : 0;
}

export function dollarVolume20(bars: readonly Bar[]): number {
  const last = bars.slice(-20);
  if (last.length === 0) return 0;
  const sum = last.reduce((s, b) => s + b.volume * b.close, 0);
  return Number.isFinite(sum) ? sum / last.length : 0;
}

export function toReading(ticker: string, bars: readonly Bar[], results: readonly DayResult[]): Reading {
  const latest = results[results.length - 1];
  return {
    ticker,
    polarity: latest.polarity,
    ready: latest.ready,
    score: readingScore(latest),
    dollarVolume20: dollarVolume20(bars),
    price: latest.close,
    barDate: latest.date,
  };
}

export type RankedCandidate = {
  /** The company's key: its first member's ticker. */
  key: string;
  /** Best member score. */
  score: number;
  /** Share classes in the order to try them (one entry for an ordinary stock). */
  members: Reading[];
};

const byLiquidityThenName = (a: Reading, b: Reading): number =>
  b.dollarVolume20 - a.dollarVolume20 || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0);

const shown = (n: number) => Math.round(n * 100) / 100;

/** Collapse company groups, then rank by score (to 2 decimals), then liquidity, then name. */
export function rankCandidates(readings: readonly Reading[]): RankedCandidate[] {
  const grouped = new Set<string>();
  const out: RankedCandidate[] = [];
  for (const group of COMPANY_GROUPS) {
    const members = readings.filter((r) => group.includes(r.ticker)).sort(byLiquidityThenName);
    if (members.length === 0) continue;
    members.forEach((m) => grouped.add(m.ticker));
    out.push({ key: members[0].ticker, score: Math.max(...members.map((m) => m.score)), members });
  }
  for (const r of readings) {
    if (!grouped.has(r.ticker)) out.push({ key: r.ticker, score: r.score, members: [r] });
  }
  return out.sort(
    (a, b) =>
      shown(b.score) - shown(a.score) ||
      b.members[0].dollarVolume20 - a.members[0].dollarVolume20 ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

export type SizeArgs = {
  price: number;
  equity: number;
  lastEquity: number;
  cash: number;
  buyingPower: number;
  /** Notional of stock positions already open. */
  reservedNotional: number;
  today: string;
  quantity: number;
  /** Per-position cap, percent of equity. */
  maxPositionPct: number;
  /** Daily account stop, percent. */
  dailyLossPct: number;
};

/** Shares an entry may take under the live cap, cash and the daily boundaries. quantity 0 => blocked with a reason. */
export function sizeLiveEntry(a: SizeArgs, side: "long" | "short"): { quantity: number; reason: string | null; notes: string[] } {
  let price: number;
  try {
    price = effectiveFillPrice("enter", side, a.price);
  } catch (e) {
    return { quantity: 0, reason: e instanceof Error ? e.message : "Unusable price.", notes: [] };
  }
  const capNotional = (a.equity * a.maxPositionPct) / 100;
  if (Number.isFinite(capNotional) && Number.isFinite(price) && price > 0 && Math.floor(capNotional / price) < 1) {
    const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return {
      quantity: 0,
      reason: `rounds to zero shares: one share costs ${dollars(price)} but the per-position cap is ${dollars(capNotional)} (${a.maxPositionPct}% of ${dollars(a.equity)}).`,
      notes: [],
    };
  }
  const assessment = assessEntry({
    closed: [{ realizedPnl: a.equity - a.lastEquity, exitDate: a.today }],
    startingCash: a.lastEquity,
    reservedNotional: a.reservedNotional,
    cashAvailable: Math.max(0, Math.min(a.cash, a.buyingPower)),
    price,
    day: a.today,
    sizing: { mode: "fixed", quantity: a.quantity },
    config: { maxPositionPct: a.maxPositionPct / 100, dailyLossLimitPct: a.dailyLossPct / 100 },
  });
  return assessment.allowed
    ? { quantity: assessment.quantity, reason: null, notes: assessment.notes }
    : { quantity: 0, reason: assessment.reason ?? "Entry blocked.", notes: assessment.notes };
}

export type AssetCheck = (ticker: string, side: "long" | "short") => Promise<string | null>;

export type Pick = { reading: Reading; side: "long" | "short"; quantity: number; notes: string[] };

export type WalkResult = {
  pick: Pick | null;
  /** One line per name that was passed over, with the reason. */
  skips: string[];
  /** Set when the long-only fallback says stand aside instead of taking a lower-ranked Drive stock. */
  aside: string | null;
};

export type ReadingCheck =
  | { ok: true; side: "long" | "short" }
  | { ok: false; skip: string; aside?: string };

/**
 * Is one reading tradable right now? Order of checks: bars ready and today's, not Neutral, side allowed,
 * asset flags. Sizing is the caller's next step. `aside` is set when the long-only fallback says to stop
 * the whole walk instead of trading a weaker Drive stock.
 */
export async function checkReading(
  r: Reading,
  ctx: {
    today: string;
    shortBlocked: string | null;
    longOnlyFallback: "aside" | "next";
    checkAsset: AssetCheck;
  },
): Promise<ReadingCheck> {
  if (!r.ready) return { ok: false, skip: "not enough history." };
  if (r.barDate !== ctx.today) return { ok: false, skip: `latest bar (${r.barDate}) is not today (${ctx.today}).` };
  if (r.polarity === 0) return { ok: false, skip: "Neutral (0)." };
  const side = r.polarity === 1 ? "long" : "short";
  if (side === "short" && ctx.shortBlocked) {
    const skip = `Reverse (-1) but ${ctx.shortBlocked}`;
    return ctx.longOnlyFallback === "aside"
      ? { ok: false, skip, aside: `${r.ticker} reads Reverse and ${ctx.shortBlocked} Standing aside rather than trading a weaker Drive stock.` }
      : { ok: false, skip };
  }
  const assetProblem = await ctx.checkAsset(r.ticker, side);
  if (assetProblem) return { ok: false, skip: assetProblem };
  return { ok: true, side };
}

/**
 * Walk the ranked list and take the first eligible candidate. A failing class is followed by the company's
 * other class (once) before the next company.
 */
export async function walkCandidates(
  ranked: readonly RankedCandidate[],
  ctx: {
    today: string;
    /** Why a short is not allowed on this account, or null when it is. */
    shortBlocked: string | null;
    longOnlyFallback: "aside" | "next";
    checkAsset: AssetCheck;
    size: (reading: Reading, side: "long" | "short") => { quantity: number; reason: string | null; notes: string[] };
  },
): Promise<WalkResult> {
  const skips: string[] = [];
  for (const cand of ranked) {
    for (const r of cand.members) {
      const checked = await checkReading(r, ctx);
      if (!checked.ok) {
        skips.push(`${r.ticker}: ${checked.skip}`);
        if (checked.aside) return { pick: null, skips, aside: checked.aside };
        continue;
      }
      const sized = ctx.size(r, checked.side);
      if (sized.quantity < 1) {
        skips.push(`${r.ticker}: ${sized.reason ?? "no room for one share."}`);
        continue;
      }
      return { pick: { reading: r, side: checked.side, quantity: sized.quantity, notes: sized.notes }, skips, aside: null };
    }
  }
  return { pick: null, skips, aside: null };
}
