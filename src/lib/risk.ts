/**
 * Risk engine (pure, no I/O). Temperance: risk is sized BEFORE entry, size
 * shrinks on losing streaks, and hard daily loss / profit boundaries halt NEW
 * entries. Closing an existing position is never blocked by risk limits.
 *
 * Equity basis is conservative: starting cash + REALIZED P&L (open positions
 * are not marked), so an unrealized gain can never inflate a size.
 */
import type { ClosedTrade } from "@/lib/ledger";

export const MAX_SHARES = 100_000;

export type RiskConfig = {
  /** Fraction of equity risked per trade in "risk" sizing (0.005 = 0.5%). */
  riskPerTradePct: number;
  /** Assumed protective-stop distance as a fraction of price (0.03 = 3%). */
  stopDistancePct: number;
  /** Max notional of one position as a fraction of equity. */
  maxPositionPct: number;
  /** Max total reserved notional across positions, fraction of equity. */
  maxExposurePct: number;
  /** New entries halt once realized P&L for the day <= -this * start-of-day equity. */
  dailyLossLimitPct: number;
  /** New entries halt once realized P&L for the day >= this * start-of-day equity. */
  dailyProfitLockPct: number;
  /** Consecutive losses before size scales down. */
  streakScaleStart: number;
  /** Multiplier applied once per loss at/after streakScaleStart. */
  streakScaleFactor: number;
  /** Floor for the streak multiplier. */
  streakMinMultiplier: number;
};

export const DEFAULT_RISK_CONFIG: Readonly<RiskConfig> = Object.freeze({
  riskPerTradePct: 0.005,
  stopDistancePct: 0.03,
  maxPositionPct: 0.25,
  maxExposurePct: 1,
  dailyLossLimitPct: 0.02,
  dailyProfitLockPct: 0.04,
  streakScaleStart: 2,
  streakScaleFactor: 0.5,
  streakMinMultiplier: 0.125,
});

export type HaltReason = "daily-loss" | "daily-profit";

export type Sizing =
  | { mode: "fixed"; quantity: number }
  | { mode: "risk"; riskPct: number };

export type EntryAssessment = {
  allowed: boolean;
  quantity: number;
  halted: HaltReason | null;
  streak: number;
  multiplier: number;
  /** Human-readable reason an entry was blocked, or null when allowed. */
  reason: string | null;
  /** Non-blocking notes (e.g. size clipped by a cap). */
  notes: string[];
};

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function resolveConfig(partial?: Partial<RiskConfig>): RiskConfig {
  const cfg = { ...DEFAULT_RISK_CONFIG, ...(partial ?? {}) };
  for (const [k, v] of Object.entries(cfg)) {
    if (!isFiniteNum(v) || v < 0) {
      throw new RangeError(`Invalid risk config value for ${k}.`);
    }
  }
  if (cfg.stopDistancePct <= 0) throw new RangeError("stopDistancePct must be > 0.");
  if (cfg.streakScaleFactor > 1) throw new RangeError("streakScaleFactor must be <= 1.");
  return cfg;
}

/** Trailing run of losing closed trades (a breakeven or win ends the streak). */
export function consecutiveLosses(closed: readonly Pick<ClosedTrade, "realizedPnl">[]): number {
  let n = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (closed[i].realizedPnl < 0) n += 1;
    else break;
  }
  return n;
}

export function streakMultiplier(streak: number, cfg: RiskConfig): number {
  if (streak < cfg.streakScaleStart) return 1;
  const steps = streak - cfg.streakScaleStart + 1;
  return Math.max(cfg.streakMinMultiplier, Math.pow(cfg.streakScaleFactor, steps));
}

export type DayRisk = {
  day: string;
  startEquity: number;
  realizedToday: number;
  halted: HaltReason | null;
};

/** Daily boundaries, keyed by the session date of each closed trade's exit. */
export function dayRisk(
  closed: readonly Pick<ClosedTrade, "realizedPnl" | "exitDate">[],
  startingCash: number,
  day: string,
  cfg: RiskConfig,
): DayRisk {
  let before = 0;
  let today = 0;
  for (const t of closed) {
    if (t.exitDate < day) before += t.realizedPnl;
    else if (t.exitDate === day) today += t.realizedPnl;
  }
  const startEquity = startingCash + before;
  let halted: HaltReason | null = null;
  if (startEquity > 0) {
    if (cfg.dailyLossLimitPct > 0 && today <= -cfg.dailyLossLimitPct * startEquity) {
      halted = "daily-loss";
    } else if (cfg.dailyProfitLockPct > 0 && today >= cfg.dailyProfitLockPct * startEquity) {
      halted = "daily-profit";
    }
  }
  return { day, startEquity, realizedToday: today, halted };
}

