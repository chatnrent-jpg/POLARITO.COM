/**
 * SPY-only study of the Net Volume / Noise Floor signal.
 *
 *   npm run spy-study
 *
 * One instrument, no pooling: does the signal (at the shipped 0.10 floor or any
 * higher floor) predict SPY, and can it be traded after SPY-sized costs?
 *
 * PROTOCOL (fixed in code BEFORE any result was looked at)
 *   1. Data: SPY daily bars, SIP feed, total-return adjusted, 2016-01-04 on.
 *   2. Development = signals before SPLIT, hold-out = signals on/after SPLIT.
 *      Development signals whose 20-session forward window reaches SPLIT are
 *      purged, so no development statistic touches hold-out prices.
 *   3. Search (development only): floors {0.1, 0.5, 1.0, 1.5, 2.0} x {Drive,
 *      Reverse} x {1D, 5D, 20D} = 30 tests. Candidate = n >= MIN_N_DEV and
 *      two-sided permutation p < 0.05 / 30 (Bonferroni).
 *      Direction is NOT assumed: positive edge = follow the signal, negative
 *      edge = fade it.
 *   4. Hold-out is used once to confirm: same sign, p < 0.05, n >= MIN_N_HOLD.
 *   5. Confirmed buckets are traded in the hold-out with the matching strategy.
 *      "Tradeable" = positive net expectancy at COST_BPS per side AND at double
 *      that, AND positive net Sharpe.
 *
 * Honesty notes: SPY was one of 13 tickers inside the earlier pooled studies,
 * so its data has been seen in aggregate (never on its own). Single-ticker
 * tests have far less statistical power than pooled ones: a failure to find an
 * edge here is weaker evidence than a failure on 50 tickers, and a lone
 * significant bucket among 30 tests deserves suspicion.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBars } from "./alpacaHistory";
import {
  HORIZONS,
  buyHoldSeries,
  collectObservations,
  eventStudy,
  perfMetrics,
  runStrategy,
  windowResult,
  type EventStats,
  type Observation,
  type StrategyConfig,
} from "../src/lib/backtester";

/* ---------------- frozen parameters ---------------- */
const TICKER = "SPY";
const RATIOS = [0.1, 0.5, 1.0, 1.5, 2.0] as const;
const SPLIT = "2022-01-01";
const START = "2016-01-04";
const PURGE_SESSIONS = 20;
const MIN_N_DEV = 60;
const MIN_N_HOLD = 30;
const FAMILY_SIZE = RATIOS.length * 2 * HORIZONS.length; // 30
const ALPHA_DEV = 0.05 / FAMILY_SIZE;
const ALPHA_HOLD = 0.05;
const PERMUTATIONS = 10_000;
const COST_BPS = 2;
const SEED = 4242;
/* --------------------------------------------------- */

