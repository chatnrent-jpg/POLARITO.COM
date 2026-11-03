/**
 * Polarity backtest CLI.
 *
 *   npm run backtest
 *   npm run backtest -- --tickers=SPY,QQQ,NVDA --start=2018-01-01 --cost-bps=5
 *   npm run backtest -- --feed=sip --refresh
 *
 * Pulls multi-year DAILY bars from Alpaca (cached under data/bars), runs the
 * event study + strategy simulation from src/lib/backtester.ts, prints a
 * summary and writes reports/backtest-latest.{json,md}.
 *
 * Credentials: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY from .env.local
 * (loaded by the npm script). They are sent as headers only; nothing secret is
 * ever written to the cache or the reports.
 */
import fs from "node:fs";
import path from "node:path";
import { validateBars, type Bar } from "../src/lib/polarity";
import { mapAlpacaBars } from "../src/lib/marketApi";
import {
  buyHoldSeries,
  collectObservations,
  equalWeightPortfolio,
  eventStudy,
  eventStudyByYear,
  perfMetrics,
  runStrategy,
  tradeMetrics,
  type EventStats,
  type Observation,
  type StrategyConfig,
  type StrategyResult,
  type Trade,
} from "../src/lib/backtester";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_TICKERS = [
  "SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN",
  "GOOGL", "META", "TSLA", "AMD", "JPM", "XOM",
];

type Args = {
  tickers: string[];
  start: string;
  feed: "iex" | "sip";
  costBps: number;
  permutations: number;
  refresh: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const feedRaw = (get("feed") ?? process.env.ALPACA_DATA_FEED ?? "iex").trim().toLowerCase();
  if (feedRaw !== "iex" && feedRaw !== "sip") {
    throw new Error(`--feed must be iex or sip (got "${feedRaw}").`);
  }
  const start = get("start") ?? "2016-01-04";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("--start must be YYYY-MM-DD.");
  const costBps = Number(get("cost-bps") ?? 5);
  const permutations = Number(get("perms") ?? 2000);
  if (!Number.isFinite(costBps) || costBps < 0) throw new Error("--cost-bps must be >= 0.");
  if (!Number.isInteger(permutations) || permutations < 0) throw new Error("--perms must be an integer >= 0.");
  const tickers = (get("tickers") ?? DEFAULT_TICKERS.join(","))
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  for (const t of tickers) {
    if (!/^[A-Z]{1,5}$/.test(t)) throw new Error(`Bad ticker "${t}".`);
  }
  return { tickers, start, feed: feedRaw, costBps, permutations, refresh: argv.includes("--refresh") };
}

const STRATEGIES = (costBps: number): StrategyConfig[] => [
  { name: "Hold 1d, long/short", holdDays: 1, allowShort: true, costBps },
  { name: "Hold 5d, long-only", holdDays: 5, allowShort: false, costBps },
  { name: "Hold 5d, long/short", holdDays: 5, allowShort: true, costBps },
  { name: "Hold 20d, long/short", holdDays: 20, allowShort: true, costBps },
  { name: "Hold until reversal, long/short", holdDays: null, allowShort: true, costBps },
];

/* ------------------------------------------------------------------ */
/* Data: paginated Alpaca fetch with on-disk cache                     */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(__dirname, "..");
const BARS_URL = "https://data.alpaca.markets/v2/stocks/bars";
const MAX_PAGES = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHistory(ticker: string, start: string, end: string, feed: string): Promise<Bar[]> {
  const keyId = process.env.ALPACA_API_KEY_ID?.trim();
  const secret = process.env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secret) {
    throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY missing (expected in .env.local).");
  }
  const raw: unknown[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(BARS_URL);
    url.searchParams.set("symbols", ticker);
    url.searchParams.set("timeframe", "1Day"); // daily only, same as the live app
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("adjustment", "all"); // splits + dividends: total-return prices
    url.searchParams.set("feed", feed);
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", "10000");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    type Page = { bars?: Record<string, unknown[]>; next_page_token?: string | null };
    let body = null as Page | null;
    for (let attempt = 0; attempt < 4 && body === null; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "APCA-API-KEY-ID": keyId,
            "APCA-API-SECRET-KEY": secret,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error(`${ticker}: network error or timeout talking to Alpaca.`);
      }
      if (res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `${ticker}: Alpaca rejected the credentials/feed (HTTP ${res.status}). ` +
            `If you rotated keys, update .env.local. On free plans use --feed=iex.`,
        );
      }
      if (!res.ok) throw new Error(`${ticker}: Alpaca returned HTTP ${res.status}.`);
      try {
        body = (await res.json()) as Page;
      } catch {
        throw new Error(`${ticker}: Alpaca returned invalid JSON.`);
      }
    }
    if (body === null) throw new Error(`${ticker}: rate-limited by Alpaca after 4 attempts.`);

    const rows = body.bars?.[ticker];
    if (Array.isArray(rows)) raw.push(...rows);
    pageToken = body.next_page_token ?? null;
    if (!pageToken) break;
    if (page === MAX_PAGES - 1) {
      throw new Error(`${ticker}: exceeded ${MAX_PAGES} pages; refusing to use partial history.`);
    }
  }

  if (raw.length === 0) throw new Error(`${ticker}: no bars returned.`);
  const bars = mapAlpacaBars(raw);
  validateBars(bars); // same validator the live engine uses; throws on bad data
  return bars;
}

