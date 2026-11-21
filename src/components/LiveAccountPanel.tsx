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
  const [alsoAutoOff, setAlsoAutoOff] = useState(true);

  /** The existing guarded Auto route: OFF is only accepted by the server when the account is flat with no working order. */
  async function requestAuto(auto: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch("/api/broker/live/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto }),
        cache: "no-store",
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      return data.ok ? { ok: true } : { ok: false, error: data.error ?? "Auto was not changed." };
    } catch {
      return { ok: false, error: "Could not reach the server. Auto was not changed; check the state shown." };
    }
  }

  async function close(ticker: string, thenAutoOff: boolean) {
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
        const closed = `${ticker}: ${data.message ?? "Closed."}`;
        if (thenAutoOff) {
          const off = await requestAuto(false);
          setNotice(
            off.ok
              ? { kind: "ok", text: `${closed} Live Auto is OFF.` }
              : { kind: "error", text: `${closed} Live Auto is still ON: ${off.error}` },
          );
        } else {
          setNotice({ kind: "ok", text: closed });
        }
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
      const res = await requestAuto(auto);
      setNotice(
        res.ok
          ? { kind: "ok", text: auto ? "Live Auto is ON." : "Live Auto is OFF." }
          : { kind: "error", text: res.error ?? "Auto was not changed." },
      );
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
      {status.day || status.limits ? (
        <p className="text-sm text-slate-400">
          {status.limits ? (
            <>
              Positions: {positions.length} of {status.limits.maxPositions} (each up to {status.limits.perPositionCapPct}% of equity, long only).{" "}
              {positions.length > status.limits.maxPositions ? (
                <span className="font-semibold text-red-300">More than {status.limits.maxPositions} positions are open: close the extra ones. </span>
              ) : null}
            </>
          ) : null}
          {status.day
            ? `${status.day.enteredTickers && status.day.enteredTickers.length > 0 ? `Entered today: ${status.day.enteredTickers.join(", ")}. ` : "No entry yet today. "}Entries today: ${status.day.entries}.${status.day.stoppedToday ? " Stopped out: no re-entry today." : ""}`
            : null}
        </p>
      ) : null}
      {positions.length === 0 ? (
        <div className="rounded-lg border border-zinc-700 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-base text-slate-300">No stock positions at Alpaca.</span>
            <button
              type="button"
              disabled
              aria-label="Close position (disabled: no open position to close)"
              className="cursor-not-allowed rounded-lg px-3 py-2 font-bold text-red-300 opacity-50 ring-1 ring-red-500"
            >
              Close position
            </button>
          </div>
          <p className="mt-2 text-sm text-slate-400">No open position to close.</p>
        </div>
      ) : null}
      <ul className="space-y-2">
        {positions.map((p) => (
          <li key={p.ticker} className="rounded-lg border border-zinc-700 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-lg font-bold text-white">
                {p.side.toUpperCase()} {p.quantity} {p.ticker} @ {money(p.avgEntryPrice)}
              </span>
              {confirming === p.ticker ? (
                <span className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => void close(p.ticker, Boolean(auto?.on) && alsoAutoOff)} className="rounded-lg bg-red-600 px-3 py-2 font-bold text-white disabled:opacity-50">
                    Confirm close
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirming(null)} className="rounded-lg px-3 py-2 font-semibold text-white ring-1 ring-zinc-500">
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy || !mode.ordersAllowed}
                  onClick={() => {
                    setNotice(null);
                    setConfirming(p.ticker);
                  }}
                  className="rounded-lg px-3 py-2 font-bold text-red-300 ring-1 ring-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Close position
                </button>
              )}
            </div>
            {!mode.ordersAllowed ? (
              <p className="mt-2 text-sm font-semibold text-amber-300">Close is disabled: live orders are off. {mode.ordersReason}</p>
            ) : null}
            {confirming === p.ticker ? (
              <div className="mt-2 flex flex-col gap-2 text-sm">
                <p className="font-semibold text-amber-200">
                  REAL ORDER: this sends a market {p.side === "short" ? "buy to cover" : "sell"} of all {p.quantity} {p.ticker} to your live Alpaca account. It never cancels other orders.
                </p>
                {auto?.on ? (
                  <label className="flex items-start gap-2 text-slate-200">
                    <input type="checkbox" checked={alsoAutoOff} onChange={(e) => setAlsoAutoOff(e.target.checked)} className="mt-1" />
                    <span>
                      Then turn Live Auto OFF once the account is flat. Auto is ON: it will not buy {p.ticker} again today if it entered it
                      today, but it would fill the freed slot with the next-ranked stock on its next tick (about 10 seconds). Auto OFF is only
                      accepted when the account is flat with no working orders (your other positions count); if it is refused, Auto stays ON.
                    </span>
                  </label>
                ) : null}
              </div>
            ) : null}
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