export type AssessInput = {
  closed: readonly Pick<ClosedTrade, "realizedPnl" | "exitDate">[];
  startingCash: number;
  /** Notional currently reserved by open positions. */
  reservedNotional: number;
  /** Cash available for a new position. */
  cashAvailable: number;
  /** Effective entry price (after slippage). */
  price: number;
  /** Session date of the fill, YYYY-MM-DD. */
  day: string;
  sizing: Sizing;
  config?: Partial<RiskConfig>;
};

const blocked = (
  reason: string,
  extra: Partial<EntryAssessment> = {},
): EntryAssessment => ({
  allowed: false,
  quantity: 0,
  halted: null,
  streak: 0,
  multiplier: 1,
  reason,
  notes: [],
  ...extra,
});

/**
 * Decide whether a NEW entry is allowed and how many shares. Never throws on
 * bad inputs: malformed numbers produce a blocked assessment (Justice).
 */
export function assessEntry(input: AssessInput): EntryAssessment {
  let cfg: RiskConfig;
  try {
    cfg = resolveConfig(input.config);
  } catch (e) {
    return blocked(e instanceof Error ? e.message : "Invalid risk config.");
  }
  const { price, startingCash, cashAvailable, reservedNotional } = input;
  if (![price, startingCash, cashAvailable, reservedNotional].every(isFiniteNum) || price <= 0) {
    return blocked("Risk inputs are not usable.");
  }

  const day = dayRisk(input.closed, startingCash, input.day, cfg);
  if (day.halted) {
    const pct = (day.realizedToday / day.startEquity) * 100;
    return blocked(
      day.halted === "daily-loss"
        ? `Daily loss limit reached (${pct.toFixed(2)}% today). No new entries until the next session.`
        : `Daily profit lock reached (+${pct.toFixed(2)}% today). No new entries until the next session.`,
      { halted: day.halted },
    );
  }

  const equity = startingCash + input.closed.reduce((s, t) => s + t.realizedPnl, 0);
  if (!(equity > 0)) return blocked("Account equity is not positive.");

  const notes: string[] = [];
  let base: number;
  if (input.sizing.mode === "fixed") {
    base = input.sizing.quantity;
  } else {
    const riskPct = input.sizing.riskPct;
    if (!isFiniteNum(riskPct) || riskPct <= 0) return blocked("Risk percent is not usable.");
    base = Math.floor((equity * riskPct) / (price * cfg.stopDistancePct));
  }
  if (!Number.isSafeInteger(base) || base < 1) {
    return blocked("Computed size is below 1 share.");
  }

  const streak = consecutiveLosses(input.closed);
  const multiplier = streakMultiplier(streak, cfg);
  let qty = base;
  if (multiplier < 1) {
    qty = Math.max(1, Math.floor(base * multiplier));
    notes.push(`Size scaled to ${(multiplier * 100).toFixed(1)}% after ${streak} straight losses.`);
  }

  const caps: Array<[string, number]> = [
    ["per-position cap", Math.floor((equity * cfg.maxPositionPct) / price)],
    ["total exposure cap", Math.floor(Math.max(0, equity * cfg.maxExposurePct - reservedNotional) / price)],
    ["available cash", Math.floor(Math.max(0, cashAvailable) / price)],
    ["max shares", MAX_SHARES],
  ];
  for (const [label, limit] of caps) {
    if (limit < qty) {
      if (limit < 1) {
        return blocked(`Entry blocked: ${label} leaves room for less than 1 share.`, {
          streak,
          multiplier,
          notes,
        });
      }
      notes.push(`Size reduced to ${limit.toLocaleString("en-US")} by ${label}.`);
      qty = limit;
    }
  }

  return { allowed: true, quantity: qty, halted: null, streak, multiplier, reason: null, notes };
}
