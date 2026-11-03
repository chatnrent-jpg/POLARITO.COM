"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
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
 */
export default function OrderModule({ analysis }: { analysis: OrderAnalysis | null }) {
  const [side, setSide] = useState<OrderSide | "">("");
  const [qtyRaw, setQtyRaw] = useState("");
  const [review, setReview] = useState<{ key: string; entry: LedgerEntry } | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

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
  const hasFunds = qty.ok && notional <= account.cashAvailable;
  // No simultaneous long and short on one ticker.
  const openCheck =
    analysis && isOrderSide(side) ? canOpen(ledger, analysis.ticker, side) : { ok: true as const };

  const canReview = guard.canSubmit && openCheck.ok && qty.ok && hasFunds && price > 0;

  // A review only counts while every input it was built from is unchanged.
  const key = `${ledger.accountId}|${analysis?.ticker}|${analysis?.polarity}|${analysis?.asOf}|${side}|${qtyRaw.trim()}`;
  const activeReview = review && review.key === key ? review.entry : null;

  const gearMeta = analysis && analysis.ready ? metaFor(analysis.polarity) : null;

  function buildEntry(): LedgerEntry | null {
    // Re-validate from scratch; never trust that the button state was honest.
    if (!analysis || !isOrderSide(side)) return null;
    const g = evaluateGuard(analysis, side);
    const q = validateQuantity(qtyRaw);
    if (!g.canSubmit || !q.ok || analysis.close <= 0) return null;
    if (!canOpen(ledger, analysis.ticker, side).ok) return null;
    if (analysis.polarity !== 1 && analysis.polarity !== -1) return null;
    const total = q.qty * analysis.close;
    if (total > account.cashAvailable) return null;
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

  function onConfirm() {
    const entry = buildEntry();
    if (!entry || !activeReview) {
      setReview(null);
      setNotice({ kind: "error", text: "Order no longer passes the safety gate. Nothing was recorded." });
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
      className="flex w-full flex-col gap-5 rounded-2xl border border-zinc-700 bg-zinc-900/60 p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold uppercase tracking-wider text-white">
          Order · Simulated · {accountDef.name}
        </h2>
        {gearMeta ? (
          <span className={`text-lg font-black ${gearMeta.text}`}>
            Active gear: {gearMeta.display} {gearMeta.label}
          </span>
        ) : (
          <span className="text-base font-semibold text-slate-300">No active gear</span>
        )}
      </div>

      <form onSubmit={onReview} className="flex flex-col gap-5" noValidate>
        <div className="flex flex-col gap-2">
          <label htmlFor="order-ticker" className={labelCls}>
            Stock Ticker
          </label>
          <input
            id="order-ticker"
            type="text"
            value={analysis?.ticker ?? ""}
            readOnly
            aria-readonly="true"
            placeholder="Analyze a ticker above"
            className={`${fieldCls} cursor-not-allowed font-mono uppercase`}
          />
          <span className="text-sm text-slate-400">
            Filled from the main page selection. Orders are only allowed on the analyzed ticker.
          </span>
        </div>

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
        {guard.canSubmit && qty.ok && !hasFunds && (
          <p role="alert" className="text-base font-semibold text-red-300">
            Order of {money(notional)} exceeds {accountDef.name} cash available ({money(account.cashAvailable)}).
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
          aria-label="Review simulated order"
          className="flex flex-col gap-4 rounded-xl border-2 border-white bg-zinc-950 p-5"
        >
          <h3 className="text-lg font-black uppercase tracking-wider text-white">
            Confirm simulated order
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-lg">
            <dt className="text-slate-300">Account</dt>
            <dd className="font-bold text-white">{accountDef.name}</dd>
            <dt className="text-slate-300">Ticker</dt>
            <dd className="font-mono font-bold text-white">{activeReview.ticker}</dd>
            <dt className="text-slate-300">Side</dt>
            <dd className="font-bold uppercase text-white">{activeReview.side}</dd>
            <dt className="text-slate-300">Quantity</dt>
            <dd className="font-mono font-bold text-white">
              {activeReview.quantity.toLocaleString("en-US")}
            </dd>
            <dt className="text-slate-300">Simulated price</dt>
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
            Simulation only. No broker is contacted and no real order is placed. The price is the
            last daily close, not a live fill.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onConfirm}
              className="h-14 flex-1 rounded-xl bg-green-500 text-lg font-black uppercase tracking-wider text-zinc-950 hover:bg-green-400 focus:outline-none focus-visible:ring-4 focus-visible:ring-green-300"
            >
              Confirm
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
              : "border-2 border-red-500 bg-red-950/50 text-red-200"
          }`}
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}