async function loadBars(ticker: string, a: Args, end: string): Promise<{ bars: Bar[]; cached: boolean }> {
  const dir = path.join(ROOT, "data", "bars", a.feed);
  const file = path.join(dir, `${ticker}_${a.start}.json`);
  if (!a.refresh && fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { bars: Bar[] };
      validateBars(parsed.bars);
      return { bars: parsed.bars, cached: true };
    } catch {
      // corrupt/stale cache: fall through and refetch
    }
  }
  const bars = await fetchHistory(ticker, a.start, end, a.feed);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ticker, feed: a.feed, start: a.start, end, bars }));
  return { bars, cached: false };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const pct = (x: number, d = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
const num = (x: number | null, d = 2) => (x !== null && Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pv = (x: number | null) => (x === null ? "-" : x < 0.001 ? "<0.001" : x.toFixed(3));
const label = (p: number) => (p === 1 ? "Drive (+1)" : p === -1 ? "Reverse (-1)" : "Neutral (0)");

function mdTable(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

function eventRows(stats: EventStats[], entry: "nextOpen" | "close"): string[][] {
  return stats
    .filter((s) => s.entry === entry)
    .sort((a, b) => b.polarity - a.polarity || a.horizon - b.horizon)
    .map((s) => [
      label(s.polarity),
      `${s.horizon}D`,
      String(s.n),
      pct(s.meanDirectional, 3),
      pct(s.edge, 3),
      pct(s.hitRate, 1),
      num(s.tStat),
      pv(s.pValue),
    ]);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  console.log(
    `Polarity backtest | feed=${args.feed} | ${args.start} -> ${end} | cost=${args.costBps}bps/side | ` +
      `${args.tickers.length} tickers | ${args.permutations} permutations`,
  );

  // 1) Data
  const data = new Map<string, Bar[]>();
  const skipped: string[] = [];
  for (const t of args.tickers) {
    try {
      const { bars, cached } = await loadBars(t, args, end);
      data.set(t, bars);
      console.log(`  ${t.padEnd(5)} ${bars.length} bars ${bars[0].date} -> ${bars[bars.length - 1].date}${cached ? " (cache)" : ""}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      skipped.push(`${t}: ${msg}`);
      console.warn(`  ${t.padEnd(5)} SKIPPED - ${msg}`);
      // Credentials/feed problems repeat for every ticker; stop early.
      if (/rejected the credentials/.test(msg)) break;
    }
  }
  if (data.size === 0) {
    console.error("\nNo usable data. Nothing to backtest (refusing to report on missing data).");
    process.exit(1);
  }

  // 2) Event study (pooled)
  const obs: Observation[] = [];
  for (const [t, bars] of data) obs.push(...collectObservations(t, bars));
  const pooled = eventStudy(obs, { permutations: args.permutations, seed: 20260101 });
  const byYear = eventStudyByYear(obs);
  const signalCounts = { drive: 0, neutral: 0, reverse: 0 };
  for (const o of obs) {
    if (o.polarity === 1) signalCounts.drive++;
    else if (o.polarity === -1) signalCounts.reverse++;
    else signalCounts.neutral++;
  }

  // 3) Strategy simulation
  const configs = STRATEGIES(args.costBps);
  const perTicker = new Map<string, StrategyResult[]>();
  for (const [t, bars] of data) perTicker.set(t, configs.map((c) => runStrategy(bars, c)));
  const bhPortfolio = equalWeightPortfolio([...data.values()].map((b) => buyHoldSeries(b)));
  const bhPerf = perfMetrics(bhPortfolio.returns);

  const portfolio = configs.map((cfg, ci) => {
    const results = [...perTicker.values()].map((r) => r[ci]);
    const blend = equalWeightPortfolio(results);
    const trades: Trade[] = results.flatMap((r) => r.trades);
    return {
      config: cfg,
      perf: perfMetrics(blend.returns),
      trade: tradeMetrics(trades),
      exposure: results.reduce((s, r) => s + r.exposure, 0) / results.length,
      turnoverPerYear: results.reduce((s, r) => s + r.turnoverPerYear, 0) / results.length,
    };
  });

  // 4) Console + report
  const sig5 = pooled.filter(
    (s) => s.entry === "nextOpen" && s.polarity !== 0 && s.pValue !== null && s.pValue < 0.05,
  );
  const positive = sig5.filter((s) => s.edge > 0);
  const inverse = sig5.filter((s) => s.edge < 0);
  const fmtB = (s: EventStats) => `${label(s.polarity)} ${s.horizon}D (edge ${pct(s.edge, 3)}, p ${pv(s.pValue)})`;
  const totalSignals = signalCounts.drive + signalCounts.neutral + signalCounts.reverse;
  const neutralShare = totalSignals ? signalCounts.neutral / totalSignals : 0;
  const verdictParts: string[] = [];
  if (positive.length === 0 && inverse.length === 0) {
    verdictParts.push("No Drive/Reverse bucket differs from chance (two-sided p < 0.05) at any horizon.");
  }
  if (positive.length) verdictParts.push(`Predictive (edge > 0, p < 0.05): ${positive.map(fmtB).join("; ")}.`);
  if (inverse.length) {
    verdictParts.push(
      `INVERSE (edge < 0, p < 0.05; the market tends to do the OPPOSITE of the signal, i.e. mean reversion): ${inverse.map(fmtB).join("; ")}.`,
    );
  }
  if (neutralShare < 0.02) {
    verdictParts.push(
      `The Noise Floor almost never binds: Neutral is only ${pct(neutralShare, 2)} of days, so Drive/Reverse is effectively just the candle colour (green = +1, red = -1).`,
    );
  }
  const verdict = verdictParts.join(" ");

  const dateRange = (() => {
    const all = [...data.values()].flatMap((b) => [b[0].date, b[b.length - 1].date]).sort();
    return `${all[0]} -> ${all[all.length - 1]}`;
  })();

  const md: string[] = [];
  md.push(`# Polarity backtest`);
  md.push(
    `Generated ${new Date().toISOString().slice(0, 10)} | feed \`${args.feed}\` | data ${dateRange} | ` +
      `tickers: ${[...data.keys()].join(", ")} | cost ${args.costBps} bps per side | ${args.permutations} permutations`,
  );
  if (skipped.length) md.push(`\nSkipped: ${skipped.join("; ")}`);
  md.push(`\n**Verdict:** ${verdict}`);
  md.push(
    `\nSignal days (post warm-up): Drive ${signalCounts.drive}, Neutral ${signalCounts.neutral}, Reverse ${signalCounts.reverse}.`,
  );

  md.push(`\n## 1. Does the signal predict forward returns? (event study)`);
  md.push(
    `Entry = **next session open** (the earliest realistic fill: the signal needs the signal-day close). ` +
      `Return is measured in the signal's direction (Reverse is scored as a short). ` +
      `**Edge** = directional return minus the same ticker's average-day return, so a rising market cannot flatter Drive. ` +
      `p-value = two-sided permutation test against randomly chosen days (negative edge = inverse signal).\n`,
  );
  md.push(mdTable(["Signal", "Horizon", "n", "Mean (dir.)", "Edge", "Hit rate", "t-stat", "p-value"], eventRows(pooled, "nextOpen")));
  md.push(`\nOptimistic ceiling: entering at the signal-day close (needs a market-on-close fill):\n`);
  md.push(mdTable(["Signal", "Horizon", "n", "Mean (dir.)", "Edge", "Hit rate", "t-stat", "p-value"], eventRows(pooled, "close")));

  md.push(`\n## 2. Stability by year (5D, next-open entry, edge)`);
  const yearRows = Object.entries(byYear).map(([y, st]) => {
    const f = (p: number) => st.find((s) => s.polarity === p && s.horizon === 5 && s.entry === "nextOpen")!;
    const d = f(1);
    const r = f(-1);
    return [y, String(d.n), pct(d.edge, 3), pct(d.hitRate, 1), String(r.n), pct(r.edge, 3), pct(r.hitRate, 1)];
  });
  md.push(mdTable(["Year", "Drive n", "Drive edge", "Drive hit", "Reverse n", "Reverse edge", "Reverse hit"], yearRows));

  md.push(`\n## 3. Can it be traded? (equal-weight portfolio of all tickers)`);
  md.push(
    `Fills: signal trades at the next open, fixed-length holds exit at the close, ${args.costBps} bps per side, 1x notional, ` +
      `no borrow cost on shorts. Benchmark = equal-weight buy & hold of the same tickers over the same sessions.\n`,
  );
  const perfRow = (name: string, p: ReturnType<typeof perfMetrics>, extra: string[]) => [
    name, pct(p.totalReturn, 1), pct(p.cagr, 1), pct(p.annVol, 1), num(p.sharpe), pct(p.maxDrawdown, 1), ...extra,
  ];
  md.push(
    mdTable(
      ["Strategy", "Total", "CAGR", "Vol", "Sharpe", "Max DD", "Trades", "Win rate", "Profit factor", "Expectancy/trade", "Exposure", "Turnover/yr"],
      [
        perfRow("Buy & hold (benchmark)", bhPerf, ["-", "-", "-", "-", "100%", "-"]),
        ...portfolio.map((p) =>
          perfRow(p.config.name, p.perf, [
            String(p.trade.trades), pct(p.trade.winRate, 1), num(p.trade.profitFactor), pct(p.trade.expectancy, 3),
            pct(p.exposure, 1), num(p.turnoverPerYear, 1),
          ]),
        ),
      ],
    ),
  );

  md.push(`\n## 4. Per ticker: Sharpe, strategy vs buy & hold`);
  md.push(
    mdTable(
      ["Ticker", "Bars", "B&H Sharpe", ...configs.map((c) => c.name)],
      [...perTicker.entries()].map(([t, rs]) => [
        t, String(data.get(t)!.length), num(rs[0].buyHold.sharpe), ...rs.map((r) => num(r.perf.sharpe)),
      ]),
    ),
  );

  md.push(`\n## Caveats (read before trusting any number)`);
  md.push(
    [
      `- **Feed:** \`${args.feed}\`. The free IEX feed reports only IEX-exchange volume (a small slice of the consolidated tape), so Net Volume is a noisy proxy. Re-run with \`--feed=sip\` if your plan allows it.`,
      `- **Overlapping windows:** 5D and 20D forward returns overlap, so t-stats are overstated; lean on the permutation p-value and the by-year table.`,
      `- **Permutation test:** it resamples random days per ticker; it does not model volatility clustering, so p-values are indicative, not exact.`,
      `- **Survivorship bias:** the universe is today's liquid names. Companies that failed or were delisted are absent, which flatters long strategies.`,
      `- **Costs:** a flat bps cost ignores spread widening, slippage on size and short borrow fees.`,
      `- **Multiple comparisons:** many buckets are tested; at p < 0.05 about 1 in 20 will look good by chance.`,
      `- **No parameters were fitted** (20-day window and 10% floor are fixed by design), so there is no in-sample tuning, but a clean out-of-sample hold-out is still the stronger test.`,
    ].join("\n"),
  );

  fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "reports", "backtest-latest.md"), md.join("\n") + "\n");
  fs.writeFileSync(
    path.join(ROOT, "reports", "backtest-latest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        args,
        dateRange,
        skipped,
        signalCounts,
        verdict,
        eventStudy: pooled,
        byYear,
        buyHold: bhPerf,
        portfolio,
        perTicker: Object.fromEntries(
          [...perTicker.entries()].map(([t, rs]) => [
            t,
            rs.map((r) => ({ strategy: r.config.name, perf: r.perf, buyHold: r.buyHold, trade: r.tradeMetrics })),
          ]),
        ),
      },
      null,
      2,
    ),
  );

  console.log(`\nVerdict: ${verdict}\n`);
  console.log(mdTable(["Signal", "Horizon", "n", "Mean (dir.)", "Edge", "Hit rate", "t-stat", "p-value"], eventRows(pooled, "nextOpen")));
  console.log(
    "\n" +
      mdTable(
        ["Strategy", "Total", "CAGR", "Sharpe", "Max DD", "Trades", "Win rate"],
        [
          ["Buy & hold", pct(bhPerf.totalReturn, 1), pct(bhPerf.cagr, 1), num(bhPerf.sharpe), pct(bhPerf.maxDrawdown, 1), "-", "-"],
          ...portfolio.map((p) => [
            p.config.name, pct(p.perf.totalReturn, 1), pct(p.perf.cagr, 1), num(p.perf.sharpe),
            pct(p.perf.maxDrawdown, 1), String(p.trade.trades), pct(p.trade.winRate, 1),
          ]),
        ],
      ),
  );
  console.log("\nFull report: reports/backtest-latest.md");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
