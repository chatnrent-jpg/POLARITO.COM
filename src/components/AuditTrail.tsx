"use client";

import { useState, useSyncExternalStore } from "react";
import {
  auditToJson,
  clearAudit,
  getAuditSnapshot,
  getServerAuditSnapshot,
  subscribeAudit,
} from "@/lib/auditStore";

const SHOWN = 25;

const OUTCOME_STYLE: Record<string, string> = {
  entered: "text-emerald-300",
  closed: "text-sky-300",
  blocked: "text-amber-300",
  error: "text-red-300",
};

/**
 * Read-only trail of every Auto decision made in this browser, including the
 * decision to do nothing. Export it before clearing; nothing here leaves the
 * browser unless you download it.
 */
export default function AuditTrail() {
  const records = useSyncExternalStore(subscribeAudit, getAuditSnapshot, getServerAuditSnapshot);
  const [error, setError] = useState<string | null>(null);

  function download() {
    try {
      const blob = new Blob([auditToJson(records)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `polarito-audit-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch {
      setError("Could not export the audit trail.");
    }
  }

  function clear() {
    const result = clearAudit();
    setError(result.ok ? null : result.error);
  }

  const recent = records.slice(-SHOWN).reverse();

  return (
    <section
      aria-label="Audit trail"
      className="w-full max-w-5xl rounded-2xl border border-zinc-700 bg-zinc-900/60 p-5 sm:p-6"
    >
      <details>
        <summary className="cursor-pointer text-lg font-bold uppercase tracking-wider text-white">
          Audit trail
          <span className="ml-3 text-sm font-normal normal-case tracking-normal text-slate-400">
            {records.length === 0 ? "no decisions yet" : `${records.length} decisions recorded`}
          </span>
        </summary>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={download}
              disabled={records.length === 0}
              className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download JSON
            </button>
            <button
              type="button"
              onClick={clear}
              disabled={records.length === 0}
              className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-sm font-medium text-red-300">
              {error}
            </p>
          ) : null}

          {recent.length === 0 ? (
            <p className="text-sm text-slate-400">
              Every Auto decision (enter, close, hold, stand aside, blocked) is recorded here with
              its reason. The newest {SHOWN} are shown; up to 500 are kept in this browser.
            </p>
          ) : (
            <ol className="flex flex-col gap-2 text-sm">
              {recent.map((r, i) => (
                <li
                  key={`${r.at}-${i}`}
                  className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-slate-300"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs text-slate-500">
                      {r.at.replace("T", " ").slice(0, 19)}Z
                    </span>
                    <span className="font-mono font-bold text-white">{r.ticker}</span>
                    <span className={`font-semibold uppercase ${OUTCOME_STYLE[r.outcome] ?? "text-slate-200"}`}>
                      {r.outcome}
                    </span>
                    {r.side && r.quantity ? (
                      <span className="text-slate-400">
                        {r.side} {r.quantity.toLocaleString("en-US")}
                        {r.price ? ` @ ${r.price.toFixed(2)}` : ""}
                      </span>
                    ) : null}
                    {r.signalDate ? (
                      <span className="text-xs text-slate-500">signal {r.signalDate}</span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-slate-300">{r.reason}</p>
                  {r.notes.length > 0 ? (
                    <p className="mt-1 text-xs text-slate-500">{r.notes.join(" ")}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>
    </section>
  );
}
