"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import {
  getAutoSimPrefs,
  getServerAutoSimPrefs,
  setAutoSimEnabled,
  setAutoSimQuantity,
  subscribeAutoSimPrefs,
} from "@/lib/autoSimPrefs";

/**
 * Toggle + share size for simulated auto enter/close.
 * Default on: same polarity gate as manual orders; turn off anytime to go fully manual.
 */
export default function AutoSimControls({
  lastAction,
}: {
  lastAction: string | null;
}) {
  const prefs = useSyncExternalStore(
    subscribeAutoSimPrefs,
    getAutoSimPrefs,
    getServerAutoSimPrefs,
  );
  // null = show stored quantity; string = user is editing.
  const [qtyEdit, setQtyEdit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qtyDraft = qtyEdit ?? String(prefs.quantity);

  function onToggle() {
    const result = setAutoSimEnabled(!prefs.enabled);
    setError(result.ok ? null : result.error);
  }

  function commitQty(raw: string): boolean {
    const result = setAutoSimQuantity(raw);
    if (result.ok) {
      setQtyEdit(null);
      setError(null);
      return true;
    }
    setError(result.error);
    setQtyEdit(null);
    return false;
  }

  function onQtySubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    commitQty(qtyDraft);
  }

  return (
    <section
      aria-label="Auto simulation"
      className="flex w-full max-w-5xl flex-col gap-3 rounded-2xl border border-zinc-700 bg-zinc-900/60 p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold uppercase tracking-wider text-white">
            Auto · Simulated
          </h2>
          <p className="text-sm text-slate-400">
            When on, enters and closes the analyzed ticker using the same polarity gate as manual
            orders (Drive = long, Reverse = short, Neutral = flat). Fills stay at the last daily
            close. Manual Review / Close still work.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={prefs.enabled}
          onClick={onToggle}
          className={`h-14 min-w-[9rem] rounded-xl px-5 text-lg font-black uppercase tracking-wider focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-400 ${
            prefs.enabled
              ? "bg-green-500 text-zinc-950 hover:bg-green-400"
              : "bg-zinc-800 text-zinc-300 ring-2 ring-zinc-600 hover:ring-white"
          }`}
        >
          {prefs.enabled ? "Auto on" : "Auto off"}
        </button>
      </div>

      <form onSubmit={onQtySubmit} className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
          <label
            htmlFor="auto-sim-qty"
            className="text-sm font-semibold uppercase tracking-wide text-slate-300"
          >
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
            onBlur={() => {
              if (qtyEdit === null) return;
              if (qtyEdit.trim() === String(prefs.quantity)) {
                setQtyEdit(null);
                return;
              }
              commitQty(qtyEdit);
            }}
            disabled={!prefs.enabled}
            className="h-12 w-full rounded-lg bg-zinc-950 px-4 font-mono text-lg font-semibold text-white ring-1 ring-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50"
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
