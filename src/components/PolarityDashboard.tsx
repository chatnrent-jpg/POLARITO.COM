"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import AccountSelector from "@/components/AccountSelector";
import LedgerPanel, { type CurrentMark } from "@/components/LedgerPanel";
import LogoutButton from "@/components/LogoutButton";
import PageRefresher from "@/components/PageRefresher";
import OrderModule, { type OrderAnalysis } from "@/components/OrderModule";
import PolarityChart from "@/components/PolarityChart";
import PremiumGate from "@/components/PremiumGate";
import Transmission from "@/components/Transmission";
import { getServerTier, getTier, subscribeTier, togglePremiumStatus } from "@/lib/billingGate";
import { loadBars } from "@/lib/barsClient";
import {
  getServerDraft,
  readAnalyzed,
  readDraft,
  saveAnalyzed,
  saveDraft,
  subscribeDraft,
} from "@/lib/refreshMemory";
import {
  getActiveAccountId,
  getServerActiveAccountId,
  subscribeAccounts,
} from "@/lib/multiAccount";
import {
  computePolaritySeries,
  latestResult,
  metaFor,
  NOISE_FLOOR_RATIO,
  VOLUME_MA_WINDOW,
  type DayResult,
} from "@/lib/polarity";
import {
  sentimentMeta,
  type SentimentByDate,
  type SentimentDay,
} from "@/lib/sentimentEngine";

/**
 * Data flow (one direction only):
 *   ticker (form) -> loadBars -> /api/bars -> Alpaca daily bars
 *     -> computePolaritySeries -> DayResult[]
 *       -> latestResult.polarity -> <Transmission/>
 *       -> DayResult[]           -> <PolarityChart/>
 *   same payload also carries LIVE news-keyword sentiment (by date)
 *       -> <PolarityChart/> overlay line and the Crowd Sentiment card.
 *       It never feeds Transmission or the order gate, and a missing day is 0.
 *
 * Any failure (bad ticker, rate limit, network, malformed data) clears the
 * results and holds the Transmission in Neutral with the error on screen.
 * While loading, the previous ticker's state is cleared so one ticker's
 * result is never shown under another's name.
 */
type View =
  | { status: "idle" }
  | { status: "loading"; ticker: string }
  | { status: "error"; message: string }
  | { status: "ready"; ticker: string; results: DayResult[]; sentiment: SentimentByDate };

const fmt = (n: number) =>
  Math.round(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-zinc-950/60 px-4 py-3 ring-1 ring-zinc-700">
      <span className="text-sm font-semibold uppercase tracking-wide text-slate-300">{label}</span>
      <span className={`font-mono text-xl font-bold tabular-nums ${tone ?? "text-white"}`}>
        {value}
      </span>
    </div>
  );
}

