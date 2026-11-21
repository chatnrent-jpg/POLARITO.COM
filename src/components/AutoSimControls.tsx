"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { useLiveMode } from "@/components/LiveModeProvider";
import {
  getAutoSimPrefs,
  getServerAutoSimPrefs,
  setAutoSimEnabled,
  setAutoSimQuantity,
  subscribeAutoSimPrefs,
  type AutoSimPrefsResult,
} from "@/lib/autoSimPrefs";

const labelCls = "text-sm font-semibold uppercase tracking-wide text-slate-300";
const fieldCls =
  "h-12 w-full rounded-lg bg-zinc-950 px-4 text-lg font-semibold text-white ring-1 ring-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Auto on/off and how many shares. Nothing else: the position follows the
 * polarity (+1 long, 0 flat, -1 short).
 */
export default function AutoSimControls({ lastAction }: { lastAction: string | null }) {
  const prefs = useSyncExternalStore(
    subscribeAutoSimPrefs,
    getAutoSimPrefs,
    getServerAutoSimPrefs,
  );
  // null = show the stored value; string = the user is editing.
  const [qtyEdit, setQtyEdit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qtyDraft = qtyEdit ?? String(prefs.quantity);
  const { mode } = useLiveMode();

  function report(result: AutoSimPrefsResult): boolean {
    setError(result.ok ? null : result.error);
    return result.ok;
  }

  function commitQty(raw: string) {
    report(setAutoSimQuantity(raw));
    setQtyEdit(null);
  }

  function onQtySubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    commitQty(qtyDraft);
  }

  // Live is on: this is the browser simulation's control, so it is not shown here; LiveSimNotice carries the footer notice.
  if (mode.kind !== "sim") return null;

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
            +1 = long &nbsp;·&nbsp; 0 = flat &nbsp;·&nbsp; −1 = short. Manual Review / Close still
            work.
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

      <form onSubmit={onQtySubmit} className="flex w-full max-w-sm items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="auto-sim-qty" className={labelCls}>
            Shares
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
          Set
        </button>
      </form>

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
