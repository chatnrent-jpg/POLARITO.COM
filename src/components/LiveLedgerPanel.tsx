"use client";

import { useEffect, useState } from "react";
import type { LiveMode } from "@/lib/liveMode";
import { liveDay, liveExposure } from "@/lib/liveMode";
import type { BrokerOrder } from "@/lib/broker/types";

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signedMoney = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;
const pnlTone = (n: number) => (n > 0 ? "text-green-400" : n < 0 ? "text-red-400" : "text-white");
const th = "px-3 py-3 font-semibold";
const thR = `${th} text-right`;
const td = "px-3 py-3";
const tdR = `${td} text-right`;
const ORDERS_REFRESH_MS = 15_000;

type OrdersState = { orders: BrokerOrder[] | null; error: string | null };

/** Real orders and fills from Alpaca (GET /api/broker/live/orders). A failed read is an error, never an empty list. */
function useLiveOrders(active: boolean): OrdersState {
  const [state, setState] = useState<OrdersState>({ orders: null, error: null });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/broker/live/orders", { cache: "no-store" });
        const data = (await res.json()) as { ok?: boolean; orders?: BrokerOrder[]; error?: string };
        if (cancelled) return;
        if (data.ok === true && Array.isArray(data.orders)) setState({ orders: data.orders, error: null });
        else setState({ orders: null, error: data.error ?? "The live order list could not be read." });
      } catch {
        if (!cancelled) setState({ orders: null, error: "Could not reach the live orders route." });
      }
    }
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), ORDERS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [active]);
  return state;
}

const stamp = (iso?: string) => (iso ? iso.replace("T", " ").slice(0, 16) + "Z" : "—");

/**
 * The ledger section while live is on: balances, positions and order history all come from the Alpaca live
 * account (status + orders routes). Read-only: closing is the Close button in the LIVE account block of the order
 * ticket card. If Alpaca cannot be read it says so and shows no numbers.
 */
