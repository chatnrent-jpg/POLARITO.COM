/**
 * Noise Floor study: does ANY floor make the Net Volume signal useful?
 *
 *   npm run floor-study
 *
 * Why: at the shipped floor (0.10 x 20-day average volume) Neutral fires on
 * <0.1% of days, so Drive/Reverse is just candle colour. Here the floor is
 * raised (0.5x, 1.0x, 1.5x, 2.0x average volume) so it actually filters, and
 * the result is judged with a pre-registered, out-of-sample protocol.
 *
 * PROTOCOL (fixed in code BEFORE any floor result was looked at)
 *   1. Development = signals before SPLIT; hold-out = signals on/after SPLIT.
 *      Development signals whose 20-session forward window reaches into the
 *      hold-out are purged, so no dev statistic touches hold-out prices.
 *   2. Candidate search uses DEVELOPMENT DATA ONLY, over the new floors
 *      (4 ratios x 2 polarities x 3 horizons = 24 tests). A bucket is a
 *      candidate if n >= MIN_N_DEV and its two-sided permutation p-value is
 *      below Bonferroni alpha = 0.05 / 24.
 *   3. The hold-out is then used ONCE to confirm: same edge sign, p < 0.05,
 *      n >= MIN_N_HOLD. No re-picking after seeing the hold-out.
 *   4. A confirmed bucket is only called tradeable if the matching strategy
 *      (direction taken from the dev edge sign) has positive net expectancy
 *      and Sharpe in the hold-out after costs.
 *
 * Caveat: the shipped 0.10 floor was already evaluated on the full sample in
 * backtest.ts, so it is shown for reference and excluded from the search.
 */
import fs from "node:fs";
import path from "node:path";
import { type Bar } from "../src/lib/polarity";
import { loadBars } from "./alpacaHistory";
import {
  HORIZONS,
  buyHoldSeries,
  collectObservations,
  equalWeightPortfolio,
  eventStudy,
  perfMetrics,
  runStrategy,
  tradeMetrics,
  windowResult,
  windowSeries,
  type EventStats,
  type Observation,
  type StrategyConfig,
  type Trade,
} from "../src/lib/backtester";

/* ---------------- pre-registered parameters ---------------- */
const RATIOS = [0.1, 0.5, 1.0, 1.5, 2.0] as const;
const SEARCH_RATIOS = RATIOS.filter((r) => r !== 0.1);
const SPLIT = "2023-01-01";
const START = "2016-01-04";
const PURGE_SESSIONS = 20; // longest forward horizon
const MIN_N_DEV = 200;
const MIN_N_HOLD = 100;
const FAMILY_SIZE = SEARCH_RATIOS.length * 2 * HORIZONS.length; // 24
const ALPHA_DEV = 0.05 / FAMILY_SIZE;
const ALPHA_HOLD = 0.05;
const PERMUTATIONS = 5000;
const COST_BPS = 5;
const SEED = 20260103;
/* ------------------------------------------------------------ */

const ROOT = path.resolve(__dirname, "..");

