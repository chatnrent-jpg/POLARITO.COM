"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import {
  getAutoSimPrefs,
  getServerAutoSimPrefs,
  setAutoSimEnabled,
  setAutoSimFillMode,
  setAutoSimQuantity,
  setAutoSimRiskPct,
  setAutoSimSizingMode,
  subscribeAutoSimPrefs,
  type AutoSimPrefsResult,
} from "@/lib/autoSimPrefs";
import { DEFAULT_FILL_COSTS } from "@/lib/fillModel";
import { DEFAULT_RISK_CONFIG } from "@/lib/risk";

const labelCls = "text-sm font-semibold uppercase tracking-wide text-slate-300";
const fieldCls =
  "h-12 w-full rounded-lg bg-zinc-950 px-4 text-lg font-semibold text-white ring-1 ring-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50";

const pct = (n: number) => `${+(n * 100).toFixed(2)}%`;

/**
 * Auto enter/close settings: on/off, sizing (fixed shares or risk-based),
 * and fill model. Default on; manual Order / Ledger controls keep working.
 */
export default function AutoSimControls({ lastAction }: { lastAction: string | null }) {
  const prefs = useSyncExternalStore(
    subscribeAutoSimPrefs,
    getAutoSimPrefs,
    getServerAutoSimPrefs,
  );
  // null = show the stored value; string = the user is editing.
  const [qtyEdit, setQtyEdit] = useState<string | null>(null);
  const [riskEdit, setRiskEdit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qtyDraft = qtyEdit ?? String(prefs.quantity);
  const riskDraft = riskEdit ?? String(prefs.riskPct);

  function report(result: AutoSimPrefsResult): boolean {
    setError(result.ok ? null : result.error);
    return result.ok;
  }

  function commitQty(raw: string) {
    report(setAutoSimQuantity(raw));
    setQtyEdit(null);
  }

  function commitRisk(raw: string) {
    report(setAutoSimRiskPct(raw));
    setRiskEdit(null);
  }

  function onQtySubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    commitQty(qtyDraft);
  }

  function onRiskSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    commitRisk(riskDraft);
  }

  const riskMode = prefs.sizingMode === "risk";

  return (
    <section
      aria-label="Auto simulation"
      className="flex w-full max-w-5xl flex-col gap-4 rounded-2xl border border-zinc-700 bg-zinc-900/60 p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold uppercase tracking-wider text-white">
            Auto · Simulated
          </h2>
          <p className="text-sm text-slate-400">
            When on, enters and closes the analyzed ticker using the same polarity gate as manual
            orders (Drive = long, Reverse = short, Neutral = flat). Every entry is sized by the
            risk guard below. Manual Review / Close still work.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={prefs.enabled}
          onClick={() => report(setAutoSimEnabled(!prefs.enabled))}
          className={`h-14 min-w-[9rem] rounded-xl px-5 text-lg font-black uppercase tracking-wider focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-400 ${
            prefs.enabled
              ? "bg-green-500 text-zinc-950 hover:bg-green-400"
              : "bg-zinc-800 text-zinc-300 ring-2 ring-zinc-600 hover:ring-white"
          }`}
        >
          {prefs.enabled ? "Auto on" : "Auto off"}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="auto-sim-fill" className={labelCls}>
            Fill model
          </label>
          <select
            id="auto-sim-fill"
            value={prefs.fillMode}
            onChange={(e) => report(setAutoSimFillMode(e.target.value))}
            disabled={!prefs.enabled}
            className={fieldCls}
          >
            <option value="next-open">Next open (realistic)</option>
            <option value="signal-close">Signal-day close (legacy)</option>
          </select>
          <span className="text-xs text-slate-400">
            Next open acts on the last completed bar and fills at the following open, plus slippage.
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="auto-sim-sizing" className={labelCls}>
            Sizing
          </label>
          <select
            id="auto-sim-sizing"
            value={prefs.sizingMode}
            onChange={(e) => report(setAutoSimSizingMode(e.target.value))}
            disabled={!prefs.enabled}
            className={fieldCls}
          >
            <option value="fixed">Fixed shares</option>
            <option value="risk">Risk-based (% of equity)</option>
          </select>
          <span className="text-xs text-slate-400">
            Risk-based sizes so a {pct(DEFAULT_RISK_CONFIG.stopDistancePct)} adverse move loses
            about the risk percent.
          </span>
        </div>

        {riskMode ? (
          <form onSubmit={onRiskSubmit} className="flex items-end gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor="auto-sim-risk" className={labelCls}>
                Risk per trade (% of equity)
              </label>
              <input
                id="auto-sim-risk"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={riskDraft}
                onChange={(e) => {
                  setError(null);
                  setRiskEdit(e.target.value);
                }}
                onBlur={() => riskEdit !== null && commitRisk(riskEdit)}
                disabled={!prefs.enabled}
                className={`${fieldCls} font-mono`}
              />
            </div>
            <button
              type="submit"
              disabled={!prefs.enabled}
              className="h-12 rounded-lg bg-white px-4 text-sm font-bold uppercase tracking-wider text-zinc-950 hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              Set risk
            </button>
          </form>
        ) : (
          <form onSubmit={onQtySubmit} className="flex items-end gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor="auto-sim-qty" className={labelCls}>
                Auto quantity (shares)
              </label>
              <input
                id="auto-sim-qty"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={qtyDraft}
                onChange={(e) => {
                  setError(null);
                  setQtyEdit(e.target.value);
                }}
                onBlur={() => qtyEdit !== null && commitQty(qtyEdit)}
                disabled={!prefs.enabled}
                className={`${fieldCls} font-mono`}
              />
            </div>
            <button
              type="submit"
              disabled={!prefs.enabled}
              className="h-12 rounded-lg bg-white px-4 text-sm font-bold uppercase tracking-wider text-zinc-950 hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              Set size
            </button>
          </form>
        )}
      </div>

      <details className="rounded-xl border border-zinc-700 bg-zinc-950/50 p-3 text-sm text-slate-300">
        <summary className="cursor-pointer font-semibold text-white">Risk guard (always on)</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            New entries halt after a {pct(DEFAULT_RISK_CONFIG.dailyLossLimitPct)} daily realized
            loss, or lock after a {pct(DEFAULT_RISK_CONFIG.dailyProfitLockPct)} daily gain.
          </li>
          <li>
            Size halves after each straight loss from the {DEFAULT_RISK_CONFIG.streakScaleStart}nd
            onward (floor {pct(DEFAULT_RISK_CONFIG.streakMinMultiplier)} of base).
          </li>
          <li>
            One position is capped at {pct(DEFAULT_RISK_CONFIG.maxPositionPct)} of equity, total
            exposure at {pct(DEFAULT_RISK_CONFIG.maxExposurePct)}, and never above available cash.
          </li>
          <li>Closes are never blocked by these limits. Stale or malformed data is never traded.</li>
          <li>
            Fills include {+(DEFAULT_FILL_COSTS.slippageBps / 100).toFixed(2)}% slippage per side.
          </li>
        </ul>
      </details>

      {error && (
        <p
          role="alert"
          className="rounded-xl border-2 border-red-500 bg-red-950/50 p-3 text-base font-semibold text-red-200"
        >
          {error}
        </p>
      )}

      {prefs.enabled && lastAction && (
        <p
          role="status"
          className="rounded-xl border border-zinc-600 bg-zinc-950/60 p-3 text-sm font-medium text-slate-200"
        >
          {lastAction}
        </p>
      )}
    </section>
  );
}
