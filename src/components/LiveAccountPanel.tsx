"use client";

import { useState } from "react";
import type { LiveFeed } from "@/components/LiveModeProvider";
import { liveDay } from "@/lib/liveMode";

type Notice = { kind: "ok" | "wait" | "error"; text: string };

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * The LIVE account block that sits inside the order ticket's card (OrderModule). It renders nothing
 * unless the server reports POLARITO_LIVE_ACCOUNT=1, so with live off the card is exactly what it was.
 *
 * Everything shown comes from Alpaca through /api/broker/live/status (via useLiveStatus), never from the
 * browser ledger. Close sends a real order through /api/broker/live/close and Auto goes through
 * /api/broker/live/auto; a position is only shown as closed once Alpaca's own position list says so.
 * Buying is not here: the ticket above sends real buys through /api/broker/live/buy.
 */
export default function LiveAccountPanel({ feed }: { feed: LiveFeed }) {
  const { mode, reload } = feed;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmAuto, setConfirmAuto] = useState(false);

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
      await reload();
    }
  }

  async function setAuto(auto: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/broker/live/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto }),
        cache: "no-store",
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      setNotice(
        data.ok
          ? { kind: "ok", text: auto ? "Live Auto is ON." : "Live Auto is OFF." }
          : { kind: "error", text: data.error ?? "Auto was not changed." },
      );
    } catch {
      setNotice({ kind: "error", text: "Could not reach the server. Auto was not changed; check the state shown." });
    } finally {
      setConfirmAuto(false);
      setBusy(false);
      await reload();
    }
  }

  if (mode.kind === "sim") return null;
  if (mode.kind !== "live") {
    return (
      <div aria-label="Live account" className="rounded-xl border-2 border-amber-500/70 bg-zinc-950/50 p-4">
        <h3 className="text-base font-bold uppercase tracking-wider text-amber-300">LIVE account (real cash)</h3>
        {mode.kind === "checking" ? (
          <p className="mt-2 text-base text-slate-300">Reading the live account from Alpaca…</p>
        ) : (
          <p role="alert" className="mt-2 text-base font-semibold text-red-300">
            Live data unavailable: {mode.reason} No balances or positions are shown until Alpaca can be read.
          </p>
        )}
      </div>
    );
  }
  const status = mode.status;
  const positions = mode.positions;
  const auto = status.auto;
  const openPositions = auto?.openPositions ?? 0;
  const openOrders = auto?.openOrders ?? 0;
  const offBlocked = Boolean(auto?.on && (openPositions > 0 || openOrders > 0));
  const account = mode.account;
  const dayPnl = liveDay(account).pnl;
  const tone = { ok: "text-green-300", wait: "text-amber-300", error: "text-red-300" } as const;

  return (
    <div aria-label="Live account" className="flex flex-col gap-3 rounded-xl border-2 border-amber-500/70 bg-zinc-950/50 p-4">
      <h3 className="flex flex-wrap items-center justify-between gap-2 text-base font-bold uppercase tracking-wider text-amber-300">
        <span>LIVE account (real cash)</span>
        <span className="text-sm text-slate-400">
          {status.killed ? "kill switch on" : status.enabled ? "orders on" : "observe only"}
        </span>
      </h3>
      {account ? (
        <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-lg">
          <div>
            <dt className="text-sm text-slate-400">Equity</dt>
            <dd className="font-mono font-bold tabular-nums text-white">{money(account.equity)}</dd>
          </div>
          <div>
            <dt className="text-sm text-slate-400">Today</dt>
            <dd className={`font-mono font-bold tabular-nums ${dayPnl < 0 ? "text-red-300" : "text-green-300"}`}>{money(dayPnl)}</dd>
          </div>
          <div>
            <dt className="text-sm text-slate-400">Cash</dt>
            <dd className="font-mono font-bold tabular-nums text-white">{money(account.cash)}</dd>
          </div>
        </dl>
      ) : null}
      {auto ? (
        <div className="rounded-lg border border-zinc-700 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={auto.on ? "text-lg font-bold text-green-300" : "text-lg font-bold text-slate-200"}>
              Live Auto: {auto.on ? "ON" : "OFF"}
            </span>
            {confirmAuto ? (
              <span className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => void setAuto(true)} className="rounded-lg bg-red-600 px-3 py-2 font-bold text-white disabled:opacity-50">
                  Confirm Auto ON
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirmAuto(false)} className="rounded-lg px-3 py-2 font-semibold text-white ring-1 ring-zinc-500">
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy || !auto.available || offBlocked}
                onClick={() => (auto.on ? void setAuto(false) : setConfirmAuto(true))}
                className="rounded-lg px-3 py-2 font-semibold text-white ring-1 ring-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {auto.on ? "Turn Auto OFF" : "Turn Auto ON"}
              </button>
            )}
          </div>
          {offBlocked ? (
            <p className="mt-2 text-sm font-semibold text-amber-300">
              {openPositions > 0 ? `Close all positions first (${openPositions} open at Alpaca). ` : ""}
              {openOrders > 0 ? `Cancel or let working orders finish first (${openOrders} working at Alpaca). ` : ""}
              Auto can only be turned OFF when the account is flat with no working orders. Nothing is cancelled for you.
            </p>
          ) : null}
          <p className="mt-2 text-sm text-slate-400">
            {auto.on
              ? "Auto ON: the server may place entries, re-entries and signal-driven closes (only when live orders are on). It can be turned OFF only when the account is flat with no working orders."
              : "Auto OFF: no entries, re-entries or signal-driven closes are sent. Still running: the 1% daily stop-out and the end-of-day flatten. Close always works."}
          </p>
          {auto.reason !== "Auto is ON." && auto.reason !== "Auto is OFF." ? <p className="mt-1 text-sm text-amber-300">{auto.reason}</p> : null}
        </div>
      ) : null}
      {status.day ? (
        <p className="text-sm text-slate-400">
          {status.day.lockedTicker ? `Today's stock: ${status.day.lockedTicker}. ` : "No entry yet today. "}
          Entries today: {status.day.entries}.
          {status.day.stoppedToday ? " Stopped out: no re-entry today." : ""}
        </p>
      ) : null}
      {positions.length === 0 && account ? <p className="text-base text-slate-300">No stock positions at Alpaca.</p> : null}
      <ul className="space-y-2">
        {positions.map((p) => (
          <li key={p.ticker} className="rounded-lg border border-zinc-700 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-lg font-bold text-white">
                {p.side.toUpperCase()} {p.quantity} {p.ticker} @ {money(p.avgEntryPrice)}
              </span>
              {confirming === p.ticker ? (
                <span className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => void close(p.ticker)} className="rounded-lg bg-red-600 px-3 py-2 font-bold text-white disabled:opacity-50">
                    Confirm close
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirming(null)} className="rounded-lg px-3 py-2 font-semibold text-white ring-1 ring-zinc-500">
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
                  className="rounded-lg px-3 py-2 font-bold text-red-300 ring-1 ring-red-500 disabled:opacity-50"
                >
                  Close
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {notice ? (
        <p role={notice.kind === "error" ? "alert" : "status"} className={`text-base font-semibold ${tone[notice.kind]}`}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
