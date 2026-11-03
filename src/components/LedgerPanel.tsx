"use client";

import { useState, useSyncExternalStore, type KeyboardEvent } from "react";
import {
  clearLedger,
  closeActivePosition,
  computeAccount,
  getLedgerSnapshot,
  getServerLedgerSnapshot,
  positionPnl,
  subscribeLedger,
  type Position,
} from "@/lib/ledger";
import { getAccountDef, type AccountId } from "@/lib/multiAccount";
import type { OrderSide } from "@/lib/orderGuard";

/** The ticker currently loaded on the dashboard, with its last daily close. */
export type CurrentMark = { ticker: string; close: number; asOf: string };

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signedMoney = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;
const pnlTone = (n: number) =>
  n > 0 ? "text-green-400" : n < 0 ? "text-red-400" : "text-white";

const th = "px-3 py-3 font-semibold";
const thR = `${th} text-right`;
const td = "px-3 py-3";
const tdR = `${td} text-right`;

type Closing = {
  accountId: AccountId;
  ticker: string;
  side: OrderSide;
  quantity: number;
  avgPrice: number;
  exitPrice: number;
  asOf: string;
};

/**
 * Simulated ledger: balances, active positions, closed trade history.
 * A position can only be closed while its ticker is the one loaded on the
 * dashboard, and it is closed at that ticker's last daily close.
 */