const pct = (x: number, d = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
const num = (x: number | null, d = 2) => (x !== null && Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pv = (x: number | null) => (x === null ? "-" : x < 0.001 ? "<0.001" : x.toFixed(3));
const pol = (p: number) => (p === 1 ? "Drive" : "Reverse");

function mdTable(head: string[], rows: string[][]): string {
  const line = (c: string[]) => `| ${c.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

type Row = {
  ratio: number;
  polarity: 1 | -1;
  horizon: number;
  dev: EventStats;
  hold: EventStats;
  candidate: boolean;
  confirmed: boolean;
};

async function main() {
  const feed = (process.env.ALPACA_DATA_FEED ?? "sip").trim().toLowerCase() === "iex" ? "iex" : "sip";
  const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const tickers = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "JPM", "XOM"];

  console.log(`Floor study | feed=${feed} | split ${SPLIT} | ${PERMUTATIONS} permutations | alpha(dev)=${ALPHA_DEV.toFixed(4)}`);
  const data = new Map<string, Bar[]>();
  for (const t of tickers) {
    try {
      const { bars } = await loadBars(t, { feed, start: START, refresh: false }, end);
      data.set(t, bars);
    } catch (e) {
      console.warn(`  ${t} SKIPPED - ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }
  if (data.size === 0) {
    console.error("No usable data; refusing to run.");
    process.exit(1);
  }
  console.log(`  loaded ${data.size} tickers`);

  /* ---- event study per ratio, dev vs hold-out ---- */
  const rows: Row[] = [];
  const freq: { ratio: number; drive: number; neutral: number; reverse: number }[] = [];

  for (const ratio of RATIOS) {
    const dev: Observation[] = [];
    const hold: Observation[] = [];
    const f = { ratio, drive: 0, neutral: 0, reverse: 0 };
    for (const [t, bars] of data) {
      for (const o of collectObservations(t, bars, { noiseFloorRatio: ratio })) {
        if (o.polarity === 1) f.drive++;
        else if (o.polarity === -1) f.reverse++;
        else f.neutral++;
        if (o.date >= SPLIT) hold.push(o);
        else {
          // purge: forward window must end before the split
          const exitBar = bars[o.index + PURGE_SESSIONS];
          if (exitBar && exitBar.date < SPLIT) dev.push(o);
        }
      }
    }
    freq.push(f);
    const devStats = eventStudy(dev, { permutations: PERMUTATIONS, seed: SEED });
    const holdStats = eventStudy(hold, { permutations: PERMUTATIONS, seed: SEED + 1 });
    for (const p of [1, -1] as const) {
      for (const h of HORIZONS) {
        const pick = (st: EventStats[]) =>
          st.find((s) => s.polarity === p && s.horizon === h && s.entry === "nextOpen")!;
        const d = pick(devStats);
        const w = pick(holdStats);
        const searchable = (SEARCH_RATIOS as readonly number[]).includes(ratio);
        const candidate = searchable && d.n >= MIN_N_DEV && d.pValue !== null && d.pValue < ALPHA_DEV && d.edge !== 0;
        const confirmed =
          candidate &&
          w.n >= MIN_N_HOLD &&
          w.pValue !== null &&
          w.pValue < ALPHA_HOLD &&
          Math.sign(w.edge) === Math.sign(d.edge);
        rows.push({ ratio, polarity: p, horizon: h, dev: d, hold: w, candidate, confirmed });
      }
    }
    console.log(`  floor ${ratio}x done`);
  }

  /* ---- strategy test for candidates that confirmed ---- */
  const confirmed = rows.filter((r) => r.confirmed);
  const candidates = rows.filter((r) => r.candidate);
  const bh = equalWeightPortfolio(
    [...data.values()].map((b) => windowSeries(buyHoldSeries(b), SPLIT)),
  );
  const bhPerf = perfMetrics(bh.returns);

  type StratOut = {
    row: Row;
    net: ReturnType<typeof perfMetrics>;
    gross: ReturnType<typeof perfMetrics>;
    trade: ReturnType<typeof tradeMetrics>;
    exposure: number;
    tradeable: boolean;
    cfg: StrategyConfig;
  };
  const stratOuts: StratOut[] = [];
  const concentration: {
    name: string;
    best: string;
    bestShare: number;
    expectancyAll: number;
    expectancyWithoutBest: number;
    tickersPositive: number;
    tickersWithTrades: number;
    worst: string;
  }[] = [];
  for (const r of confirmed) {
    const cfg: StrategyConfig = {
      name: `${pol(r.polarity)} ${r.horizon}D @ ${r.ratio}x ${r.dev.edge < 0 ? "(fade)" : "(follow)"}`,
      holdDays: r.horizon,
      allowShort: true,
      costBps: COST_BPS,
      noiseFloorRatio: r.ratio,
      invert: r.dev.edge < 0,
      sides: r.polarity === 1 ? "drive" : "reverse",
    };
    const run = (c: StrategyConfig) => {
      const per = [...data.values()].map((b) => runStrategy(b, c));
      if (c.costBps > 0) {
        // Concentration diagnostic (net of costs): is one ticker carrying the result?
        const names = [...data.keys()];
        const byTicker = per.map((x, i) => {
          const tr = x.trades.filter((t) => t.entryDate >= SPLIT);
          return { ticker: names[i], n: tr.length, sum: tr.reduce((s, t) => s + t.returnPct, 0) };
        });
        const totalN = byTicker.reduce((s, x) => s + x.n, 0);
        const totalSum = byTicker.reduce((s, x) => s + x.sum, 0);
        const best = [...byTicker].sort((a, b) => b.sum - a.sum)[0];
        const worst = [...byTicker].sort((a, b) => a.sum - b.sum)[0];
        const looN = totalN - best.n;
        concentration.push({
          name: c.name,
          best: best.ticker,
          bestShare: totalSum > 0 ? best.sum / totalSum : NaN,
          expectancyAll: totalN ? totalSum / totalN : NaN,
          expectancyWithoutBest: looN ? (totalSum - best.sum) / looN : NaN,
          tickersPositive: byTicker.filter((x) => x.n > 0 && x.sum > 0).length,
          tickersWithTrades: byTicker.filter((x) => x.n > 0).length,
          worst: worst.ticker,
        });
      }
      const blend = equalWeightPortfolio(per.map((x) => windowSeries(x, SPLIT)));
      const trades: Trade[] = per.flatMap((x) => x.trades.filter((t) => t.entryDate >= SPLIT));
      const exposure = per.reduce((s, x) => s + windowResult(x, SPLIT).exposure, 0) / per.length;
      return { perf: perfMetrics(blend.returns), trade: tradeMetrics(trades), exposure };
    };
    const net = run(cfg);
    const gross = run({ ...cfg, costBps: 0 });
    stratOuts.push({
      row: r,
      net: net.perf,
      gross: gross.perf,
      trade: net.trade,
      exposure: net.exposure,
      // Positive net expectancy and Sharpe, AND still positive without the single
      // best ticker (gate 3 was added after the first run; it only tightens).
      tradeable:
        net.trade.expectancy > 0 &&
        net.perf.sharpe > 0 &&
        concentration[concentration.length - 1].expectancyWithoutBest > 0,
      cfg,
    });
  }

  /* ---- verdict ---- */
  let verdict: string;
  if (candidates.length === 0) {
    verdict =
      `No floor produced a candidate. Across ${FAMILY_SIZE} development tests (Bonferroni alpha ${ALPHA_DEV.toFixed(4)}), ` +
      `none of the 0.5x / 1.0x / 1.5x / 2.0x floors showed a statistically defensible edge in 2016-2022, so there was nothing to confirm.`;
  } else if (confirmed.length === 0) {
    verdict =
      `${candidates.length} development candidate(s) emerged, but NONE held up in the 2023+ hold-out. ` +
      `That is the expected outcome of an edge that was noise; do not trade it.`;
  } else if (stratOuts.every((s) => !s.tradeable)) {
    verdict =
      `${confirmed.length} bucket(s) confirmed out-of-sample as statistically real, but none is tradeable: ` +
      `after ${COST_BPS} bps/side costs the matching strategy does not have positive expectancy and Sharpe in the hold-out.`;
  } else {
    const ok = stratOuts.filter((s) => s.tradeable).map((s) => s.cfg.name);
    verdict =
      `LEAD (not proof): ${ok.join("; ")} confirmed out-of-sample and stayed profitable after costs. ` +
      `Next: paper-trade it and re-test on fresh data before risking capital.`;
  }
  const expectedFalse = (FAMILY_SIZE * 0.05).toFixed(1);

  /* ---- report ---- */
  const md: string[] = [];
  md.push(`# Noise Floor study`);
  md.push(
    `Generated ${new Date().toISOString().slice(0, 10)} | feed \`${feed}\` | ${data.size} tickers | ` +
      `development < ${SPLIT} <= hold-out | ${PERMUTATIONS} permutations | cost ${COST_BPS} bps/side`,
  );
  md.push(`\n**Verdict:** ${verdict}`);
  md.push(`\n## Protocol (fixed before looking at results)`);
  md.push(
    [
      `1. Floors tested: ${RATIOS.join("x, ")}x of the 20-day average volume (0.1x is the shipped setting, shown for reference and excluded from the search).`,
      `2. **Development only** picks candidates: n >= ${MIN_N_DEV} and two-sided permutation p < ${ALPHA_DEV.toFixed(4)} (Bonferroni: 0.05 / ${FAMILY_SIZE} tests).`,
      `3. Dev signals whose 20-session forward window reaches ${SPLIT} are purged, so no development statistic uses hold-out prices.`,
      `4. **Hold-out used once** to confirm: same sign, p < ${ALPHA_HOLD}, n >= ${MIN_N_HOLD}.`,
      `5. Tradeable only if the matching strategy has positive net expectancy and Sharpe in the hold-out (direction = sign of the dev edge) AND stays positive after removing the single best ticker. (The concentration condition was added after the first run, once one ticker was seen carrying three of four buckets. It only tightens the gate.)`,
      `6. Entry is always the next session open. Edge = directional return minus the ticker's average-day return.`,
    ].join("\n"),
  );

  md.push(`\n## 1. How often does each floor fire?`);
  md.push(
    mdTable(
      ["Floor (x avg vol)", "Drive", "Neutral", "Reverse"],
      freq.map((f) => {
        const tot = f.drive + f.neutral + f.reverse;
        return [`${f.ratio}x${f.ratio === 0.1 ? " (shipped)" : ""}`, pct(f.drive / tot, 1), pct(f.neutral / tot, 1), pct(f.reverse / tot, 1)];
      }),
    ),
  );

  md.push(`\n## 2. Edge by floor: development vs hold-out`);
  md.push(
    `Edge > 0 means the market moved WITH the signal; edge < 0 means against it (mean reversion). ` +
      `Expect about ${expectedFalse} of ${FAMILY_SIZE} buckets to look "significant" at 5% by luck alone, which is why the dev gate is Bonferroni-corrected.\n`,
  );
  md.push(
    mdTable(
      ["Floor", "Signal", "Horizon", "Dev n", "Dev edge", "Dev p", "Hold n", "Hold edge", "Hold p", "Candidate", "Confirmed"],
      rows.map((r) => [
        `${r.ratio}x`, pol(r.polarity), `${r.horizon}D`,
        String(r.dev.n), pct(r.dev.edge, 3), pv(r.dev.pValue),
        String(r.hold.n), pct(r.hold.edge, 3), pv(r.hold.pValue),
        r.ratio === 0.1 ? "ref" : r.candidate ? "YES" : "-",
        r.confirmed ? "YES" : "-",
      ]),
    ),
  );

  md.push(`\n## 3. Tradeability of confirmed buckets (hold-out ${SPLIT}+)`);
  if (stratOuts.length === 0) {
    md.push(`No bucket was confirmed, so no strategy was run. (Running strategies on unconfirmed buckets would be data-mining the hold-out.)`);
  } else {
    md.push(
      mdTable(
        ["Strategy", "Gross total", "Net total", "Net Sharpe", "Net max DD", "Trades", "Win rate", "Expectancy/trade", "Exposure", "Tradeable"],
        [
          ["Buy & hold (benchmark)", "-", pct(bhPerf.totalReturn, 1), num(bhPerf.sharpe), pct(bhPerf.maxDrawdown, 1), "-", "-", "-", "100%", "-"],
          ...stratOuts.map((s) => [
            s.cfg.name, pct(s.gross.totalReturn, 1), pct(s.net.totalReturn, 1), num(s.net.sharpe), pct(s.net.maxDrawdown, 1),
            String(s.trade.trades), pct(s.trade.winRate, 1), pct(s.trade.expectancy, 3), pct(s.exposure, 1), s.tradeable ? "YES" : "no",
          ]),
        ],
      ),
    );
  }

  if (concentration.length) {
    md.push(`\n## 4. Concentration check (hold-out, net of costs)`);
    md.push(`A real effect should be broad, not carried by one ticker.\n`);
    md.push(
      mdTable(
        ["Strategy", "Expectancy/trade", "Without best ticker", "Best ticker (share of P&L)", "Worst ticker", "Tickers profitable"],
        concentration.map((c) => [
          c.name, pct(c.expectancyAll, 3), pct(c.expectancyWithoutBest, 3),
          `${c.best} (${pct(c.bestShare, 0)})`, c.worst, `${c.tickersPositive} of ${c.tickersWithTrades}`,
        ]),
      ),
    );
  }

  md.push(`\n## Caveats`);
  md.push(
    [
      `- **Read the 0.5x rows with suspicion.** A 0.5x floor fires on ~98% of days, so it is the same candle-colour signal as the shipped 0.1x floor, which backtest.ts had already examined on the full sample. Its "confirmation" is not independent evidence. Only the 1.0x and above floors are genuinely new.`,
      `- Even a "tradeable" bucket earns far less in total return than buy & hold in a bull market; its value would be as a low-exposure, low-drawdown add-on, not a replacement for holding the stocks.`,
      `- The hold-out runs from ${SPLIT} to the latest data (under 4 years) and is dominated by one market regime (a strong bull market); a pass here is evidence, not proof.`,
      `- Universe is today's liquid names (survivorship bias flatters long exposure).`,
      `- Overlapping 5D/20D windows overstate t-stats; the permutation p-value is the figure to use, and it ignores volatility clustering.`,
      `- Costs are a flat ${COST_BPS} bps per side: no spread widening, slippage on size, or short-borrow fees.`,
      `- Only the floor ratio was varied. The 20-day window and candle-colour direction rule were not touched.`,
    ].join("\n"),
  );

  fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "reports", "floor-study.md"), md.join("\n") + "\n");
  fs.writeFileSync(
    path.join(ROOT, "reports", "floor-study.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        protocol: { RATIOS, SPLIT, MIN_N_DEV, MIN_N_HOLD, ALPHA_DEV, ALPHA_HOLD, PERMUTATIONS, COST_BPS, FAMILY_SIZE },
        feed, tickers: [...data.keys()], verdict, frequency: freq, rows,
        buyHoldHoldout: bhPerf,
        strategies: stratOuts,
      },
      null,
      2,
    ),
  );

  console.log(`\nVerdict: ${verdict}\n`);
  console.log(mdTable(["Floor", "Drive", "Neutral", "Reverse"], freq.map((f) => {
    const tot = f.drive + f.neutral + f.reverse;
    return [`${f.ratio}x`, pct(f.drive / tot, 1), pct(f.neutral / tot, 1), pct(f.reverse / tot, 1)];
  })));
  console.log(
    "\n" +
      mdTable(
        ["Floor", "Sig", "H", "Dev n", "Dev edge", "Dev p", "Hold n", "Hold edge", "Hold p", "Cand", "Conf"],
        rows.map((r) => [
          `${r.ratio}x`, pol(r.polarity), `${r.horizon}D`, String(r.dev.n), pct(r.dev.edge, 3), pv(r.dev.pValue),
          String(r.hold.n), pct(r.hold.edge, 3), pv(r.hold.pValue), r.ratio === 0.1 ? "ref" : r.candidate ? "YES" : "-", r.confirmed ? "YES" : "-",
        ]),
      ),
  );
  console.log("\nFull report: reports/floor-study.md");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
