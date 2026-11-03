/**
 * Top-10 SPY holdings study (daily bars) of the Net Volume / Noise Floor signal.
 *
 *   npm run top10-study
 *
 * Research script only: nothing here touches the live app.
 *
 * PROTOCOL (fixed in code BEFORE any result was looked at)
 *   Universe  NVDA MSFT AAPL AMZN GOOG META AVGO TSLA BRK.B JPM. Chosen up front as
 *             an approximation of SPY's ten largest holdings (live weights not
 *             verified); GOOG kept, GOOGL excluded so one company is not counted
 *             twice. NOT re-selected after seeing results.
 *   Data      Alpaca SIP daily bars, total-return adjusted, 2016-01-04 on.
 *   Signal    The shipped engine (computePolaritySeries) at floors {0.1, 1, 1.5, 2}
 *             x 20-day average volume. Entry = next session open.
 *   Tests     24 = 4 floors x {Drive, Reverse} x {1D, 5D, 20D}. Directional edge =
 *             polarity x (forward return - that ticker's own average forward return
 *             in the same sample). Positive = the stock moved WITH the signal.
 *             Pooled across tickers, clustered by blocks of 2H sessions (same-day
 *             returns across stocks are correlated; H-day windows overlap), Student-t
 *             p-value with clusters-1 d.f. Dev bar: Bonferroni 0.05 / 24, n >= 300.
 *   Split     Development before SPLIT (signals whose 20-session window reaches SPLIT
 *             are purged); hold-out on/after. Hold-out used once: same sign, p < 0.05,
 *             n >= 150.
 *   Tradeable For confirmed buckets only. ALL of:
 *             (a) drift-adjusted hold-out edge per signal minus round-trip cost > 0 at
 *                 COST_BPS per side AND at double that;
 *             (b) the same still holds after removing the single best ticker;
 *             (c) the matching equal-weight strategy has a positive net Sharpe.
 *
 * Honesty notes (also written into the report):
 *   - 7 of the 10 names (and GOOGL, the twin of GOOG) were inside the earlier
 *     13-ticker discovery set and AVGO was in the earlier 39-stock validation list,
 *     so this is NOT clean out-of-sample evidence. BRK.B is the only untouched name.
 *   - Today's top 10 are the 2016-2026 winners (survivorship). The drift adjustment
 *     removes it from the event study; the equity curve is still flattered.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBars } from "./alpacaHistory";
import {
  HORIZONS,
  buyHoldSeries,
  collectObservations,
  equalWeightPortfolio,
  perfMetrics,
  runStrategy,
  tradeMetrics,
  windowSeries,
  type Observation,
  type StrategyConfig,
  type Trade,
} from "../src/lib/backtester";
import type { Bar } from "../src/lib/polarity";

/* ---------------- frozen parameters ---------------- */
const TICKERS = ["NVDA", "MSFT", "AAPL", "AMZN", "GOOG", "META", "AVGO", "TSLA", "BRK.B", "JPM"] as const;
// Already used in earlier studies: the 13-ticker discovery set (NVDA MSFT AAPL AMZN META TSLA JPM; GOOGL = twin of GOOG)
// and the 39-stock validation list (AVGO). Only BRK.B is untouched.
const SEEN_BEFORE = new Set(["NVDA", "MSFT", "AAPL", "AMZN", "META", "TSLA", "JPM", "AVGO", "GOOG"]);
const RATIOS = [0.1, 1.0, 1.5, 2.0] as const;
const SPLIT = "2022-01-01";
const START = "2016-01-04";
const PURGE = 20;
const MIN_N_DEV = 300;
const MIN_N_HOLD = 150;
const FAMILY = RATIOS.length * 2 * HORIZONS.length; // 24
const ALPHA_DEV = 0.05 / FAMILY;
const ALPHA_HOLD = 0.05;
const COST_BPS = 2; // per side; doubled for the stress gate
/* --------------------------------------------------- */