const ROOT = path.resolve(__dirname, "..");
const pct = (x: number, d = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
const num = (x: number | null, d = 2) => (x !== null && Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pv = (x: number | null) => (x === null ? "-" : x < 0.001 ? "<0.001" : x.toFixed(3));
const pol = (p: number) => (p === 1 ? "Drive" : "Reverse");
const mdTable = (head: string[], rows: string[][]) => {
  const l = (c: string[]) => `| ${c.join(" | ")} |`;
  return [l(head), l(head.map(() => "---")), ...rows.map(l)].join("\n");
};

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
  const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const { bars } = await loadBars(TICKER, { feed: "sip", start: START, refresh: false }, end);
  console.log(
    `SPY study | ${bars.length} bars ${bars[0].date} -> ${bars[bars.length - 1].date} | split ${SPLIT} | ` +
      `alpha(dev)=${ALPHA_DEV.toFixed(5)} | cost ${COST_BPS} bps/side`,
  );

  const rows: Row[] = [];
  const freq: { ratio: number; drive: number; neutral: number; reverse: number }[] = [];
  const obsByRatio = new Map<number, Observation[]>();

  for (const ratio of RATIOS) {
    const all = collectObservations(TICKER, bars, { noiseFloorRatio: ratio });
    obsByRatio.set(ratio, all);
    const dev: Observation[] = [];
    const hold: Observation[] = [];
    const f = { ratio, drive: 0, neutral: 0, reverse: 0 };
    for (const o of all) {
      if (o.polarity === 1) f.drive++;
      else if (o.polarity === -1) f.reverse++;
      else f.neutral++;
      if (o.date >= SPLIT) hold.push(o);
      else {
        const exitBar = bars[o.index + PURGE_SESSIONS];
        if (exitBar && exitBar.date < SPLIT) dev.push(o);
      }
    }
    freq.push(f);
    const devStats = eventStudy(dev, { permutations: PERMUTATIONS, seed: SEED });
    const holdStats = eventStudy(hold, { permutations: PERMUTATIONS, seed: SEED + 1 });
    for (const p of [1, -1] as const) {
      for (const h of HORIZONS) {
        const pick = (st: EventStats[]) => st.find((s) => s.polarity === p && s.horizon === h && s.entry === "nextOpen")!;
        const d = pick(devStats);
        const w = pick(holdStats);
        const candidate = d.n >= MIN_N_DEV && d.pValue !== null && d.pValue < ALPHA_DEV && d.edge !== 0;
        const confirmed =
          candidate && w.n >= MIN_N_HOLD && w.pValue !== null && w.pValue < ALPHA_HOLD && Math.sign(w.edge) === Math.sign(d.edge);
        rows.push({ ratio, polarity: p, horizon: h, dev: d, hold: w, candidate, confirmed });
      }
    }
    console.log(`  floor ${ratio}x done`);
  }

  const candidates = rows.filter((r) => r.candidate);
  const confirmed = rows.filter((r) => r.confirmed);

  /* strategies for confirmed buckets, hold-out only */
  const bh = perfMetrics(buyHoldSeries(bars).returns.filter((_, i) => buyHoldSeries(bars).dates[i] >= SPLIT));
  const mk = (r: Row, costBps: number): StrategyConfig => ({
    name: `${pol(r.polarity)} ${r.horizon}D @ ${r.ratio}x ${r.dev.edge < 0 ? "(fade)" : "(follow)"}`,
    holdDays: r.horizon,
    allowShort: true,
    costBps,
    noiseFloorRatio: r.ratio,
    invert: r.dev.edge < 0,
    sides: r.polarity === 1 ? "drive" : "reverse",
  });
  const strat = confirmed.map((r) => {
    const net = windowResult(runStrategy(bars, mk(r, COST_BPS)), SPLIT);
    const net2 = windowResult(runStrategy(bars, mk(r, COST_BPS * 2)), SPLIT);
    const gross = windowResult(runStrategy(bars, mk(r, 0)), SPLIT);
    return {
      row: r,
      name: mk(r, 0).name,
      gross: gross.perf,
      net,
      net2,
      tradeable: net.trade.expectancy > 0 && net2.trade.expectancy > 0 && net.perf.sharpe > 0,
    };
  });

  /* per-year edge for confirmed buckets (full sample, for stability) */
  const years = [...new Set(bars.map((b) => b.date.slice(0, 4)))].sort();
  const yearly = confirmed.map((r) => {
    const obs = obsByRatio.get(r.ratio)!;
    return {
      name: mk(r, 0).name,
      byYear: years.map((y) => {
        const st = eventStudy(obs.filter((o) => o.date.startsWith(y)));
        const s = st.find((x) => x.polarity === r.polarity && x.horizon === r.horizon && x.entry === "nextOpen")!;
        // express as profit of the traded direction (fade flips the sign)
        return { year: y, n: s.n, profit: r.dev.edge < 0 ? -s.edge : s.edge };
      }),
    };
  });

  /* verdict */
  let verdict: string;
  if (candidates.length === 0) {
    verdict =
      `No SPY bucket cleared the development bar (30 tests, Bonferroni p < ${ALPHA_DEV.toFixed(4)}). ` +
      `On SPY alone, at any floor from 0.1x to 2.0x, the signal shows no statistically defensible edge in ${START.slice(0, 4)}-${(Number(SPLIT.slice(0, 4)) - 1)}. ` +
      `Caveat: one ticker has limited power, so this rules out medium and large effects, not tiny ones.`;
  } else if (confirmed.length === 0) {
    verdict =
      `${candidates.length} development candidate(s) emerged, but NONE confirmed in the ${SPLIT.slice(0, 4)}+ hold-out. ` +
      `Treat them as noise.`;
  } else if (strat.every((s) => !s.tradeable)) {
    verdict =
      `${confirmed.length} bucket(s) confirmed out-of-sample, but none is tradeable: the matching strategy fails the ` +
      `net-of-cost test at ${COST_BPS} bps and/or ${COST_BPS * 2} bps per side in the hold-out.`;
  } else {
    verdict =
      `LEAD (not proof): ${strat.filter((s) => s.tradeable).map((s) => s.name).join("; ")} confirmed out-of-sample and ` +
      `survived doubled costs. Next: forward-test before risking capital.`;
  }
  const expectedFalse = (FAMILY_SIZE * 0.05).toFixed(1);

  /* report */
  const md: string[] = [];
  md.push(`# SPY-only study`);
  md.push(
    `Generated ${new Date().toISOString().slice(0, 10)} | feed \`sip\` | ${bars.length} bars ${bars[0].date} -> ${bars[bars.length - 1].date} | ` +
      `development < ${SPLIT} <= hold-out | ${PERMUTATIONS} permutations | cost ${COST_BPS} bps/side`,
  );
  md.push(`\n**Verdict:** ${verdict}`);
  md.push(`\n## Protocol (fixed before looking at results)`);
  md.push(
    [
      `1. Floors ${RATIOS.join("x, ")}x of the 20-day average volume (0.1x = shipped) x Drive/Reverse x 1D/5D/20D = ${FAMILY_SIZE} tests.`,
      `2. Development only picks candidates: n >= ${MIN_N_DEV}, two-sided permutation p < ${ALPHA_DEV.toFixed(5)} (Bonferroni 0.05 / ${FAMILY_SIZE}). Direction is data-driven: edge > 0 = follow, edge < 0 = fade.`,
      `3. Dev signals whose 20-session forward window reaches ${SPLIT} are purged.`,
      `4. Hold-out used once: same sign, p < ${ALPHA_HOLD}, n >= ${MIN_N_HOLD}.`,
      `5. Tradeable = positive net expectancy at ${COST_BPS} and ${COST_BPS * 2} bps per side AND positive net Sharpe in the hold-out.`,
      `6. Entry = next session open. Edge = directional return minus SPY's average-day return.`,
    ].join("\n"),
  );

  md.push(`\n## 1. How often does each floor fire on SPY?`);
  md.push(
    mdTable(
      ["Floor", "Drive", "Neutral", "Reverse", "Drive days", "Reverse days"],
      freq.map((f) => {
        const t = f.drive + f.neutral + f.reverse;
        return [`${f.ratio}x${f.ratio === 0.1 ? " (shipped)" : ""}`, pct(f.drive / t, 1), pct(f.neutral / t, 1), pct(f.reverse / t, 1), String(f.drive), String(f.reverse)];
      }),
    ),
  );

  md.push(`\n## 2. Edge by floor: development vs hold-out`);
  md.push(
    `Edge > 0: SPY moved WITH the signal; edge < 0: AGAINST it. About ${expectedFalse} of ${FAMILY_SIZE} buckets would look "significant" at 5% by luck; the dev gate is Bonferroni-corrected for that.\n`,
  );
  md.push(
    mdTable(
      ["Floor", "Signal", "Horizon", "Dev n", "Dev edge", "Dev p", "Hold n", "Hold edge", "Hold p", "Candidate", "Confirmed"],
      rows.map((r) => [
        `${r.ratio}x`, pol(r.polarity), `${r.horizon}D`, String(r.dev.n), pct(r.dev.edge, 3), pv(r.dev.pValue),
        String(r.hold.n), pct(r.hold.edge, 3), pv(r.hold.pValue), r.candidate ? "YES" : "-", r.confirmed ? "YES" : "-",
      ]),
    ),
  );

  md.push(`\n## 3. Tradeability of confirmed buckets (hold-out ${SPLIT}+)`);
  if (strat.length === 0) {
    md.push(`No bucket confirmed, so no strategy was run (running strategies on unconfirmed buckets would data-mine the hold-out).`);
  } else {
    md.push(
      mdTable(
        ["Strategy", "Gross total", `Net total (${COST_BPS}bps)`, "Net Sharpe", "Net max DD", "Trades", "Win rate", `Expectancy (${COST_BPS}bps)`, `Expectancy (${COST_BPS * 2}bps)`, "Exposure", "Tradeable"],
        [
          ["Buy & hold SPY", "-", pct(bh.totalReturn, 1), num(bh.sharpe), pct(bh.maxDrawdown, 1), "-", "-", "-", "-", "100%", "-"],
          ...strat.map((s) => [
            s.name, pct(s.gross.totalReturn, 1), pct(s.net.perf.totalReturn, 1), num(s.net.perf.sharpe), pct(s.net.perf.maxDrawdown, 1),
            String(s.net.trade.trades), pct(s.net.trade.winRate, 1), pct(s.net.trade.expectancy, 3), pct(s.net2.trade.expectancy, 3),
            pct(s.net.exposure, 1), s.tradeable ? "YES" : "no",
          ]),
        ],
      ),
    );
    md.push(`\n### Year-by-year profit of the traded direction (full sample, n in brackets)`);
    md.push(
      mdTable(
        ["Strategy", ...years],
        yearly.map((y) => [y.name, ...y.byYear.map((b) => `${pct(b.profit, 2)} (${b.n})`)]),
      ),
    );
  }

  md.push(`\n## Caveats`);
  md.push(
    [
      `- One ticker means about ${freq[0].drive} Drive and ${freq[0].reverse} Reverse days at the shipped floor and only dozens at 1.5x+. Small n makes p-values coarse and effects noisy.`,
      `- SPY appeared inside the earlier 13-ticker pooled studies, so it has been seen in aggregate (never alone).`,
      `- 5D/20D windows overlap; the permutation p-value ignores volatility clustering.`,
      `- ${COST_BPS} bps/side is a fair estimate for SPY at the open; short-side borrow (~0.25%/yr) is ignored.`,
      `- The hold-out (${SPLIT.slice(0, 4)}+) contains the 2022 bear market and a strong 2023-2026 rally, but is still one path of history.`,
    ].join("\n"),
  );

  fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "reports", "spy-study.md"), md.join("\n") + "\n");
  fs.writeFileSync(
    path.join(ROOT, "reports", "spy-study.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        protocol: { TICKER, RATIOS, SPLIT, MIN_N_DEV, MIN_N_HOLD, ALPHA_DEV, ALPHA_HOLD, PERMUTATIONS, COST_BPS, FAMILY_SIZE },
        bars: bars.length, verdict, frequency: freq, rows, buyHoldHoldout: bh, strategies: strat, yearly,
      },
      null,
      2,
    ),
  );

  console.log(`\nVerdict: ${verdict}\n`);
  console.log(mdTable(["Floor", "Drive", "Neutral", "Reverse", "Drive d", "Rev d"], freq.map((f) => {
    const t = f.drive + f.neutral + f.reverse;
    return [`${f.ratio}x`, pct(f.drive / t, 1), pct(f.neutral / t, 1), pct(f.reverse / t, 1), String(f.drive), String(f.reverse)];
  })));
  console.log("\n" + mdTable(["Floor", "Sig", "H", "Dev n", "Dev edge", "Dev p", "Hold n", "Hold edge", "Hold p", "Cand", "Conf"], rows.map((r) => [
    `${r.ratio}x`, pol(r.polarity), `${r.horizon}D`, String(r.dev.n), pct(r.dev.edge, 3), pv(r.dev.pValue),
    String(r.hold.n), pct(r.hold.edge, 3), pv(r.hold.pValue), r.candidate ? "YES" : "-", r.confirmed ? "YES" : "-",
  ])));
  if (strat.length) {
    console.log("\n" + mdTable(["Strategy", "Net total", "Sharpe", "Trades", "Exp 2bps", "Exp 4bps", "Tradeable"], strat.map((s) => [
      s.name, pct(s.net.perf.totalReturn, 1), num(s.net.perf.sharpe), String(s.net.trade.trades),
      pct(s.net.trade.expectancy, 3), pct(s.net2.trade.expectancy, 3), s.tradeable ? "YES" : "no",
    ])));
    console.log(`\nBuy & hold SPY (hold-out): ${pct(bh.totalReturn, 1)}, Sharpe ${num(bh.sharpe)}, max DD ${pct(bh.maxDrawdown, 1)}`);
  }
  console.log("\nFull report: reports/spy-study.md");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