export default function PolarityDashboard() {
  const input = useSyncExternalStore(subscribeDraft, readDraft, getServerDraft);
  const [view, setView] = useState<View>({ status: "idle" });
  const inFlight = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const tier = useSyncExternalStore(subscribeTier, getTier, getServerTier);
  const [tierError, setTierError] = useState<string | null>(null);
  // Active account: orders, closes and the ledger below all follow this one id.
  const accountId = useSyncExternalStore(
    subscribeAccounts,
    getActiveAccountId,
    getServerActiveAccountId,
  );

  useEffect(() => () => inFlight.current?.abort(), []);

  async function analyze(raw: string, silent = false) {
    // Newest request wins; cancel any older one.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    busy.current = true;

    // A silent refresh keeps the current results on screen until fresh ones arrive.
    if (!silent) setView({ status: "loading", ticker: raw.trim().toUpperCase() });
    try {
      const { ticker, bars, sentiment } = await loadBars(raw, controller.signal);
      const results = computePolaritySeries(bars);
      if (controller.signal.aborted) return;
      setView({ status: "ready", ticker, results, sentiment });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (silent) return; // a failed background refresh must not wipe good results
      setView({
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error.",
      });
    } finally {
      if (inFlight.current === controller) busy.current = false;
    }
  }

  // Every 5s: re-fetch the last analyzed ticker in place, unless a request is already running.
  function refreshInPlace() {
    const analyzed = readAnalyzed();
    if (!analyzed || busy.current) return;
    void analyze(analyzed, true);
  }

  // Restore the last analyzed ticker if the page was reloaded by hand.
  useEffect(() => {
    const analyzed = readAnalyzed();
    if (!analyzed) return;
    const t = setTimeout(() => void analyze(analyzed), 0);
    return () => clearTimeout(t);
  }, []);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    saveAnalyzed(input.trim().toUpperCase());
    void analyze(input);
  }

  const results = view.status === "ready" ? view.results : null;
  const latest = results ? latestResult(results) : null;
  const polarity = latest ? latest.polarity : 0; // anything but a clean result => Neutral
  const meta = metaFor(polarity);
  const loading = view.status === "loading";

  // Latest day's crowd sentiment. Missing => Neutral, flagged as defaulted.
  const sentimentDay: SentimentDay | null =
    view.status === "ready" && latest ? (view.sentiment[latest.date] ?? null) : null;
  const sentMeta = sentimentMeta(sentimentDay ? sentimentDay.polarity : 0);

  // What the order gate sees. Anything but a clean, current result => null (orders locked).
  const analysis: OrderAnalysis | null =
    view.status === "ready" && latest
      ? {
          ticker: view.ticker,
          polarity: latest.polarity,
          close: latest.close,
          asOf: latest.date,
          ready: latest.ready,
        }
      : null;
  // The ticker currently loaded: the only one a position may be marked or closed against.
  const current: CurrentMark | null =
    view.status === "ready" && latest
      ? { ticker: view.ticker, close: latest.close, asOf: latest.date }
      : null;

  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center gap-10 px-4 py-10">
      <PageRefresher onRefresh={refreshInPlace} />
      <AccountSelector marks={current ? { [current.ticker]: current.close } : {}} />

      <header className="flex w-full max-w-2xl flex-col items-center gap-4">
        <div className="flex w-full items-center justify-between gap-3">
          <span className="w-20" aria-hidden="true" />
          <h1 className="text-sm font-semibold uppercase tracking-[0.4em] text-zinc-500">
            Polarito
          </h1>
          <div className="flex w-20 justify-end">
            <LogoutButton />
          </div>
        </div>
        <form onSubmit={onSubmit} className="flex w-full max-w-sm gap-2">
          <label htmlFor="ticker" className="sr-only">
            Stock ticker
          </label>
          <input
            id="ticker"
            type="text"
            value={input}
            onChange={(e) => saveDraft(e.target.value)}
            placeholder="Ticker, e.g. NVDA"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={8}
            className="min-w-0 flex-1 rounded-lg bg-zinc-900 px-3 py-2 font-mono text-sm uppercase text-zinc-100 ring-1 ring-zinc-700 placeholder:normal-case placeholder:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          />
          <button
            type="submit"
            disabled={loading || input.trim() === ""}
            className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 transition-opacity hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "Loading…" : "Analyze"}
          </button>
        </form>
        <aside
          aria-label="What Polarito shows"
          className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm leading-relaxed text-slate-300"
        >
          <p>
            <strong className="font-bold text-white">What this shows.</strong> Each day is
            classified by candle colour and weighted by volume (green = +volume, red = −volume).
            The Noise Floor ({NOISE_FLOOR_RATIO * 100}% of the {VOLUME_MA_WINDOW}-day average
            volume) hides small bars; the rest read Drive (+1) or Reverse (−1).
          </p>
          <p className="mt-2">
            <strong className="font-bold text-white">What it is not.</strong> It describes what
            the market did; it is not a forecast. On SPY itself (2016–2026, daily and 5-minute
            bars) it showed no edge that survives trading costs; results on individual stocks are
            still being researched. Orders here are simulated. Nothing on this page is investment
            advice.
          </p>
        </aside>
      </header>

      {/* Transmission + execution gate, side by side on wide screens */}
      <div className="grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex justify-center lg:px-6">
          <Transmission polarity={polarity} />
        </div>
        <OrderModule key={accountId} analysis={analysis} />
      </div>

      {view.status === "idle" && (
        <p className="text-base text-slate-300">
          Enter a ticker to load daily bars. Transmission is in Neutral until data arrives.
        </p>
      )}

      {view.status === "loading" && (
        <p role="status" className="text-base text-slate-300">
          Fetching daily bars for {view.ticker || "…"}
        </p>
      )}

      {view.status === "error" && (
        <p
          role="alert"
          className="w-full max-w-2xl rounded-xl border border-red-900 bg-red-950/40 p-4 text-base font-medium text-red-200"
        >
          {view.message} Transmission held in Neutral.
        </p>
      )}

      {view.status === "ready" && latest && (
        <>
          <p className="text-base font-medium uppercase tracking-wider text-slate-300">
            <span className="font-mono text-lg font-bold text-white">{view.ticker}</span> · as of {latest.date} ·
            Alpaca daily bars
          </p>

          {!latest.ready && (
            <p
              role="status"
              className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-base text-slate-200"
            >
              Only {view.results.length} bars available; {VOLUME_MA_WINDOW} are needed to set the
              Noise Floor. Held in Neutral.
            </p>
          )}

          <div className="grid w-full max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Net volume"
              value={signed(latest.netVolume)}
              tone={polarity === 0 ? "text-white" : meta.text}
            />
            <Stat label="Candle" value={latest.kind.toUpperCase()} />
            <Stat
              label={`${VOLUME_MA_WINDOW}d avg volume`}
              value={latest.avgVolume === null ? "n/a" : fmt(latest.avgVolume)}
            />
            <Stat
              label={`Noise floor (${NOISE_FLOOR_RATIO * 100}%)`}
              value={latest.noiseFloor === null ? "n/a" : `±${fmt(latest.noiseFloor)}`}
            />
          </div>

          {/* Crowd Sentiment (live news keywords): a news-text reading shown beside Net Volume. Informational; not validated as a predictor. */}
          <PremiumGate>
            <section
              aria-label="Crowd sentiment"
              className="flex w-full max-w-2xl flex-col gap-2 rounded-xl border-l-8 bg-zinc-950/60 px-5 py-4 ring-1 ring-zinc-700"
              style={{ borderLeftColor: "#c026ff" }}
            >
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Crowd Sentiment
                </h3>
                {sentimentDay?.source === "news" ? (
                  <span className="rounded bg-green-400 px-1.5 py-0.5 text-xs font-extrabold uppercase text-zinc-900">
                    Live news
                  </span>
                ) : (
                  <span className="rounded bg-amber-400 px-1.5 py-0.5 text-xs font-extrabold uppercase text-zinc-900">
                    News unavailable
                  </span>
                )}
              </div>
              <span
                className={`text-4xl font-black tracking-tight sm:text-5xl ${sentMeta.text}`}
                aria-label={`Crowd sentiment ${sentMeta.label} ${sentMeta.display}`}
              >
                {sentMeta.label} ({sentMeta.display})
              </span>
              <span className="text-base text-slate-300">
                {sentimentDay?.source === "news"
                  ? `${latest.date} · text velocity ${sentimentDay.velocity >= 0 ? "+" : "−"}${Math.abs(
                      sentimentDay.velocity,
                    ).toFixed(2)} · ${fmt(sentimentDay.positiveHits)} bullish vs ${fmt(
                      sentimentDay.negativeHits,
                    )} bearish headline keywords across ${fmt(sentimentDay.articles)} article${
                      sentimentDay.articles === 1 ? "" : "s"
                    }`
                  : "No live news reading for this day (feed error, rate limit, or older than the news window). Defaulted to Neutral."}
              </span>
            </section>
          </PremiumGate>

          <PolarityChart results={view.results} sentiment={view.sentiment} />
        </>
      )}

      <div className="w-full max-w-5xl">
        <LedgerPanel key={accountId} current={current} />
      </div>

      {/* Dev-only: stands in for the Stripe webhook. Remove or hide before launch. */}
      {process.env.NEXT_PUBLIC_HIDE_DEV_TOOLS !== "1" && (
        <footer className="flex w-full max-w-5xl flex-col items-center gap-2 border-t border-zinc-800 pt-6">
          <button
            type="button"
            onClick={() => {
              const result = togglePremiumStatus();
              setTierError(result.ok ? null : result.error);
            }}
            className="text-base font-semibold text-slate-300 underline underline-offset-4 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            [Dev Mode: Toggle Premium Tier]
          </button>
          <span className="text-sm text-slate-400">
            Current tier: <strong className="font-bold text-white">{tier}</strong>
          </span>
          {tierError && (
            <p role="alert" className="text-base font-semibold text-red-300">
              {tierError}
            </p>
          )}
        </footer>
      )}
    </div>
  );
}
