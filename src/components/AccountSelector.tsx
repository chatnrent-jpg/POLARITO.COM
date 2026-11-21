"use client";

import { useState, useSyncExternalStore, type ChangeEvent } from "react";
import { useLiveMode } from "@/components/LiveModeProvider";
import { liveDay, type LiveMode } from "@/lib/liveMode";
import {
  computeAccount,
  getAccountsOverviewSnapshot,
  getServerAccountsOverview,
  subscribeLedger,
} from "@/lib/ledger";
import {
  ACCOUNTS,
  getAccountDef,
  getActiveAccountId,
  getServerActiveAccountId,
  isAccountId,
  setActiveAccountId,
  subscribeAccounts,
} from "@/lib/multiAccount";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const signedMoney = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;

/** The account card while live is on: every figure from Alpaca, or an explicit "unavailable" (never simulated or stale numbers). */
function LiveAccountCard({ mode }: { mode: Exclude<LiveMode, { kind: "sim" }> }) {
  const day = mode.kind === "live" ? liveDay(mode.account) : null;
  return (
    <section
      aria-label="Active account"
      className="flex w-full max-w-5xl flex-col gap-4 rounded-2xl border-2 border-amber-500 bg-zinc-900 p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-semibold uppercase tracking-wide text-amber-300">
            Active Account · LIVE · Real cash
          </span>
          <span className="truncate text-3xl font-black tracking-tight text-white sm:text-4xl">Alpaca live account</span>
        </div>
        {mode.kind === "live" ? (
          <div className="flex flex-col gap-1 sm:items-end">
            <span className="text-sm font-semibold uppercase tracking-wide text-slate-300">Total Equity</span>
            <span className="font-mono text-3xl font-black tabular-nums text-white sm:text-4xl">{money(mode.account.equity)}</span>
          </div>
        ) : null}
      </div>
      {mode.kind === "live" && day ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-zinc-950/60 px-4 py-3 ring-1 ring-zinc-700">
            <dt className="text-sm font-semibold uppercase tracking-wide text-slate-300">Cash</dt>
            <dd className="font-mono text-xl font-bold tabular-nums text-white">{money(mode.account.cash)}</dd>
          </div>
          <div className="rounded-xl bg-zinc-950/60 px-4 py-3 ring-1 ring-zinc-700">
            <dt className="text-sm font-semibold uppercase tracking-wide text-slate-300">Today P&amp;L</dt>
            <dd className={`font-mono text-xl font-bold tabular-nums ${day.pnl > 0 ? "text-green-400" : day.pnl < 0 ? "text-red-400" : "text-white"}`}>
              {signedMoney(day.pnl)}
              {day.pct !== null ? ` (${day.pct >= 0 ? "+" : "−"}${Math.abs(day.pct).toFixed(2)}%)` : ""}
            </dd>
          </div>
          <div className="rounded-xl bg-zinc-950/60 px-4 py-3 ring-1 ring-zinc-700">
            <dt className="text-sm font-semibold uppercase tracking-wide text-slate-300">Buying power</dt>
            <dd className="font-mono text-xl font-bold tabular-nums text-white">{money(mode.account.buyingPower)}</dd>
          </div>
        </dl>
      ) : null}
      {mode.kind === "checking" ? <p className="text-base text-slate-300">Reading the live account from Alpaca…</p> : null}
      {mode.kind === "unavailable" ? (
        <p role="alert" className="rounded-xl border-2 border-red-500 bg-red-950/50 p-4 text-base font-semibold text-red-200">
          Live data unavailable: {mode.reason} No balances are shown until Alpaca can be read.
        </p>
      ) : null}
      <span className="text-sm text-slate-400">Read from your Alpaca live account every 5 seconds.</span>
    </section>
  );
}

/**
 * Account switcher. Choosing an account only changes WHICH profile is active
 * (multiAccount.ts); OrderModule and LedgerPanel subscribe to the same store
 * and re-render from that account's own data. Nothing is copied between
 * accounts.
 *
 * `marks` maps ticker -> latest daily close (the loaded ticker). Equity is
 * initial balance + realized P&L + unrealized P&L on positions that have a mark.
 */
export default function AccountSelector({
  marks,
}: {
  marks: Readonly<Record<string, number>>;
}) {
  const activeId = useSyncExternalStore(
    subscribeAccounts,
    getActiveAccountId,
    getServerActiveAccountId,
  );
  const overview = useSyncExternalStore(
    subscribeLedger,
    getAccountsOverviewSnapshot,
    getServerAccountsOverview,
  );
  const [error, setError] = useState<string | null>(null);
  const { mode } = useLiveMode();

  const summaries = ACCOUNTS.map((def) => ({
    def,
    account: computeAccount(overview[def.id], marks, def.initialBalance),
  }));
  const active = summaries.find((s) => s.def.id === activeId) ?? summaries[0];

  if (mode.kind !== "sim") return <LiveAccountCard mode={mode} />;

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    if (!isAccountId(next)) return;
    const result = setActiveAccountId(next);
    setError(result.ok ? null : result.error);
  }

  return (
    <section
      aria-label="Active account"
      className="flex w-full max-w-5xl flex-col gap-4 rounded-2xl border-2 border-white bg-zinc-900 p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Active Account · Simulated
          </span>
          <span className="truncate text-3xl font-black tracking-tight text-white sm:text-4xl">
            {getAccountDef(active.def.id).name}
          </span>
        </div>

        <div className="flex flex-col gap-1 sm:items-end">
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Total Equity
          </span>
          <span className="font-mono text-3xl font-black tabular-nums text-white sm:text-4xl">
            {money(active.account.equity)}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="account-select"
          className="text-sm font-semibold uppercase tracking-wide text-slate-300"
        >
          Switch account
        </label>
        <select
          id="account-select"
          value={active.def.id}
          onChange={onChange}
          className="h-16 w-full rounded-xl bg-white px-4 text-xl font-black text-zinc-950 ring-2 ring-white focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-400"
        >
          {summaries.map(({ def, account }) => (
            <option key={def.id} value={def.id}>
              {def.name} · {money(account.equity)}
            </option>
          ))}
        </select>
        <span className="text-sm text-slate-400">
          Initial balance {money(active.def.initialBalance)}. Orders and closes are recorded in
          this account only.
          {active.account.unmarked > 0 &&
            ` Equity excludes ${active.account.unmarked} open position${
              active.account.unmarked === 1 ? "" : "s"
            } on tickers that aren't loaded (no price to mark against).`}
        </span>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl border-2 border-red-500 bg-red-950/50 p-4 text-base font-semibold text-red-200"
        >
          {error}
        </p>
      )}
    </section>
  );
}
