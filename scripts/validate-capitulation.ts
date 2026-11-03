/**
 * Out-of-sample replication of the one lead from the floor study:
 *
 *   "Capitulation fade": after a RED day on volume > 1.5x the 20-day average
 *   (Reverse at a 1.5x floor), BUY the next open and sell that day's close.
 *
 *   npm run validate-capitulation
 *
 * The spec below is FROZEN. Nothing is tuned here. It is run on tickers that
 * were never part of the discovery universe (SPY/QQQ/IWM/AAPL/MSFT/NVDA/AMZN/
 * GOOGL/META/TSLA/AMD/JPM/XOM), so this is a replication, not a re-fit.
 *
 * PRE-REGISTERED PASS CHECKS (all must hold, evaluated on the new STOCKS group):
 *   FADE EDGE = -(event-study edge of the Reverse bucket) = how much MORE than a
 *   normal day the stock rises after the signal. Positive means the fade profits.
 *   (The first version of checks 1-2 tested the raw edge > 0, a sign-convention
 *   bug that contradicted the strategy; fixed and disclosed in the report.)
 *   1. Fade edge > 0 and two-sided permutation p < 0.05 for the 1D event study.
 *   2. Fade edge > 0 in BOTH periods: before SPLIT and from SPLIT onward.
 *   3. Net expectancy per trade > 0 after COST_BPS per side.
 *   4. Still > 0 when costs are doubled (2 x COST_BPS per side).
 *   5. Breadth: more than half of tickers with >= MIN_TICKER_TRADES trades are
 *      net profitable, and expectancy stays > 0 after removing the best ticker.
 * Sensitivity (nearby floors, cost levels) and ETFs are reported but cannot
 * rescue a failed check, and nothing is re-picked after seeing results.
 */
import fs from "node:fs";
import path from "node:path";
import { type Bar } from "../src/lib/polarity";
import { loadBars } from "./alpacaHistory";
import {
  buyHoldSeries,
  collectObservations,
  equalWeightPortfolio,
  eventStudy,
  perfMetrics,
  runStrategy,
  tradeMetrics,
  windowSeries,
  type EventStats,
  type StrategyConfig,
  type Trade,
} from "../src/lib/backtester";

/* ---------------- frozen spec ---------------- */
const RATIO = 1.5;
const HOLD_DAYS = 1;
const COST_BPS = 5;
const SPLIT = "2023-01-01";
const START = "2016-01-04";
const PERMUTATIONS = 5000;
const MIN_TICKER_TRADES = 10;
const SEED = 777;

const STOCKS = [
  "KO", "PEP", "WMT", "HD", "UNH", "JNJ", "PG", "V", "MA", "BAC", "WFC", "GS", "CVX", "COP",
  "CAT", "DE", "BA", "GE", "INTC", "CSCO", "ORCL", "CRM", "ADBE", "NFLX", "DIS", "NKE", "MCD",
  "SBUX", "COST", "LLY", "PFE", "MRK", "ABBV", "T", "VZ", "QCOM", "TXN", "AVGO", "MU",
];
const ETFS = ["DIA", "XLF", "XLE", "XLK", "XLV", "GLD"];
const SENSITIVITY_RATIOS = [1.25, 1.5, 1.75, 2.0];
/* --------------------------------------------- */

