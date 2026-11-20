/**
 * Daily account loss stop for OPTIONS mode only.
 *
 * Deliberately its own value: the shared `DEFAULT_RISK_CONFIG.dailyLossLimitPct`
 * (2%) feeds the browser sim / ledger risk rails and must not move with this.
 * Mirror mode has its own `POLARITO_MIRROR_DAILY_LOSS_PCT`.
 *
 * Fail-safe: a missing, malformed or out-of-range env value falls back to the
 * 1% default. A stop must never be switched off by a typo.
 */
export const DEFAULT_OPTIONS_DAILY_LOSS_PCT = 1;
export const MIN_OPTIONS_DAILY_LOSS_PCT = 0.25;
export const MAX_OPTIONS_DAILY_LOSS_PCT = 10;

/** The options loss stop as a fraction of last-close equity (1 => 0.01). */
export function optionsDailyLossLimit(env: Readonly<Record<string, string | undefined>> = {}): number {
  const raw = (env.POLARITO_OPTIONS_DAILY_LOSS_PCT ?? "").trim();
  const pct = raw === "" ? DEFAULT_OPTIONS_DAILY_LOSS_PCT : Number(raw);
  const valid = Number.isFinite(pct) && pct >= MIN_OPTIONS_DAILY_LOSS_PCT && pct <= MAX_OPTIONS_DAILY_LOSS_PCT;
  return (valid ? pct : DEFAULT_OPTIONS_DAILY_LOSS_PCT) / 100;
}

/** 0.01 => "1" (for log messages). */
export function lossPctText(limit: number): string {
  return String(Number((limit * 100).toFixed(2)));
}