const ROOT = path.resolve(__dirname, "..");
const bp = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 1e4).toFixed(d)} bps` : "n/a");
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
const num = (x: number | null, d = 2) => (x !== null && Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pv = (x: number) => (!Number.isFinite(x) ? "-" : x < 0.001 ? "<0.001" : x.toFixed(3));
const pol = (p: number) => (p === 1 ? "Drive" : "Reverse");
const mdTable = (head: string[], rows: string[][]) => {
  const l = (c: string[]) => `| ${c.join(" | ")} |`;
  return [l(head), l(head.map(() => "---")), ...rows.map(l)].join("\n");
};

/* ---- Student-t two-sided p-value (regularized incomplete beta) ---- */
function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
const tTwoSidedP = (t: number, df: number) => (df >= 1 ? betai(df / 2, 0.5, df / (df + t * t)) : NaN);

type Cl = { n: number; clusters: number; mean: number; se: number; p: number };
/** items must be sorted by block ascending. */
function clustered(items: { block: number; v: number }[]): Cl {
  const n = items.length;
  if (n === 0) return { n: 0, clusters: 0, mean: NaN, se: NaN, p: NaN };
  const mean = items.reduce((s, x) => s + x.v, 0) / n;
  let ss = 0, clusters = 0, cur = -1, S = 0;
  for (const it of items) {
    if (it.block !== cur) { if (cur !== -1) ss += S * S; cur = it.block; S = 0; clusters++; }
    S += it.v - mean;
  }
  ss += S * S;
  const se = Math.sqrt(ss) / n;
  const p = se > 0 && clusters > 1 ? tTwoSidedP(mean / se, clusters - 1) : NaN;
  return { n, clusters, mean, se, p };
}

type Row = { ratio: number; polarity: 1 | -1; horizon: number; dev: Cl; hold: Cl; candidate: boolean; confirmed: boolean };

async function main() {
  const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const bars = new Map<string, Bar[]>();
  for (const t of TICKERS) {
    const { bars: b } = await loadBars(t, { feed: "sip", start: START, refresh: false }, end);
    if (b.length < 500) throw new Error(`${t}: only ${b.length} bars; refusing to run on a truncated universe.`);
    bars.set(t, b);
    console.log(`  ${t}: ${b.length} bars, ${b[0].date} -> ${b[b.length - 1].date}`);
  }

  const calendar = [...new Set([...bars.values()].flatMap((b) => b.map((x) => x.date)))].sort();
  const dayIdx = new Map(calendar.map((d, i) => [d, i]));

  const obsByRatio = new Map<number, Map<string, Observation[]>>();
  for (const ratio of RATIOS) {
    const m = new Map<string, Observation[]>();
    for (const [t, b] of bars) m.set(t, collectObservations(t, b, { noiseFloorRatio: ratio }));
    obsByRatio.set(ratio, m);
  }

  const fwd = (o: Observation, H: number) => o.fwd[`nextOpen:${H}`];
  const inDev = (t: string, o: Observation) => {
    const b = bars.get(t)!;
    const ex = b[o.index + PURGE];
    return o.date < SPLIT && !!ex && ex.date < SPLIT;
  };
  const inHold = (o: Observation) => o.date >= SPLIT;
  const sampleOf = (which: "dev" | "hold") => (t: string, o: Observation) => (which === "dev" ? inDev(t, o) : inHold(o));

  // per-ticker mean forward return (drift) per sample/horizon, over ALL ready observations
  const drift = (ratio: number, which: "dev" | "hold", H: number) => {
    const out = new Map<string, number>();
    const pick = sampleOf(which);
    for (const [t, obs] of obsByRatio.get(ratio)!) {
      let s = 0, n = 0;
      for (const o of obs) { const f = fwd(o, H); if (f !== null && pick(t, o)) { s += f; n++; } }
      out.set(t, n ? s / n : 0);
    }
    return out;
  };

  const bucket = (ratio: number, polarity: 1 | -1, H: number, which: "dev" | "hold", only?: string, exclude?: string) => {
    const dr = drift(ratio, which, H);
    const pick = sampleOf(which);
    const items: { block: number; v: number; t: string }[] = [];
    for (const [t, obs] of obsByRatio.get(ratio)!) {
      if ((only && t !== only) || (exclude && t === exclude)) continue;
      for (const o of obs) {
        const f = fwd(o, H);
        if (f === null || o.polarity !== polarity || !pick(t, o)) continue;
        items.push({ block: Math.floor(dayIdx.get(o.date)! / (2 * H)), v: polarity * (f - dr.get(t)!), t });
      }
    }
    items.sort((a, b) => a.block - b.block);
    return { cl: clustered(items), items };
  };

  const rows: Row[] = [];
  const freq: { ratio: number; drive: number; neutral: number; reverse: number }[] = [];
  for (const ratio of RATIOS) {
    const f = { ratio, drive: 0, neutral: 0, reverse: 0 };
    for (const obs of obsByRatio.get(ratio)!.values()) for (const o of obs) {
      if (o.polarity === 1) f.drive++; else if (o.polarity === -1) f.reverse++; else f.neutral++;
    }
    freq.push(f);
    for (const polarity of [1, -1] as const) for (const H of HORIZONS) {
      const dev = bucket(ratio, polarity, H, "dev").cl;
      const hold = bucket(ratio, polarity, H, "hold").cl;
      const candidate = dev.n >= MIN_N_DEV && Number.isFinite(dev.p) && dev.p < ALPHA_DEV && dev.mean !== 0;
      const confirmed = candidate && hold.n >= MIN_N_HOLD && Number.isFinite(hold.p) && hold.p < ALPHA_HOLD && Math.sign(hold.mean) === Math.sign(dev.mean);
      rows.push({ ratio, polarity, horizon: H, dev, hold, candidate, confirmed });
    }
    console.log(`  floor ${ratio}x done`);
  }
  const candidates = rows.filter((r) => r.candidate);
  const confirmed = rows.filter((r) => r.confirmed);

  /* strategy / tradeability stage */
  const bhBlend = equalWeightPortfolio([...bars.values()].map((b) => windowSeries(buyHoldSeries(b), SPLIT)));
  const bh = perfMetrics(bhBlend.returns);
  const rt = (mult: number) => (2 * COST_BPS * mult) / 1e4; // round-trip cost fraction
  const strat = confirmed.map((r) => {
    const follow = r.dev.mean > 0; // directional edge: > 0 means moved WITH the signal
    const name = `${pol(r.polarity)} ${r.horizon}D @ ${r.ratio}x ${follow ? "(follow)" : "(fade)"}`;
    const hb = bucket(r.ratio, r.polarity, r.horizon, "hold");
    const perTicker = TICKERS.map((t) => {
      const items = hb.items.filter((x) => x.t === t);
      const sum = items.reduce((s, x) => s + x.v, 0);
      return { t, n: items.length, mean: items.length ? sum / items.length : NaN, sum };
    });
    // the matching direction: directional edge is polarity-signed; if dev edge < 0 we fade, so profit = -edge
    const sgn = follow ? 1 : -1;
    const gross = sgn * hb.cl.mean;
    const best = [...perTicker].sort((a, b) => sgn * b.sum - sgn * a.sum)[0];
    const hbEx = bucket(r.ratio, r.polarity, r.horizon, "hold", undefined, best.t).cl;
    const grossEx = sgn * hbEx.mean;
    const cfg: StrategyConfig = {
      name, holdDays: r.horizon, allowShort: true, costBps: COST_BPS, noiseFloorRatio: r.ratio,
      invert: !follow, sides: r.polarity === 1 ? "drive" : "reverse",
    };
    const run = (c: StrategyConfig) => {
      const per = [...bars.values()].map((b) => runStrategy(b, c));
      const blend = equalWeightPortfolio(per.map((x) => windowSeries(x, SPLIT)));
      const trades: Trade[] = per.flatMap((x) => x.trades.filter((t) => t.entryDate >= SPLIT));
      return { perf: perfMetrics(blend.returns), trade: tradeMetrics(trades) };
    };
    const net = run(cfg);
    const stress = run({ ...cfg, costBps: COST_BPS * 2 });
    const gateA = gross - rt(1) > 0 && gross - rt(2) > 0;
    const gateB = grossEx - rt(1) > 0 && grossEx - rt(2) > 0;
    const gateC = net.perf.sharpe > 0;
    return {
      name, row: r, gross, grossEx, bestTicker: best.t, perTicker, net, stress,
      netEdge1: gross - rt(1), netEdge2: gross - rt(2), gateA, gateB, gateC, tradeable: gateA && gateB && gateC,
    };
  });

  /* verdict */
  let verdict: string;
  if (candidates.length === 0) {
    verdict =
      `No bucket cleared the development bar across the 10 stocks (24 tests, date-clustered Bonferroni p < ${ALPHA_DEV.toFixed(4)}). ` +
      `The signal shows no statistically defensible drift-adjusted edge on these names at 1/5/20-day horizons.`;
  } else if (confirmed.length === 0) {
    verdict = `${candidates.length} development candidate(s), NONE confirmed in the ${SPLIT.slice(0, 4)}+ hold-out. Treat as noise.`;
  } else if (strat.every((s) => !s.tradeable)) {
    verdict =
      `${confirmed.length} bucket(s) confirmed out-of-sample as statistically real, but none is tradeable: the drift-adjusted edge per signal ` +
      `does not clear a ${COST_BPS * 2} bps round trip (and its ${COST_BPS * 4} bps stress), and/or depends on one ticker, and/or the strategy Sharpe is not positive.`;
  } else {
    verdict =
      `LEAD (not proof): ${strat.filter((s) => s.tradeable).map((s) => s.name).join("; ")} passed every gate. ` +
      `Not clean out-of-sample (see caveats): forward-test before risking capital.`;
  }

  /* report */
  const md: string[] = [];
  md.push(`# Top-10 SPY holdings study (daily)`);
  md.push(`Generated ${new Date().toISOString().slice(0, 10)} | feed \`sip\` | ${TICKERS.join(", ")} | development < ${SPLIT} <= hold-out | cost ${COST_BPS} bps/side`);
  md.push(`\n**Verdict:** ${verdict}`);
  md.push(`\n## Protocol (fixed before looking at results)`);
  md.push([
    `1. Universe (fixed up front, approximating SPY's ten largest holdings): ${TICKERS.join(", ")}. GOOG kept, GOOGL excluded (same company).`,
    `2. Floors ${RATIOS.join("x, ")}x x Drive/Reverse x 1D/5D/20D = ${FAMILY} tests. Entry = next open.`,
    `3. Directional edge = polarity x (forward return - that ticker's own average forward return in the same sample). > 0: stock moved WITH the signal; < 0: AGAINST it.`,
    `4. Pooled across tickers; p-values clustered in blocks of 2H sessions (cross-stock same-day correlation + overlapping windows), Student-t on clusters-1 d.f. Dev bar: Bonferroni ${ALPHA_DEV.toFixed(4)}, n >= ${MIN_N_DEV}.`,
    `5. Dev signals whose 20-session window reaches ${SPLIT} are purged. Hold-out used once: same sign, p < ${ALPHA_HOLD}, n >= ${MIN_N_HOLD}.`,
    `6. Tradeable = (a) edge per signal minus round-trip cost > 0 at ${COST_BPS} and ${COST_BPS * 2} bps/side, (b) same after removing the best ticker, (c) positive net Sharpe of the equal-weight strategy.`,
  ].join("\n"));

  md.push(`\n## 1. How often does each floor fire (all 10 stocks)?`);
  md.push(mdTable(["Floor", "Drive", "Neutral", "Reverse"], freq.map((f) => {
    const t = f.drive + f.neutral + f.reverse;
    return [`${f.ratio}x`, pct(f.drive / t), pct(f.neutral / t), pct(f.reverse / t)];
  })));

  md.push(`\n## 2. Directional edge by floor: development vs hold-out`);
  md.push(`Expect about ${(FAMILY * 0.05).toFixed(1)} of ${FAMILY} buckets to look "significant" at 5% by luck; the dev gate is Bonferroni-corrected.\n`);
  md.push(mdTable(
    ["Floor", "Signal", "Horizon", "Dev n", "Dev edge", "Dev p", "Hold n", "Hold edge", "Hold p", "Candidate", "Confirmed"],
    rows.map((r) => [
      `${r.ratio}x`, pol(r.polarity), `${r.horizon}D`, String(r.dev.n), bp(r.dev.mean), pv(r.dev.p),
      String(r.hold.n), bp(r.hold.mean), pv(r.hold.p), r.candidate ? "YES" : "-", r.confirmed ? "YES" : "-",
    ]),
  ));

  md.push(`\n## 3. Tradeability of confirmed buckets (hold-out ${SPLIT}+)`);
  if (strat.length === 0) {
    md.push(`No bucket confirmed, so no strategy was run (testing unconfirmed buckets would data-mine the hold-out).`);
  } else {
    md.push(mdTable(
      ["Strategy", "Profit/signal (drift-adj.)", `Net @${COST_BPS}bp/side`, `Net @${COST_BPS * 2}bp/side`, "Without best ticker", "Best ticker", "Net Sharpe", "Net total", "Gates a/b/c", "Tradeable"],
      [
        ["Buy & hold (equal-weight 10)", "-", "-", "-", "-", "-", num(bh.sharpe), pct(bh.totalReturn), "-", "-"],
        ...strat.map((s) => [
          s.name, bp(s.gross), bp(s.netEdge1), bp(s.netEdge2), bp(s.grossEx), s.bestTicker, num(s.net.perf.sharpe), pct(s.net.perf.totalReturn),
          `${s.gateA ? "Y" : "n"}/${s.gateB ? "Y" : "n"}/${s.gateC ? "Y" : "n"}`, s.tradeable ? "YES" : "no",
        ]),
      ],
    ));
    md.push(`\n### Hold-out profit per signal, by ticker (n)`);
    md.push(mdTable(["Strategy", ...TICKERS.map((t) => `${t}${SEEN_BEFORE.has(t) ? "*" : ""}`)], strat.map((s) => {
      const sgn = s.row.dev.mean > 0 ? 1 : -1;
      return [s.name, ...s.perTicker.map((x) => (x.n ? `${bp(sgn * x.mean)} (${x.n})` : "-"))];
    })));
    md.push(`\n\\* = also in the earlier 13-ticker discovery set.`);
  }

  md.push(`\n## Caveats`);
  md.push([
    `- **Not clean out-of-sample.** NVDA, MSFT, AAPL, AMZN, META, TSLA and JPM (and GOOGL, the twin of GOOG) were in the earlier 13-ticker discovery set, and AVGO was in the earlier 39-stock validation list; all covered the same period. Only BRK.B is untouched. (* in the by-ticker table marks names used before.)`,
    `- **Survivorship.** Today's top 10 are mostly the 2016-2026 winners. The drift adjustment removes this from the event study; buy & hold and any long-biased equity curve are still flattered.`,
    `- The universe approximates SPY's top 10 and was fixed before testing; live weights were not verified.`,
    `- ${COST_BPS} bps/side is a fair estimate for these mega-caps at the open; the earlier broad study used 5 bps. Short-borrow fees are ignored.`,
    `- With few clusters at 20D (about ${Math.round(calendar.length / 40)} blocks over the full sample) p-values are coarse.`,
    `- Same-date stocks are correlated, so 10 stocks are worth far fewer than 10 independent samples.`,
  ].join("\n"));

  fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "reports", "top10-study.md"), md.join("\n") + "\n");
  fs.writeFileSync(
    path.join(ROOT, "reports", "top10-study.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      protocol: { TICKERS, RATIOS, SPLIT, MIN_N_DEV, MIN_N_HOLD, FAMILY, ALPHA_DEV, ALPHA_HOLD, COST_BPS },
      verdict, frequency: freq, rows, buyHoldHoldout: bh, strategies: strat,
    }, null, 2),
  );

  console.log(`\nVerdict: ${verdict}\n`);
  console.log(mdTable(["Floor", "Drive", "Neutral", "Reverse"], freq.map((f) => {
    const t = f.drive + f.neutral + f.reverse;
    return [`${f.ratio}x`, pct(f.drive / t), pct(f.neutral / t), pct(f.reverse / t)];
  })));
  console.log("\n" + mdTable(
    ["Floor", "Sig", "H", "Dev n", "Dev edge", "Dev p", "Hold n", "Hold edge", "Hold p", "Cand", "Conf"],
    rows.map((r) => [`${r.ratio}x`, pol(r.polarity), `${r.horizon}D`, String(r.dev.n), bp(r.dev.mean), pv(r.dev.p),
      String(r.hold.n), bp(r.hold.mean), pv(r.hold.p), r.candidate ? "YES" : "-", r.confirmed ? "YES" : "-"]),
  ));
  if (strat.length) {
    console.log("\n" + mdTable(["Strategy", "Profit/signal", "Net 2bp", "Net 4bp", "No best", "Best", "Sharpe", "a/b/c", "Tradeable"], strat.map((s) => [
      s.name, bp(s.gross), bp(s.netEdge1), bp(s.netEdge2), bp(s.grossEx), s.bestTicker, num(s.net.perf.sharpe),
      `${s.gateA ? "Y" : "n"}/${s.gateB ? "Y" : "n"}/${s.gateC ? "Y" : "n"}`, s.tradeable ? "YES" : "no",
    ])));
    console.log(`\nBuy & hold (equal-weight 10, hold-out): ${pct(bh.totalReturn)}, Sharpe ${num(bh.sharpe)}`);
  }
  console.log("\nFull report: reports/top10-study.md");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