const ROOT = path.resolve(__dirname, "..");
const pct = (x: number, d = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
const num = (x: number | null, d = 2) => (x !== null && Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pv = (x: number | null) => (x === null ? "-" : x < 0.001 ? "<0.001" : x.toFixed(3));
const mdTable = (head: string[], rows: string[][]) => {
  const l = (c: string[]) => `| ${c.join(" | ")} |`;
  return [l(head), l(head.map(() => "---")), ...rows.map(l)].join("\n");
};

/** Positive = the stock rises more than an average day after a Reverse signal. */
const fadeEdge = (e: EventStats) => -e.edge;

const cfg = (costBps: number): StrategyConfig => ({
  name: "Capitulation fade (Reverse 1D @ 1.5x, long)",
  holdDays: HOLD_DAYS,
  allowShort: false,
  costBps,
  noiseFloorRatio: RATIO,
  invert: true,
  sides: "reverse",
});

async function loadGroup(tickers: string[], end: string): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  for (const t of tickers) {
    try {
      const { bars } = await loadBars(t, { feed: "sip", start: START, refresh: false }, end);
      out.set(t, bars);
    } catch (e) {
      console.warn(`  ${t} SKIPPED - ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }
  return out;
}

type Period = "all" | "pre" | "post";
const inPeriod = (d: string, p: Period) => (p === "all" ? true : p === "pre" ? d < SPLIT : d >= SPLIT);

function reverse1D(data: Map<string, Bar[]>, ratio: number, period: Period, perms: number): EventStats {
  const obs = [];
  for (const [t, bars] of data) {
    obs.push(...collectObservations(t, bars, { noiseFloorRatio: ratio }).filter((o) => inPeriod(o.date, period)));
  }
  const st = eventStudy(obs, { permutations: perms, seed: SEED });
  return st.find((s) => s.polarity === -1 && s.horizon === 1 && s.entry === "nextOpen")!;
}

function strategyRun(data: Map<string, Bar[]>, costBps: number, period: Period) {
  const per = [...data.entries()].map(([t, b]) => ({ t, r: runStrategy(b, cfg(costBps)) }));
  const win = (d: string) => inPeriod(d, period);
  const blend = equalWeightPortfolio(
    per.map(({ r }) => {
      const dates: string[] = [];
      const returns: number[] = [];
      r.dates.forEach((d, i) => {
        if (win(d)) {
          dates.push(d);
          returns.push(r.returns[i]);
        }
      });
      return { dates, returns };
    }),
  );
  const trades: Trade[] = per.flatMap(({ r }) => r.trades.filter((tr) => win(tr.entryDate)));
  const byTicker = per.map(({ t, r }) => {
    const tr = r.trades.filter((x) => win(x.entryDate));
    return { ticker: t, n: tr.length, sum: tr.reduce((s, x) => s + x.returnPct, 0) };
  });
  return { perf: perfMetrics(blend.returns), trade: tradeMetrics(trades), trades, byTicker };
}

function concentration(byTicker: { ticker: string; n: number; sum: number }[]) {
  const eligible = byTicker.filter((x) => x.n >= MIN_TICKER_TRADES);
  const totalN = byTicker.reduce((s, x) => s + x.n, 0);
  const totalSum = byTicker.reduce((s, x) => s + x.sum, 0);
  const best = [...byTicker].sort((a, b) => b.sum - a.sum)[0];
  const looN = totalN - best.n;
  return {
    eligible: eligible.length,
    profitable: eligible.filter((x) => x.sum > 0).length,
    best: best.ticker,
    bestShare: totalSum > 0 ? best.sum / totalSum : NaN,
    expectancyWithoutBest: looN ? (totalSum - best.sum) / looN : NaN,
  };
}

async function main() {
  const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  console.log(`Capitulation replication | ${STOCKS.length} new stocks + ${ETFS.length} ETFs | split ${SPLIT}`);
  const stocks = await loadGroup(STOCKS, end);
  const etfs = await loadGroup(ETFS, end);
  if (stocks.size < 10) {
    console.error(`Only ${stocks.size} stocks loaded; refusing to draw conclusions.`);
    process.exit(1);
  }
  console.log(`  loaded ${stocks.size} stocks, ${etfs.size} ETFs`);

  /* 1) event study, frozen spec, stocks */
  const evAll = reverse1D(stocks, RATIO, "all", PERMUTATIONS);
  const evPre = reverse1D(stocks, RATIO, "pre", PERMUTATIONS);
  const evPost = reverse1D(stocks, RATIO, "post", PERMUTATIONS);
  const evEtf = etfs.size ? reverse1D(etfs, RATIO, "all", PERMUTATIONS) : null;

  /* 2) strategy, stocks */
  const s5 = strategyRun(stocks, COST_BPS, "all");
  const s10 = strategyRun(stocks, COST_BPS * 2, "all");
  const s20 = strategyRun(stocks, COST_BPS * 4, "all");
  const sPre = strategyRun(stocks, COST_BPS, "pre");
  const sPost = strategyRun(stocks, COST_BPS, "post");
  const conc = concentration(s5.byTicker);
  const bhBlend = (p: Period) =>
    perfMetrics(
      equalWeightPortfolio(
        [...stocks.values()].map((b) => {
          const s = buyHoldSeries(b);
          const dates: string[] = [];
          const returns: number[] = [];
          s.dates.forEach((d, i) => {
            if (inPeriod(d, p)) {
              dates.push(d);
              returns.push(s.returns[i]);
            }
          });
          return { dates, returns };
        }),
      ).returns,
    );

  /* 3) checks */
  const checks: { name: string; pass: boolean; detail: string }[] = [
    {
      name: "1. Fade edge > 0 and p < 0.05 (all years)",
      pass: fadeEdge(evAll) > 0 && evAll.pValue !== null && evAll.pValue < 0.05,
      detail: `fade edge ${pct(fadeEdge(evAll), 3)}, p ${pv(evAll.pValue)}, n ${evAll.n}`,
    },
    {
      name: "2. Fade edge > 0 in both periods",
      pass: fadeEdge(evPre) > 0 && fadeEdge(evPost) > 0,
      detail: `pre-${SPLIT.slice(0, 4)} ${pct(fadeEdge(evPre), 3)} (n ${evPre.n}); ${SPLIT.slice(0, 4)}+ ${pct(fadeEdge(evPost), 3)} (n ${evPost.n})`,
    },
    {
      name: `3. Net expectancy > 0 at ${COST_BPS} bps/side`,
      pass: s5.trade.expectancy > 0,
      detail: `${pct(s5.trade.expectancy, 3)} per trade over ${s5.trade.trades} trades`,
    },
    {
      name: `4. Net expectancy > 0 at ${COST_BPS * 2} bps/side (costs doubled)`,
      pass: s10.trade.expectancy > 0,
      detail: `${pct(s10.trade.expectancy, 3)} per trade`,
    },
    {
      name: "5. Breadth: >half of tickers profitable and positive without best ticker",
      pass: conc.profitable > conc.eligible / 2 && conc.expectancyWithoutBest > 0,
      detail: `${conc.profitable} of ${conc.eligible} tickers profitable; best ${conc.best} (${pct(conc.bestShare, 0)} of P&L); without best ${pct(conc.expectancyWithoutBest, 3)}`,
    },
  ];
  const passAll = checks.every((c) => c.pass);
  const edgeReal = checks[0].pass && checks[1].pass;
  const failed = checks.filter((c) => !c.pass).map((c) => c.name).join("; ");
  const verdict = passAll
    ? `REPLICATED. The capitulation fade held on ${stocks.size} names it was never fitted to, in both periods, after costs, and after doubling costs. Still a lead for forward testing, not proof.`
    : edgeReal
      ? `EDGE IS REAL BUT NOT ROBUSTLY TRADEABLE. The fade direction replicated out-of-sample in both periods, but it failed: ${failed}. The effect is about the size of round-trip costs on typical stocks, so it does not clear the bar.`
      : `NOT REPLICATED. Failed: ${failed}. Do not build on this.`;

  /* 4) sensitivity: nearby floors on the new stocks (report only) */
  const sens = SENSITIVITY_RATIOS.map((r) => {
    const pre = reverse1D(stocks, r, "pre", 1000);
    const post = reverse1D(stocks, r, "post", 1000);
    return { ratio: r, pre, post };
  });

  /* 5) by year (trade entry year), net of costs */
  const byYear = new Map<string, { n: number; sum: number }>();
  for (const t of s5.trades) {
    const y = t.entryDate.slice(0, 4);
    const c = byYear.get(y) ?? { n: 0, sum: 0 };
    c.n++;
    c.sum += t.returnPct;
    byYear.set(y, c);
  }

  /* report */
  const md: string[] = [];
  md.push(`# Capitulation fade: out-of-sample replication`);
  md.push(
    `Generated ${new Date().toISOString().slice(0, 10)} | feed \`sip\` | ${stocks.size} stocks never used in discovery | ` +
      `rule: Reverse day (red candle) on volume > ${RATIO}x 20-day avg -> buy next open, sell that close | cost ${COST_BPS} bps/side | ${PERMUTATIONS} permutations`,
  );
  md.push(`\n**Verdict:** ${verdict}`);
  md.push(`\n## Pre-registered checks (new stocks)`);
  md.push(mdTable(["Check", "Result", "Detail"], checks.map((c) => [c.name, c.pass ? "PASS" : "FAIL", c.detail])));

  md.push(`\n## 1. Event study (1D, next-open entry; FADE edge = how much more than an average day the stock rises after a Reverse signal)`);
  const evRow = (label: string, e: EventStats) => [label, String(e.n), pct(e.meanRaw, 3), pct(fadeEdge(e), 3), pct(1 - e.hitRate, 1), num(-e.tStat), pv(e.pValue)];
  md.push(
    mdTable(
      ["Group / period", "n", "Mean next-day return", "Fade edge", "Next-day up", "t-stat (fade)", "p-value"],
      [
        evRow("New stocks, all years", evAll),
        evRow(`New stocks, before ${SPLIT.slice(0, 4)}`, evPre),
        evRow(`New stocks, ${SPLIT.slice(0, 4)}+`, evPost),
        ...(evEtf ? [evRow("ETFs (DIA, XLF, XLE, XLK, XLV, GLD), all years", evEtf)] : []),
      ],
    ),
  );

  md.push(`\n## 2. Tradeable? (equal-weight portfolio of new stocks, net of costs)`);
  const bh = bhBlend("all");
  const stratRow = (label: string, s: ReturnType<typeof strategyRun>) => [
    label, pct(s.perf.totalReturn, 1), pct(s.perf.cagr, 1), num(s.perf.sharpe), pct(s.perf.maxDrawdown, 1),
    String(s.trade.trades), pct(s.trade.winRate, 1), pct(s.trade.expectancy, 3), num(s.trade.profitFactor),
  ];
  md.push(
    mdTable(
      ["Scenario", "Total", "CAGR", "Sharpe", "Max DD", "Trades", "Win rate", "Expectancy/trade", "Profit factor"],
      [
        ["Buy & hold, same stocks (all years)", pct(bh.totalReturn, 1), pct(bh.cagr, 1), num(bh.sharpe), pct(bh.maxDrawdown, 1), "-", "-", "-", "-"],
        stratRow(`Fade @ ${COST_BPS} bps/side`, s5),
        stratRow(`Fade @ ${COST_BPS * 2} bps/side`, s10),
        stratRow(`Fade @ ${COST_BPS * 4} bps/side`, s20),
        stratRow(`Fade @ ${COST_BPS} bps, before ${SPLIT.slice(0, 4)}`, sPre),
        stratRow(`Fade @ ${COST_BPS} bps, ${SPLIT.slice(0, 4)}+`, sPost),
      ],
    ),
  );
  md.push(`\nPortfolio returns are averaged across ALL tickers each day, so total return looks small: capital is idle most days. Expectancy per trade is the cleaner figure.`);

  md.push(`\n## 3. Breadth and by-year stability (net of ${COST_BPS} bps)`);
  md.push(
    mdTable(
      ["Year", "Trades", "Net expectancy/trade"],
      [...byYear.entries()].sort().map(([y, c]) => [y, String(c.n), pct(c.sum / c.n, 3)]),
    ),
  );

  md.push(`\n## 4. Sensitivity: nearby floors (report only; the 1.5x spec is NOT re-picked)`);
  md.push(
    mdTable(
      ["Floor", `Fade edge before ${SPLIT.slice(0, 4)}`, "p", "n", `Fade edge ${SPLIT.slice(0, 4)}+`, "p", "n"],
      sens.map((s) => [`${s.ratio}x`, pct(fadeEdge(s.pre), 3), pv(s.pre.pValue), String(s.pre.n), pct(fadeEdge(s.post), 3), pv(s.post.pValue), String(s.post.n)]),
    ),
  );
  md.push(`\nA real effect should degrade smoothly across neighbouring floors, not appear at only one value.`);

  md.push(`\n## Caveats`);
  md.push(
    [
      `- Market-wide events (March 2020, 2022 bear market) hit all tickers at once, so cross-ticker replication is not fully independent evidence.`,
      `- Survivorship bias: today's liquid names only.`,
      `- Daily-bar volume is the final consolidated total; confirm in forward testing that the live pre-open number matches (late prints can change it).`,
      `- Assumes a fill at the official next open and exit at the close, 1x notional, no short borrow (this is long-only).`,
    ].join("\n"),
  );

  fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "reports", "capitulation-validation.md"), md.join("\n") + "\n");
  fs.writeFileSync(
    path.join(ROOT, "reports", "capitulation-validation.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        spec: { RATIO, HOLD_DAYS, COST_BPS, SPLIT, PERMUTATIONS },
        tickers: { stocks: [...stocks.keys()], etfs: [...etfs.keys()] },
        verdict, checks, evAll, evPre, evPost, evEtf,
        strategy: { s5: { perf: s5.perf, trade: s5.trade }, s10: { perf: s10.perf, trade: s10.trade }, s20: { perf: s20.perf, trade: s20.trade } },
        concentration: conc, sensitivity: sens,
        byYear: Object.fromEntries(byYear),
      },
      null,
      2,
    ),
  );

  console.log(`\nVerdict: ${verdict}\n`);
  console.log(mdTable(["Check", "Result", "Detail"], checks.map((c) => [c.name, c.pass ? "PASS" : "FAIL", c.detail])));
  console.log("\n" + mdTable(["Group / period", "n", "Mean next-day return", "Fade edge", "Next-day up", "t-stat (fade)", "p-value"], [
    evRow("New stocks, all", evAll), evRow("pre", evPre), evRow("post", evPost), ...(evEtf ? [evRow("ETFs", evEtf)] : []),
  ]));
  console.log("\n" + mdTable(["Scenario", "Total", "Sharpe", "Max DD", "Trades", "Win", "Expectancy"], [
    ["Fade 5bps", pct(s5.perf.totalReturn, 1), num(s5.perf.sharpe), pct(s5.perf.maxDrawdown, 1), String(s5.trade.trades), pct(s5.trade.winRate, 1), pct(s5.trade.expectancy, 3)],
    ["Fade 10bps", pct(s10.perf.totalReturn, 1), num(s10.perf.sharpe), pct(s10.perf.maxDrawdown, 1), String(s10.trade.trades), pct(s10.trade.winRate, 1), pct(s10.trade.expectancy, 3)],
    ["Fade 20bps", pct(s20.perf.totalReturn, 1), num(s20.perf.sharpe), pct(s20.perf.maxDrawdown, 1), String(s20.trade.trades), pct(s20.trade.winRate, 1), pct(s20.trade.expectancy, 3)],
  ]));
  console.log("\n" + mdTable(["Floor", "pre edge", "p", "n", "post edge", "p", "n"], sens.map((s) => [`${s.ratio}x`, pct(fadeEdge(s.pre), 3), pv(s.pre.pValue), String(s.pre.n), pct(fadeEdge(s.post), 3), pv(s.post.pValue), String(s.post.n)])));
  console.log("\nFull report: reports/capitulation-validation.md");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
