"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import LiveAccountPanel from "@/components/LiveAccountPanel";
import { useLiveMode } from "@/components/LiveModeProvider";
import {
  addLedgerEntry,
  canOpen,
  computeAccount,
  getLedgerSnapshot,
  getServerLedgerSnapshot,
  newEntryId,
  subscribeLedger,
  type LedgerEntry,
} from "@/lib/ledger";
import {
  evaluateGuard,
  isOrderSide,
  validateQuantity,
  type OrderSide,
} from "@/lib/orderGuard";
import { getAccountDef } from "@/lib/multiAccount";
import { metaFor, type Polarity } from "@/lib/polarity";
import { tickerFieldState } from "@/lib/tickerField";

/** What the engine says about the ticker currently on the dashboard. */
export type OrderAnalysis = {
  ticker: string;
  polarity: Polarity;
  /** Latest daily close: the simulated fill price. */
  close: number;
  /** Session date of that close. */
  asOf: string;
  /** false while < 20 bars of history exist. */
  ready: boolean;
};

/** The one Stock Ticker field: the dashboard owns the value and the analysis, this card only renders and forwards. */
export type TickerControl = {
  value: string;
  onChange: (value: string) => void;
  /** Analyze the ticker currently in the field (load bars, gear/polarity). */
  onAnalyze: () => void;
  loading: boolean;
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const labelCls = "text-sm font-semibold uppercase tracking-wide text-slate-300";
const fieldCls =
  "w-full rounded-lg bg-zinc-950 px-4 py-3 text-lg font-semibold text-white ring-1 ring-zinc-600 placeholder:font-normal placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-white";

/**
 * Execution safety gate.
 *
 * Flow: engine polarity (prop) + order type + quantity -> evaluateGuard ->
 *   allowed? -> Review Order -> Confirm -> addLedgerEntry (simulated only).
 * The guard is re-run at confirm time against the current props, so a review
 * opened under one state can never be confirmed under another.
 *
 * Mode. With POLARITO_LIVE_ACCOUNT off the confirm step records a SIMULATED ledger entry. When the server says live
 * orders are possible (POLARITO_LIVE_ACCOUNT=1 and POLARITO_LIVE_TRADING_ENABLED=1, kill switch off,
 * keys present) the same ticket sends a REAL long market buy through
 * POST /api/broker/live/buy instead, and nothing is written to the simulated ledger. Long only: a
 * Short is refused in live mode. The server applies the real risk rules (watchlist, 33% per-position cap, up to 3
 * positions at once, cash, stop-out lockout, market hours) and may send fewer shares than asked. When live is on but
 * orders are off, or the live account cannot be read, the ticket is locked with the reason (it never falls back to
 * the simulated ledger).
 */
export default function OrderModule({
  analysis: analyzed,
  ticker,
}: {
  analysis: OrderAnalysis | null;
  ticker: TickerControl;
}) {
  // Orders only use an analysis for the ticker that is in the field; typing another ticker locks them until Analyze.
  const fieldState = tickerFieldState(ticker.value, analyzed?.ticker ?? null);
  const analysis = fieldState === "current" ? analyzed : null;
  const [side, setSide] = useState<OrderSide | "">("");
  const [qtyRaw, setQtyRaw] = useState("");
  const [review, setReview] = useState<{ key: string; entry: LedgerEntry } | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "wait" | "error"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const feed = useLiveMode();
  const mode = feed.mode;
  const live = mode.kind === "live" && mode.ordersAllowed;
  // Anything but the simulated mode and a live-and-orders-on account locks the ticket: it never falls back to
  // the simulated ledger once live is on, and never trades on an account it could not read.
  const lockReason: string | null =
    mode.kind === "sim" || live
      ? null
      : mode.kind === "live"
        ? `Live orders are off: ${mode.ordersReason}`
        : mode.kind === "checking"
          ? "Checking the live account. Orders unlock when Alpaca answers."
          : `Live data unavailable: ${mode.reason} Orders are locked.`;
  const liveWatchlist = mode.kind === "live" ? (mode.status.manual?.watchlist ?? []) : [];
  const liveCash = mode.kind === "live" ? Math.max(0, Math.min(mode.account.cash, mode.account.buyingPower)) : 0;

  const ledger = useSyncExternalStore(
    subscribeLedger,
    getLedgerSnapshot,
    getServerLedgerSnapshot,
  );

  const guard = evaluateGuard(analysis, side);
  const qty = validateQuantity(qtyRaw);
  const price = analysis?.close ?? 0;
  const notional = qty.ok ? qty.qty * price : 0;
  const accountDef = getAccountDef(ledger.accountId);
  const account = computeAccount(ledger, {}, accountDef.initialBalance);
  const cashLimit = mode.kind === "sim" ? account.cashAvailable : liveCash;
  const hasFunds = qty.ok && notional <= cashLimit;
  // No simultaneous long and short on one ticker (simulated ledger only; the live account is checked by the server).
  const openCheck =
    mode.kind === "sim" && analysis && isOrderSide(side) ? canOpen(ledger, analysis.ticker, side) : { ok: true as const };
  // Live orders are long only and watchlist only (the server re-checks both).
  const liveShort = live && side === "short";
  const offWatchlist = live && analysis !== null && liveWatchlist.length > 0 && !liveWatchlist.includes(analysis.ticker);

  const canReview = guard.canSubmit && openCheck.ok && qty.ok && hasFunds && price > 0 && !liveShort && !offWatchlist && !submitting && lockReason === null;

  // A review only counts while every input it was built from is unchanged.
  const key = `${live ? "live" : "sim"}|${ledger.accountId}|${analysis?.ticker}|${analysis?.polarity}|${analysis?.asOf}|${side}|${qtyRaw.trim()}`;
  const activeReview = review && review.key === key ? review.entry : null;

  const gearMeta = analysis && analysis.ready ? metaFor(analysis.polarity) : null;

  function buildEntry(): LedgerEntry | null {
    // Re-validate from scratch; never trust that the button state was honest.
    if (!analysis || !isOrderSide(side) || lockReason !== null) return null;
    const g = evaluateGuard(analysis, side);
    const q = validateQuantity(qtyRaw);
    if (!g.canSubmit || !q.ok || analysis.close <= 0) return null;
    if (analysis.polarity !== 1 && analysis.polarity !== -1) return null;
    const total = q.qty * analysis.close;
    if (live) {
      if (side !== "long" || offWatchlist || total > liveCash) return null;
    } else {
      if (!canOpen(ledger, analysis.ticker, side).ok) return null;
      if (total > account.cashAvailable) return null;
    }
    return {
      id: newEntryId(),
      createdAt: new Date().toISOString(),
      simulated: true,
      ticker: analysis.ticker,
      side,
      quantity: q.qty,
      price: analysis.close,
      priceBasis: "last daily close",
      priceDate: analysis.asOf,
      polarityAtEntry: analysis.polarity,
      notional: total,
    };
  }

  function onReview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNotice(null);
    const entry = buildEntry();
    if (!entry) {
      setReview(null);
      return;
    }
    setReview({ key, entry });
  }

  async function submitLive(entry: LedgerEntry) {
    setSubmitting(true);
    try {
      const res = await fetch("/api/broker/live/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: entry.ticker, quantity: entry.quantity, requireDrive: true }),
        cache: "no-store",
      });
      const data = (await res.json()) as { ok: boolean; filled?: boolean; message?: string; error?: string };
      if (!data.ok) {
        setNotice({ kind: "error", text: data.error ?? "The live buy was refused. Nothing was sent." });
      } else {
        setQtyRaw("");
        setNotice({ kind: data.filled ? "ok" : "wait", text: data.message ?? "Live buy accepted; waiting for the fill." });
      }
    } catch {
      setNotice({ kind: "error", text: "Could not reach the server. Nothing is assumed bought; check the live positions below." });
    } finally {
      setSubmitting(false);
      await feed.reload();
    }
  }

  function onConfirm() {
    const entry = buildEntry();
    if (!entry || !activeReview) {
      setReview(null);
      setNotice({
        kind: "error",
        text: live ? "Order no longer passes the safety gate. Nothing was sent." : "Order no longer passes the safety gate. Nothing was recorded.",
      });
      return;
    }
    if (live) {
      setReview(null);
      void submitLive(entry);
      return;
    }
    // Executes against the account this order was reviewed under; refused if it is no longer active.
    const result = addLedgerEntry(entry, ledger.accountId);
    setReview(null);
    if (result.ok) {
      setQtyRaw("");
      setNotice({
        kind: "ok",
        text: `Simulated ${entry.side.toUpperCase()} recorded in ${accountDef.name}: ${entry.quantity.toLocaleString("en-US")} ${entry.ticker} @ ${money(entry.price)} (close of ${entry.priceDate}).`,
      });
    } else {
      setNotice({ kind: "error", text: result.error });
    }
  }

  return (
    <section
      aria-label="Order module"
      className={`flex w-full flex-col gap-5 rounded-2xl border bg-zinc-900/60 p-5 sm:p-6 ${
        live || lockReason ? "border-2 border-amber-500" : "border-zinc-700"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex flex-wrap items-center gap-3 text-lg font-bold uppercase tracking-wider text-white">
          {live ? (
            <span className="text-amber-300">Order · LIVE · Real cash</span>
          ) : lockReason ? (
            <span className="text-amber-300">Order · LIVE · Locked</span>
          ) : (
            <span>Order · Simulated · {accountDef.name}</span>
          )}
          <span
            data-testid="order-mode"
            className={`rounded-md px-2 py-1 text-xs font-black tracking-widest ${
              live ? "bg-amber-400 text-zinc-950" : lockReason ? "bg-zinc-700 text-amber-200" : "bg-zinc-700 text-slate-200"
            }`}
          >
            {live ? "MODE: LIVE REAL CASH" : lockReason ? "MODE: LIVE · ORDERS LOCKED" : "MODE: SIMULATED"}
          </span>
        </h2>
        {gearMeta ? (
          <span className={`text-lg font-black ${gearMeta.text}`}>
            Active gear: {gearMeta.display} {gearMeta.label}
          </span>
        ) : (
          <span className="text-base font-semibold text-slate-300">No active gear</span>
        )}
      </div>

      {lockReason ? (
        <p role="alert" className="rounded-xl border-2 border-amber-500 bg-zinc-950/60 p-3 text-sm font-semibold text-amber-200">
          {lockReason}
        </p>
      ) : null}
      {live ? (
        <p role="status" className="rounded-xl border-2 border-amber-400 bg-amber-950/40 p-3 text-sm font-semibold text-amber-200">
          LIVE mode: Review Order then Confirm sends a real market buy to your Alpaca account. Long only, watchlist stocks only,
          real cash is unlevered, and the server sizes it with the live risk limits (it may send fewer shares than you ask for).
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ticker.onAnalyze();
        }}
        className="flex flex-col gap-2"
        noValidate
      >
        <label htmlFor="order-ticker" className={labelCls}>
          Stock Ticker
        </label>
        <div className="flex gap-2">
          <input
            id="order-ticker"
            type="text"
            value={ticker.value}
            onChange={(e) => {
              setNotice(null);
              ticker.onChange(e.target.value);
            }}
            placeholder="Ticker, e.g. NVDA"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={8}
            className={`${fieldCls} min-w-0 flex-1 font-mono uppercase placeholder:normal-case`}
          />
          <button
            type="submit"
            disabled={ticker.loading || ticker.value.trim() === ""}
            className="rounded-lg bg-zinc-100 px-5 py-3 text-base font-semibold text-zinc-900 transition-opacity hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {ticker.loading ? "Loading…" : "Analyze"}
          </button>
        </div>
        <span className="text-sm text-slate-400">
          {fieldState === "pending"
            ? analyzed
              ? `Press Analyze to load ${ticker.value.trim().toUpperCase()}. Orders stay locked until it is analyzed (the loaded ticker is ${analyzed.ticker}).`
              : `Press Analyze to load ${ticker.value.trim().toUpperCase()}. Orders stay locked until it is analyzed.`
            : fieldState === "invalid"
              ? "Enter a valid stock ticker (1-5 letters, e.g. NVDA, TSLA, SPY)."
              : "Analyze loads the daily bars and the gear for this ticker, and the order below uses it."}
        </span>
      </form>

      <form onSubmit={onReview} className="flex flex-col gap-5" noValidate>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="order-type" className={labelCls}>
              Order Type
            </label>
            <select
              id="order-type"
              value={side}
              onChange={(e) => {
                setNotice(null);
                setSide(isOrderSide(e.target.value) ? e.target.value : "");
              }}
              className={fieldCls}
            >
              <option value="">Select…</option>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="order-qty" className={labelCls}>
              Quantity (shares)
            </label>
            <input
              id="order-qty"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={qtyRaw}
              onChange={(e) => {
                setNotice(null);
                setQtyRaw(e.target.value);
              }}
              placeholder="e.g. 10"
              className={`${fieldCls} font-mono`}
            />
          </div>
        </div>

        {/* Guardrail output */}
        {guard.state === "blocked-neutral" && (
          <div
            role="alert"
            className="rounded-xl border-4 border-orange-300 bg-orange-500 p-5 text-xl font-black leading-snug text-zinc-950 sm:text-2xl"
          >
            {guard.message}
          </div>
        )}
        {guard.state === "opposed" && (
          <div
            role="alert"
            className="rounded-xl border-4 border-red-300 bg-red-600 p-5 text-xl font-black leading-snug text-white sm:text-2xl"
          >
            ⚠ {guard.message}
          </div>
        )}
        {guard.state === "no-data" && (
          <p className="rounded-xl border border-zinc-600 bg-zinc-950/60 p-4 text-base font-medium text-slate-200">
            No order can be placed until a ticker has been analyzed. Orders stay locked until the
            engine reports a gear.
          </p>
        )}
        {guard.state === "insufficient-history" && (
          <p className="rounded-xl border border-zinc-600 bg-zinc-950/60 p-4 text-base font-medium text-slate-200">
            Not enough price history for this ticker to set the Noise Floor, so the engine has no
            gear. Orders are locked.
          </p>
        )}
        {guard.state === "select-type" && (
          <p className="rounded-xl border border-zinc-600 bg-zinc-950/60 p-4 text-base font-medium text-slate-200">
            Select Long or Short. It will be checked against the active gear immediately.
          </p>
        )}
        {guard.state === "aligned" && (
          <p
            role="status"
            className="rounded-xl border-2 border-green-500 bg-green-950/50 p-4 text-base font-semibold text-green-200"
          >
            Aligned: {side === "long" ? "Long" : "Short"} matches the active{" "}
            {gearMeta?.label} gear.
          </p>
        )}

        {guard.canSubmit && liveShort && (
          <p role="alert" className="rounded-xl border-2 border-orange-400 bg-orange-950/60 p-4 text-lg font-bold text-orange-200">
            Short is not supported in LIVE mode: the live account is long only (real cash, no shorting). Choose Long.
          </p>
        )}
        {guard.canSubmit && offWatchlist && (
          <p role="alert" className="rounded-xl border-2 border-orange-400 bg-orange-950/60 p-4 text-lg font-bold text-orange-200">
            {analysis?.ticker} is not on the live watchlist (POLARITO_LIVE_WATCHLIST: {liveWatchlist.join(", ")}). No live order can be sent for it.
          </p>
        )}

        {guard.canSubmit && !openCheck.ok && (
          <p
            role="alert"
            className="rounded-xl border-2 border-orange-400 bg-orange-950/60 p-4 text-lg font-bold text-orange-200"
          >
            {openCheck.error}
          </p>
        )}

        {guard.canSubmit && qtyRaw.trim() !== "" && !qty.ok && (
          <p role="alert" className="text-base font-semibold text-red-300">
            {qty.error}
          </p>
        )}
        {guard.canSubmit && lockReason === null && qty.ok && !hasFunds && (
          <p role="alert" className="text-base font-semibold text-red-300">
            Order of {money(notional)} exceeds {live ? "live account" : accountDef.name} cash available ({money(cashLimit)}).
          </p>
        )}

        <button
          type="submit"
          disabled={!canReview}
          className="h-16 w-full rounded-xl bg-white text-xl font-black uppercase tracking-wider text-zinc-950 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          Review Order
        </button>
      </form>

      {/* Review step */}
      {activeReview && (
        <div
          role="dialog"
          aria-label={live ? "Review LIVE order" : "Review simulated order"}
          className={`flex flex-col gap-4 rounded-xl border-2 bg-zinc-950 p-5 ${live ? "border-amber-400" : "border-white"}`}
        >
          <h3 className="text-lg font-black uppercase tracking-wider text-white">
            {live ? "Confirm LIVE order (real cash)" : "Confirm simulated order"}
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-lg">
            <dt className="text-slate-300">Account</dt>
            <dd className="font-bold text-white">{live ? "Alpaca LIVE account" : accountDef.name}</dd>
            <dt className="text-slate-300">Ticker</dt>
            <dd className="font-mono font-bold text-white">{activeReview.ticker}</dd>
            <dt className="text-slate-300">Side</dt>
            <dd className="font-bold uppercase text-white">{activeReview.side}</dd>
            <dt className="text-slate-300">Quantity</dt>
            <dd className="font-mono font-bold text-white">
              {activeReview.quantity.toLocaleString("en-US")}
            </dd>
            <dt className="text-slate-300">{live ? "Reference price" : "Simulated price"}</dt>
            <dd className="font-mono font-bold text-white">
              {money(activeReview.price)}{" "}
              <span className="text-sm font-medium text-slate-400">
                (close of {activeReview.priceDate})
              </span>
            </dd>
            <dt className="text-slate-300">Notional</dt>
            <dd className="font-mono font-bold text-white">{money(activeReview.notional)}</dd>
          </dl>
          <p className="text-sm text-slate-400">
            {live
              ? "REAL ORDER. Confirm sends a market buy to your live Alpaca account. The price shown is the last daily close, not the fill; the server may send fewer shares than asked under the risk limits, and it says exactly what was sent."
              : "Simulation only. No broker is contacted and no real order is placed. The price is the last daily close, not a live fill."}
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onConfirm}
              className={`h-14 flex-1 rounded-xl text-lg font-black uppercase tracking-wider text-zinc-950 focus:outline-none focus-visible:ring-4 ${
                live ? "bg-amber-400 hover:bg-amber-300 focus-visible:ring-amber-200" : "bg-green-500 hover:bg-green-400 focus-visible:ring-green-300"
              }`}
            >
              {live ? "Confirm LIVE order" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setReview(null)}
              className="h-14 rounded-xl px-6 text-lg font-bold text-white ring-2 ring-zinc-500 hover:ring-white focus:outline-none focus-visible:ring-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-xl p-4 text-base font-semibold ${
            notice.kind === "ok"
              ? "border-2 border-green-500 bg-green-950/50 text-green-200"
              : notice.kind === "wait"
                ? "border-2 border-amber-500 bg-amber-950/40 text-amber-200"
                : "border-2 border-red-500 bg-red-950/50 text-red-200"
          }`}
        >
          {notice.text}
        </p>
      )}

      <LiveAccountPanel feed={feed} />
    </section>
  );
}