export default function LedgerPanel({ current }: { current: CurrentMark | null }) {
  const ledger = useSyncExternalStore(
    subscribeLedger,
    getLedgerSnapshot,
    getServerLedgerSnapshot,
  );
  const [closing, setClosing] = useState<Closing | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const marks: Record<string, number> = current ? { [current.ticker]: current.close } : {};
  const accountDef = getAccountDef(ledger.accountId);
  const account = computeAccount(ledger, marks, accountDef.initialBalance);
  const positions = [...ledger.positions].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const history = [...ledger.closed].reverse();

  function canClose(p: Position): boolean {
    return current !== null && current.ticker === p.ticker && current.close > 0;
  }

  function askToClose(p: Position) {
    setNotice(null);
    if (!current || current.ticker !== p.ticker) return;
    setClosing({
      accountId: ledger.accountId,
      ticker: p.ticker,
      side: p.side,
      quantity: p.quantity,
      avgPrice: p.avgPrice,
      exitPrice: current.close,
      asOf: current.asOf,
    });
  }

  function confirmClose() {
    if (!closing) return;
    const c = closing;
    setClosing(null);

    // Re-check everything against live state; the prompt may be stale.
    const pos = ledger.positions.find((p) => p.ticker === c.ticker && p.side === c.side);
    if (
      c.accountId !== ledger.accountId ||
      !current ||
      current.ticker !== c.ticker ||
      current.close !== c.exitPrice ||
      current.asOf !== c.asOf ||
      !pos ||
      pos.quantity !== c.quantity
    ) {
      setNotice({
        kind: "error",
        text: "The position or the loaded price changed. Nothing was closed. Review and try again.",
      });
      return;
    }

    const result = closeActivePosition(c.ticker, c.quantity, c.exitPrice, {
      accountId: c.accountId,
      side: c.side,
      exitDate: c.asOf,
    });
    if (result.ok) {
      setNotice({
        kind: "ok",
        text: `${accountDef.name}: closed ${result.trade.side.toUpperCase()} ${result.trade.quantity.toLocaleString("en-US")} ${result.trade.ticker} @ ${money(result.trade.exitPrice)}. Realized ${signedMoney(result.trade.realizedPnl)}. ${money(result.released)} released to cash.`,
      });
    } else {
      setNotice({ kind: "error", text: result.error });
    }
  }

  function onDialogKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") setClosing(null);
  }

  // Preview only; the real figures come from closeActivePosition.
  const closePreview = closing
    ? {
        pnl:
          (closing.side === "long"
            ? closing.exitPrice - closing.avgPrice
            : closing.avgPrice - closing.exitPrice) * closing.quantity,
        notional: closing.quantity * closing.avgPrice,
      }
    : null;

  const tiles = [
    { label: "Starting cash", value: money(account.startingCash), tone: "text-white" },
    { label: "Cash available", value: money(account.cashAvailable), tone: "text-white" },
    { label: "Realized P&L", value: signedMoney(account.realizedPnl), tone: pnlTone(account.realizedPnl) },
    { label: "Unrealized P&L", value: signedMoney(account.unrealizedPnl), tone: pnlTone(account.unrealizedPnl) },
    { label: "Equity at close", value: money(account.equity), tone: "text-white" },
  ];

  return (
    <section
      aria-label="Simulated ledger"
      className="flex w-full flex-col gap-6 rounded-2xl border border-zinc-700 bg-zinc-900/60 p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold uppercase tracking-wider text-white">
          Ledger · Simulated · {accountDef.name}
        </h2>
        {(positions.length > 0 || history.length > 0) && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Reset ${accountDef.name} to ${money(accountDef.initialBalance)}? This clears its open positions and closed trades. Other accounts are not affected.`)) {
                setClosing(null);
                const cleared = clearLedger(ledger.accountId);
                setNotice(cleared.ok ? null : { kind: "error", text: cleared.error });
              }
            }}
            className="rounded-lg px-4 py-2 text-base font-bold text-slate-200 ring-1 ring-zinc-600 hover:text-white hover:ring-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Reset account
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((s) => (
          <div key={s.label} className="rounded-xl bg-zinc-950/60 px-4 py-3 ring-1 ring-zinc-700">
            <div className="text-sm font-semibold uppercase tracking-wide text-slate-300">
              {s.label}
            </div>
            <div className={`font-mono text-xl font-bold tabular-nums ${s.tone}`}>{s.value}</div>
          </div>
        ))}
      </div>

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-xl p-4 text-lg font-semibold ${
            notice.kind === "ok"
              ? "border-2 border-green-500 bg-green-950/50 text-green-200"
              : "border-2 border-red-500 bg-red-950/50 text-red-200"
          }`}
        >
          {notice.text}
        </p>
      )}

      {/* Active positions */}
      <div className="flex flex-col gap-3">
        <h3 className="text-xl font-black uppercase tracking-wider text-white">
          Active Positions
        </h3>
        {account.unmarked > 0 && (
          <p className="text-base text-slate-300">
            {account.unmarked} position{account.unmarked === 1 ? "" : "s"} on other tickers can&apos;t
            be marked or closed from here. Analyze that ticker first.
          </p>
        )}
        {positions.length === 0 ? (
          <p className="text-base text-slate-300">
            No open positions in this account. Orders that pass the safety gate appear here at the last daily
            close.
          </p>
        ) : (
          <div className="overflow-auto rounded-xl ring-1 ring-zinc-700">
            <table className="w-full min-w-[46rem] border-collapse text-left text-base">
              <thead className="bg-zinc-900 text-sm uppercase tracking-wide text-slate-300">
                <tr>
                  <th className={th}>Ticker</th>
                  <th className={th}>Side</th>
                  <th className={thR}>Qty</th>
                  <th className={thR}>Avg entry</th>
                  <th className={thR}>Mark</th>
                  <th className={thR}>Unrealized</th>
                  <th className={thR}>Action</th>
                </tr>
              </thead>
              <tbody className="font-mono text-white">
                {positions.map((p) => {
                  const mark = marks[p.ticker];
                  const marked = typeof mark === "number";
                  const pnl = marked ? positionPnl(p, mark) : null;
                  const enabled = canClose(p);
                  return (
                    <tr key={`${p.ticker}-${p.side}`} className="border-t border-zinc-800">
                      <td className={`${td} text-lg font-bold`}>{p.ticker}</td>
                      <td className={`${td} font-bold uppercase`}>{p.side}</td>
                      <td className={tdR}>{p.quantity.toLocaleString("en-US")}</td>
                      <td className={tdR}>{money(p.avgPrice)}</td>
                      <td className={tdR}>{marked ? money(mark) : "—"}</td>
                      <td className={`${tdR} font-bold ${pnl === null ? "text-slate-400" : pnlTone(pnl)}`}>
                        {pnl === null ? "—" : signedMoney(pnl)}
                      </td>
                      <td className={tdR}>
                        <div className="flex flex-col items-end gap-1">
                          <button
                            type="button"
                            disabled={!enabled}
                            onClick={() => askToClose(p)}
                            aria-label={`Close ${p.side} position in ${p.ticker}`}
                            className="rounded-lg bg-white px-4 py-3 font-sans text-base font-black uppercase tracking-wide text-zinc-950 hover:bg-slate-200 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 disabled:hover:bg-zinc-800"
                          >
                            CLOSE POSITION
                          </button>
                          {!enabled && (
                            <span className="font-sans text-sm font-semibold text-orange-300">
                              Load {p.ticker} to close
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Closed trade history */}
      <div className="flex flex-col gap-3">
        <h3 className="text-xl font-black uppercase tracking-wider text-white">
          Closed Trade History
        </h3>
        {history.length === 0 ? (
          <p className="text-base text-slate-300">
            No closed trades yet in this account. Closed positions and their realized P&amp;L are listed here.
          </p>
        ) : (
          <div className="max-h-96 overflow-auto rounded-xl ring-1 ring-zinc-700">
            <table className="w-full min-w-[40rem] border-collapse text-left text-base">
              <thead className="sticky top-0 bg-zinc-900 text-sm uppercase tracking-wide text-slate-300">
                <tr>
                  <th className={th}>Exit date</th>
                  <th className={th}>Ticker</th>
                  <th className={th}>Side</th>
                  <th className={thR}>Qty</th>
                  <th className={thR}>Entry</th>
                  <th className={thR}>Exit</th>
                  <th className={thR}>Realized P&amp;L</th>
                </tr>
              </thead>
              <tbody className="font-mono text-white">
                {history.map((t) => (
                  <tr key={t.id} className="border-t border-zinc-800">
                    <td className={td}>{t.exitDate}</td>
                    <td className={`${td} text-lg font-bold`}>{t.ticker}</td>
                    <td className={`${td} font-bold uppercase`}>{t.side}</td>
                    <td className={tdR}>{t.quantity.toLocaleString("en-US")}</td>
                    <td className={tdR}>{money(t.entryPrice)}</td>
                    <td className={tdR}>{money(t.exitPrice)}</td>
                    <td className={`${tdR} text-lg font-black ${pnlTone(t.realizedPnl)}`}>
                      {signedMoney(t.realizedPnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation prompt */}
      {closing && closePreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onKeyDown={onDialogKey}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm close position"
            className="flex w-full max-w-lg flex-col gap-5 rounded-2xl border-2 border-white bg-zinc-950 p-6"
          >
            <h3 className="text-2xl font-black uppercase tracking-wider text-white">
              Close {closing.side} position?
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-lg">
              <dt className="text-slate-300">Account</dt>
              <dd className="font-bold text-white">{accountDef.name}</dd>
              <dt className="text-slate-300">Ticker</dt>
              <dd className="font-mono font-bold text-white">{closing.ticker}</dd>
              <dt className="text-slate-300">Quantity</dt>
              <dd className="font-mono font-bold text-white">
                {closing.quantity.toLocaleString("en-US")}
              </dd>
              <dt className="text-slate-300">Avg entry</dt>
              <dd className="font-mono font-bold text-white">{money(closing.avgPrice)}</dd>
              <dt className="text-slate-300">Exit price</dt>
              <dd className="font-mono font-bold text-white">
                {money(closing.exitPrice)}{" "}
                <span className="text-sm font-medium text-slate-400">(close of {closing.asOf})</span>
              </dd>
              <dt className="text-slate-300">Realized P&amp;L</dt>
              <dd className={`font-mono text-2xl font-black ${pnlTone(closePreview.pnl)}`}>
                {signedMoney(closePreview.pnl)}
              </dd>
              <dt className="text-slate-300">Cash released</dt>
              <dd className="font-mono font-bold text-white">
                {money(closePreview.notional)}{" "}
                <span className="text-sm font-medium text-slate-400">+ realized P&amp;L</span>
              </dd>
            </dl>
            <p className="text-sm text-slate-400">
              Simulation only. No broker is contacted. The exit is priced at the last daily close
              of the loaded ticker.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={confirmClose}
                className="h-14 flex-1 rounded-xl bg-white text-lg font-black uppercase tracking-wider text-zinc-950 hover:bg-slate-200 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-400"
              >
                Confirm close
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => setClosing(null)}
                className="h-14 rounded-xl px-6 text-lg font-bold text-white ring-2 ring-zinc-500 hover:ring-white focus:outline-none focus-visible:ring-white"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
