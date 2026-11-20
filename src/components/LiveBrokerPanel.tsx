"use client";

import { useCallback, useEffect, useState } from "react";

type LivePosition = { ticker: string; side: "long" | "short"; quantity: number; avgEntryPrice: number };
type LiveStatus = {
  ok: boolean;
  live?: boolean;
  enabled?: boolean;
  killed?: boolean;
  configured?: boolean;
  tradingAllowed?: boolean;
  blockedReason?: string;
  error?: string;
  account?: { equity: number; lastEquity: number; cash: number; buyingPower: number };
  positions?: LivePosition[];
  day?: { date: string; entries: number; maxEntries: number | null; lockedTicker: string | null; stoppedToday: boolean };
};
type Notice = { kind: "ok" | "wait" | "error"; text: string };

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const REFRESH_MS = 5_000;

/**
 * The LIVE account, read from Alpaca through /api/broker/live/status (never from the browser ledger).
 * Close sends a real order through /api/broker/live/close; a position is only shown as closed once
 * Alpaca's own position list no longer has it.
 */
export default function LiveBrokerPanel() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/broker/live/status", { cache: "no-store" });
      const data = (await res.json()) as LiveStatus;
      setStatus(data);
      setLoadError(data.ok ? null : (data.error ?? "Live status failed."));
    } catch {
      setLoadError("Could not reach the live status route.");
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  async function close(ticker: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/broker/live/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
        cache: "no-store",
      });
      const data = (await res.json()) as {
        ok: boolean;
        status?: string;
        flat?: boolean | null;
        message?: string;
        error?: string;
      };
      if (!data.ok) {
        setNotice({ kind: "error", text: data.error ?? "The close was refused. The position is still open." });
      } else if (data.status === "observed") {
        setNotice({ kind: "wait", text: data.message ?? "Live trading is off. Nothing was sent." });
      } else if (data.flat === true) {
        setNotice({ kind: "ok", text: `${ticker}: ${data.message ?? "Closed."}` });
      } else {
        setNotice({ kind: "wait", text: data.message ?? "Close accepted; waiting for the fill." });
      }
    } catch {
      setNotice({ kind: "error", text: "Could not reach the server. Nothing is assumed closed; check the position below." });
    } finally {
      setConfirming(null);
      setBusy(false);
      await load();
    }
  }

  const positions = status?.positions ?? [];
  const account = status?.account;
  const dayPnl = account ? account.equity - account.lastEquity : 0;
  const tone = { ok: "text-green-400", wait: "text-amber-300", error: "text-red-400" } as const;

  return (
    <aside
      aria-label="Live account"
      className="fixed bottom-4 right-4 z-50 max-h-[80vh] w-96 overflow-auto rounded-lg border border-red-500/60 bg-zinc-900 p-4 text-sm shadow-xl"
    >
      <h2 className="mb-2 flex items-center justify-between font-semibold text-red-300">
        <span>LIVE account (real cash)</span>
        <span className="text-xs text-zinc-400">
          {status?.killed ? "kill switch on" : status?.enabled ? "orders on" : "observe only"}
        </span>
      </h2>
      {loadError ? <p className="text-red-400">{loadError}</p> : null}
      {account ? (
        <dl className="mb-3 grid grid-cols-2 gap-x-3 gap-y-1">
          <dt className="text-zinc-400">Equity</dt>
          <dd className="text-right tabular-nums">{money(account.equity)}</dd>
          <dt className="text-zinc-400">Today</dt>
          <dd className={`text-right tabular-nums ${dayPnl < 0 ? "text-red-400" : "text-green-400"}`}>{money(dayPnl)}</dd>
          <dt className="text-zinc-400">Cash</dt>
          <dd className="text-right tabular-nums">{money(account.cash)}</dd>
        </dl>
      ) : null}
      {status?.day ? (
        <p className="mb-3 text-xs text-zinc-400">
          {status.day.lockedTicker ? `Today's stock: ${status.day.lockedTicker}. ` : "No entry yet today. "}
          Entries {status.day.entries}
          {status.day.maxEntries ? ` of ${status.day.maxEntries}` : ""}.
          {status.day.stoppedToday ? " Stopped out: no re-entry today." : ""}
        </p>
      ) : null}
      {positions.length === 0 && account ? <p className="text-zinc-400">No stock positions at Alpaca.</p> : null}
      <ul className="space-y-2">
        {positions.map((p) => (
          <li key={p.ticker} className="rounded border border-zinc-700 p-2">
            <div className="flex items-center justify-between">
              <span>
                {p.side.toUpperCase()} {p.quantity} {p.ticker} @ {money(p.avgEntryPrice)}
              </span>
              {confirming === p.ticker ? (
                <span className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void close(p.ticker)}
                    className="rounded bg-red-600 px-2 py-1 text-white disabled:opacity-50"
                  >
                    Confirm close
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirming(null)} className="rounded border border-zinc-600 px-2 py-1">
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setNotice(null);
                    setConfirming(p.ticker);
                  }}
                  className="rounded border border-red-500 px-2 py-1 text-red-300 disabled:opacity-50"
                >
                  Close
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {notice ? (
        <p role="status" className={`mt-3 ${tone[notice.kind]}`}>
          {notice.text}
        </p>
      ) : null}
    </aside>
  );
}