export default function LiveLedgerPanel({ mode }: { mode: Exclude<LiveMode, { kind: "sim" }> }) {
  const live = mode.kind === "live";
  const { orders, error } = useLiveOrders(live);

  const shell = (children: React.ReactNode) => (
    <section aria-label="Live ledger" className="flex w-full flex-col gap-6 rounded-2xl border-2 border-amber-500/70 bg-zinc-900/60 p-5 sm:p-6">
      <h2 className="text-lg font-bold uppercase tracking-wider text-amber-300">Ledger · LIVE · Alpaca real cash</h2>
      {children}
    </section>
  );

  if (mode.kind === "checking") return shell(<p className="text-base text-slate-300">Reading the live account from Alpaca…</p>);
  if (mode.kind === "unavailable") {
    return shell(
      <p role="alert" className="rounded-xl border-2 border-red-500 bg-red-950/50 p-4 text-base font-semibold text-red-200">
        Live data unavailable: {mode.reason} No balances, positions or orders are shown until Alpaca can be read.
      </p>,
    );
  }

  const { account, positions, status } = mode;
  const day = liveDay(account);
  const exposure = liveExposure(positions, account.equity);
  const limits = status.limits;
  const tiles = [
    { label: "Equity", value: money(account.equity), tone: "text-white" },
    { label: "Cash", value: money(account.cash), tone: "text-white" },
    { label: "Buying power", value: money(account.buyingPower), tone: "text-white" },
    {
      label: "Today P&L",
      value: `${signedMoney(day.pnl)}${day.pct !== null ? ` (${day.pct >= 0 ? "+" : "−"}${Math.abs(day.pct).toFixed(2)}%)` : ""}`,
      tone: pnlTone(day.pnl),
    },
    {
      label: "Positions",
      value: limits ? `${positions.length} of ${limits.maxPositions}` : String(positions.length),
      tone: limits && positions.length > limits.maxPositions ? "text-red-300" : "text-white",
    },
    {
      label: "Stock exposure",
      value: `${money(exposure.notional)}${exposure.pct !== null ? ` (${exposure.pct.toFixed(1)}%)` : ""}`,
      tone: "text-white",
    },
  ];

  return shell(
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl bg-zinc-950/60 px-4 py-3 ring-1 ring-zinc-700">
            <div className="text-sm font-semibold uppercase tracking-wide text-slate-300">{t.label}</div>
            <div className={`font-mono text-xl font-bold tabular-nums ${t.tone}`}>{t.value}</div>
          </div>
        ))}
      </div>
      {limits ? (
        <p className="text-sm text-slate-400">
          Live risk limits: up to {limits.maxPositions} stocks at once, {limits.perPositionCapPct}% of equity per position, {limits.totalExposureCapPct}% total exposure, long only,
          {" "}{limits.dailyLossPct}% daily stop on the whole account.
          {status.day?.stoppedToday ? " Stopped out today: no entries until the next session." : ""}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="text-xl font-black uppercase tracking-wider text-white">Live Positions</h3>
        {positions.length === 0 ? (
          <p className="text-base text-slate-300">No stock positions at Alpaca.</p>
        ) : (
          <div className="overflow-auto rounded-xl ring-1 ring-zinc-700">
            <table className="w-full min-w-[44rem] border-collapse text-left text-base">
              <thead className="bg-zinc-900 text-sm uppercase tracking-wide text-slate-300">
                <tr>
                  <th className={th}>Ticker</th>
                  <th className={th}>Side</th>
                  <th className={thR}>Qty</th>
                  <th className={thR}>Avg entry</th>
                  <th className={thR}>% equity</th>
                  <th className={thR}>Mark</th>
                  <th className={thR}>Unrealized</th>
                </tr>
              </thead>
              <tbody className="font-mono text-white">
                {positions.map((p) => (
                  <tr key={`${p.ticker}-${p.side}`} className="border-t border-zinc-800">
                    <td className={`${td} text-lg font-bold`}>{p.ticker}</td>
                    <td className={`${td} font-bold uppercase`}>{p.side}</td>
                    <td className={tdR}>{p.quantity.toLocaleString("en-US")}</td>
                    <td className={tdR}>{money(p.avgEntryPrice)}</td>
                    <td className={tdR}>
                      {account.equity > 0
                        ? `${(((typeof p.marketValue === "number" ? p.marketValue : p.quantity * p.avgEntryPrice) / account.equity) * 100).toFixed(1)}%`
                        : "—"}
                    </td>
                    <td className={tdR}>{typeof p.currentPrice === "number" ? money(p.currentPrice) : "—"}</td>
                    <td className={`${tdR} font-bold ${typeof p.unrealizedPnl === "number" ? pnlTone(p.unrealizedPnl) : "text-slate-400"}`}>
                      {typeof p.unrealizedPnl === "number" ? signedMoney(p.unrealizedPnl) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-sm text-slate-400">Read-only. Close any one position with its own Close button in the LIVE account block of the order ticket card.</p>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-xl font-black uppercase tracking-wider text-white">Live Order History</h3>
        {error ? (
          <p role="alert" className="rounded-xl border-2 border-red-500 bg-red-950/50 p-4 text-base font-semibold text-red-200">
            Live orders unavailable: {error}
          </p>
        ) : orders === null ? (
          <p className="text-base text-slate-300">Reading orders from Alpaca…</p>
        ) : orders.length === 0 ? (
          <p className="text-base text-slate-300">No orders at Alpaca in the last 7 days.</p>
        ) : (
          <div className="max-h-96 overflow-auto rounded-xl ring-1 ring-zinc-700">
            <table className="w-full min-w-[44rem] border-collapse text-left text-base">
              <thead className="sticky top-0 bg-zinc-900 text-sm uppercase tracking-wide text-slate-300">
                <tr>
                  <th className={th}>Submitted</th>
                  <th className={th}>Ticker</th>
                  <th className={th}>Side</th>
                  <th className={thR}>Qty</th>
                  <th className={thR}>Filled</th>
                  <th className={th}>Status</th>
                  <th className={th}>Order id</th>
                </tr>
              </thead>
              <tbody className="font-mono text-white">
                {orders.map((o) => (
                  <tr key={o.id} className="border-t border-zinc-800">
                    <td className={td}>{stamp(o.submittedAt)}</td>
                    <td className={`${td} text-lg font-bold`}>{o.ticker}</td>
                    <td className={`${td} font-bold uppercase`}>{o.side}</td>
                    <td className={tdR}>{o.quantity.toLocaleString("en-US")}</td>
                    <td className={tdR}>
                      {typeof o.filledQuantity === "number" && o.filledQuantity > 0
                        ? `${o.filledQuantity.toLocaleString("en-US")}${typeof o.filledAvgPrice === "number" ? ` @ ${money(o.filledAvgPrice)}` : ""}`
                        : "—"}
                    </td>
                    <td className={td}>{o.status}</td>
                    <td className={`${td} text-xs text-slate-400`}>{o.clientOrderId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>,
  );
}
