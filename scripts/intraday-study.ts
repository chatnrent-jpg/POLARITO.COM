/**
 * SPY intraday (5-minute) study of the Net Volume / Noise Floor signal.
 *
 *   npm run intraday-study            (uses cache)
 *   npm run intraday-study -- --refresh
 *
 * Research script only: nothing here touches the live app.
 *
 * PROTOCOL (fixed in code BEFORE any result was looked at)
 *   Data    SPY 5-minute bars, SIP feed, regular hours only (09:30-16:00 ET,
 *           78 bars/session), 2016-01-04 on. A session without exactly 78 clean
 *           bars (early closes, gaps, malformed prints) is dropped, not patched.
 *   Signal  The live engine's own netVolume() and gate() applied to each 5-min
 *           bar. The noise floor = ratio x the mean volume of the SAME time slot
 *           over the previous 20 kept sessions (same-slot, so the U-shaped
 *           intraday volume curve cannot trigger the floor on its own).
 *   Entry   Signal known at the close of bar s. Entry = open of bar s+1. Hold H
 *           bars, exit = close of bar s+H. Nothing is ever held overnight; a
 *           signal whose exit would fall after the close is not taken.
 *   Test    16 tests: floors {0.1, 1, 2, 3} x {Drive, Reverse} x H {1 bar = 5 min,
 *           6 bars = 30 min}. Edge = forward return minus the average forward
 *           return of the same time slot in the same sample (removes the known
 *           time-of-day drift). Significance is day-clustered (bars within a
 *           session are not independent), two-sided, Bonferroni 0.05 / 16.
 *   Split   Development = sessions before SPLIT, hold-out = on/after. Candidates
 *           come from development only; n >= MIN_N_DEV. Hold-out is used once to
 *           confirm: same sign, p < 0.05, n >= MIN_N_HOLD.
 *   Trade   Confirmed buckets only. Direction = sign of the dev edge (follow or
 *           fade). TRADEABLE = positive net per-signal expectancy at COST_BPS per
 *           side AND at double that, AND positive net Sharpe of the non-overlapping
 *           simulation. An extra-bar entry delay is reported as a diagnostic.
 *
 * Caveats stated up front: entry at the next bar's open ignores real latency;
 * costs are a flat per-side bps (no queueing or adverse selection); SPY only.
 */
import fs from "node:fs";
import path from "node:path";
import { gate, netVolume, type Bar } from "../src/lib/polarity";
import { perfMetrics } from "../src/lib/backtester";

/* ---------------- frozen parameters ---------------- */
const TICKER = "SPY";
const START_YEAR = 2016;
const RATIOS = [0.1, 1.0, 2.0, 3.0] as const;
const HOLDS = [1, 6] as const; // bars
const SPLIT = "2022-01-01";
const SLOTS = 78;
const OPEN_MIN = 570; // 09:30 ET
const LOOKBACK = 20;
const MIN_N_DEV = 1000;
const MIN_N_HOLD = 400;
const FAMILY = RATIOS.length * 2 * HOLDS.length; // 16
const ALPHA_DEV = 0.05 / FAMILY;
const ALPHA_HOLD = 0.05;
const COST_BPS = 1; // per side; doubled for the stress gate
/* --------------------------------------------------- */

const ROOT = path.resolve(__dirname, "..");
const BARS_URL = "https://data.alpaca.markets/v2/stocks/bars";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bps = (x: number, d = 2) => (Number.isFinite(x) ? `${(x * 1e4).toFixed(d)} bps` : "n/a");
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
const num = (x: number | null, d = 2) => (x !== null && Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pv = (x: number) => (!Number.isFinite(x) ? "-" : x < 0.001 ? "<0.001" : x.toFixed(3));
const pol = (p: number) => (p === 1 ? "Drive" : "Reverse");
const mdTable = (head: string[], rows: string[][]) => {
  const l = (c: string[]) => `| ${c.join(" | ")} |`;
  return [l(head), l(head.map(() => "---")), ...rows.map(l)].join("\n");
};

/* ------------------------------ data ------------------------------ */
type RawBar = { d: string; m: number; o: number; h: number; l: number; c: number; v: number; ok: boolean };

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function toET(iso: string): { d: string; m: number } {
  const parts = etFmt.formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { d: `${g("year")}-${g("month")}-${g("day")}`, m: Number(g("hour")) * 60 + Number(g("minute")) };
}

async function fetchChunk(start: string, end: string): Promise<unknown[]> {
  const keyId = process.env.ALPACA_API_KEY_ID?.trim();
  const secret = process.env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secret) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY missing (.env.local).");
  const raw: unknown[] = [];
  let token: string | null = null;
  for (let page = 0; page < 60; page++) {
    // (the API returns ~2,200 rows per page despite limit=10000: a year needs ~22 pages)
    const url = new URL(BARS_URL);
    url.searchParams.set("symbols", TICKER);
    url.searchParams.set("timeframe", "5Min");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("adjustment", "all");
    url.searchParams.set("feed", "sip");
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", "10000");
    if (token) url.searchParams.set("page_token", token);
    type Page = { bars?: Record<string, unknown[]>; next_page_token?: string | null };
    let body = null as Page | null;
    for (let attempt = 0; attempt < 4 && body === null; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret, Accept: "application/json" },
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new Error("Network error or timeout talking to Alpaca.");
      }
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status === 401 || res.status === 403) throw new Error(`Alpaca rejected credentials/feed (HTTP ${res.status}).`);
      if (!res.ok) throw new Error(`Alpaca returned HTTP ${res.status}.`);
      try { body = (await res.json()) as Page; } catch { throw new Error("Alpaca returned invalid JSON."); }
    }
    if (body === null) throw new Error("Rate-limited by Alpaca after 4 attempts.");
    const rows = body.bars?.[TICKER];
    if (Array.isArray(rows)) raw.push(...rows);
    token = body.next_page_token ?? null;
    if (!token) return raw;
  }
  throw new Error("Exceeded page limit for one chunk; refusing partial data.");
}

async function loadIntraday(refresh: boolean): Promise<RawBar[]> {
  const file = path.join(ROOT, "data", "bars", "sip-5min", `${TICKER}_${START_YEAR}.json`);
  if (!refresh && fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { bars: RawBar[] };
      if (Array.isArray(parsed.bars) && parsed.bars.length > 0) return parsed.bars;
    } catch { /* corrupt cache: refetch */ }
  }
  const endDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const lastYear = Number(endDate.slice(0, 4));
  const out: RawBar[] = [];
  for (let y = START_YEAR; y <= lastYear; y++) {
    // completed years are cached on their own so one failure never refetches everything
    const yFile = path.join(ROOT, "data", "bars", "sip-5min", `${TICKER}_${y}.json`);
    if (!refresh && y < lastYear && fs.existsSync(yFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(yFile, "utf8")) as { bars: RawBar[] };
        if (Array.isArray(cached.bars) && cached.bars.length > 0) {
          out.push(...cached.bars);
          console.log(`  cached ${y}: ${cached.bars.length} regular-hours bars`);
          continue;
        }
      } catch { /* corrupt: refetch this year */ }
    }
    const yearBars: RawBar[] = [];
    const start = `${y}-01-01T00:00:00Z`;
    const end = y === lastYear ? `${endDate}T23:59:59Z` : `${y + 1}-01-01T00:00:00Z`;
    const rows = await fetchChunk(start, end);
    let kept = 0;
    for (const r of rows as Record<string, unknown>[]) {
      const t = String(r.t);
      const { d, m } = toET(t);
      if (m < OPEN_MIN || m >= OPEN_MIN + SLOTS * 5) continue; // regular hours only
      const o = Number(r.o), h = Number(r.h), l = Number(r.l), c = Number(r.c), v = Number(r.v);
      const ok =
        [o, h, l, c, v].every(Number.isFinite) && o > 0 && h > 0 && l > 0 && c > 0 && v >= 0 &&
        h >= l && h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9;
      yearBars.push({ d, m, o, h, l, c, v, ok });
      kept++;
    }
    out.push(...yearBars);
    if (y < lastYear) {
      fs.mkdirSync(path.dirname(yFile), { recursive: true });
      fs.writeFileSync(yFile, JSON.stringify({ ticker: TICKER, year: y, bars: yearBars }));
    }
    console.log(`  fetched ${y}: ${rows.length} raw, ${kept} regular-hours bars`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ticker: TICKER, feed: "sip", timeframe: "5Min", bars: out }));
  return out;
}

/* ---------------------------- statistics ---------------------------- */
function erfc(x: number): number {
  // Abramowitz-Stegun 7.1.26 (abs error ~1.5e-7)
  const t = 1 / (1 + 0.3275911 * x);
  const y = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592;
  return y * t * Math.exp(-x * x);
}
type Cl = { n: number; days: number; mean: number; se: number; p: number };
/** Day-clustered mean test: vals[i] belongs to day dayIdx[i] (ascending). */
function clustered(vals: number[], dayIdx: number[]): Cl {
  const n = vals.length;
  if (n === 0) return { n: 0, days: 0, mean: NaN, se: NaN, p: NaN };
  const mean = vals.reduce((s, x) => s + x, 0) / n;
  let ss = 0, days = 0, cur = -1, S = 0;
  for (let i = 0; i < n; i++) {
    if (dayIdx[i] !== cur) { if (cur !== -1) ss += S * S; cur = dayIdx[i]; S = 0; days++; }
    S += vals[i] - mean;
  }
  ss += S * S;
  const se = Math.sqrt(ss) / n;
  const p = se > 0 ? erfc(Math.abs(mean / se) / Math.SQRT2) : NaN;
  return { n, days, mean, se, p };
}

/* ------------------------------ main ------------------------------ */
async function main() {
  const refresh = process.argv.includes("--refresh");
  const rawBars = await loadIntraday(refresh);

  // group into sessions; keep only complete, clean 78-bar days
  const byDay = new Map<string, RawBar[]>();
  for (const b of rawBars) {
    const a = byDay.get(b.d);
    if (a) a.push(b); else byDay.set(b.d, [b]);
  }
  const dates = [...byDay.keys()].sort();
  const keep: string[] = [];
  let dropped = 0;
  for (const d of dates) {
    const bs = byDay.get(d)!.sort((a, b) => a.m - b.m);
    const complete = bs.length === SLOTS && bs.every((b, i) => b.ok && b.m === OPEN_MIN + i * 5);
    if (complete) keep.push(d); else dropped++;
  }
  const D = keep.length;
  const N = D * SLOTS;
  const o = new Float64Array(N), c = new Float64Array(N), v = new Float64Array(N), net = new Float64Array(N);
  keep.forEach((d, di) => {
    const bs = byDay.get(d)!.sort((a, b) => a.m - b.m);
    bs.forEach((b, s) => {
      const g = di * SLOTS + s;
      o[g] = b.o; c[g] = b.c; v[g] = b.v;
      const bar: Bar = { date: d, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v };
      net[g] = netVolume(bar);
    });
  });
  console.log(`SPY 5-min | ${D} sessions kept, ${dropped} dropped (not exactly 78 clean bars) | ${N} bars`);

  const splitDay = keep.findIndex((d) => d >= SPLIT);
  if (splitDay < LOOKBACK + 1) throw new Error("Split date leaves no development data.");
  const devRange: [number, number] = [LOOKBACK, splitDay];
  const holdRange: [number, number] = [splitDay, D];

  // same-slot trailing average volume (previous LOOKBACK kept sessions)
  const avg = new Float64Array(N).fill(NaN);
  for (let di = LOOKBACK; di < D; di++) {
    for (let s = 0; s < SLOTS; s++) {
      let sum = 0;
      for (let k = 1; k <= LOOKBACK; k++) sum += v[(di - k) * SLOTS + s];
      avg[di * SLOTS + s] = sum / LOOKBACK;
    }
  }

  // polarity per ratio
  const polBy = new Map<number, Int8Array>();
  const freq: { ratio: number; drive: number; neutral: number; reverse: number }[] = [];
  for (const ratio of RATIOS) {
    const p = new Int8Array(N);
    const f = { ratio, drive: 0, neutral: 0, reverse: 0 };
    for (let di = LOOKBACK; di < D; di++) {
      for (let s = 0; s < SLOTS; s++) {
        const g = di * SLOTS + s;
        const pol_ = gate(net[g], avg[g] * ratio);
        p[g] = pol_;
        if (pol_ === 1) f.drive++; else if (pol_ === -1) f.reverse++; else f.neutral++;
      }
    }
    polBy.set(ratio, p);
    freq.push(f);
  }

  const fwd = (g: number, H: number, L: number) => c[g + L + H] / o[g + 1 + L] - 1;
  const valid = (s: number, H: number, L: number) => s + L + H <= SLOTS - 1;

  // slot-matched baseline per (H, L, sample, slot)
  const baseline = (H: number, L: number, [lo, hi]: [number, number]) => {
    const sum = new Float64Array(SLOTS), cnt = new Float64Array(SLOTS);
    for (let di = lo; di < hi; di++) for (let s = 0; s < SLOTS; s++) {
      if (!valid(s, H, L)) continue;
      sum[s] += fwd(di * SLOTS + s, H, L); cnt[s]++;
    }
    return Array.from(sum, (x, s) => (cnt[s] ? x / cnt[s] : 0));
  };

  type Row = { ratio: number; polarity: 1 | -1; hold: number; dev: Cl; hd: Cl; candidate: boolean; confirmed: boolean };
  const rows: Row[] = [];
  const edgeStats = (ratio: number, polarity: number, H: number, range: [number, number], base: number[]): Cl => {
    const p = polBy.get(ratio)!;
    const vals: number[] = [], dayIdx: number[] = [];
    for (let di = range[0]; di < range[1]; di++) for (let s = 0; s < SLOTS; s++) {
      const g = di * SLOTS + s;
      if (p[g] !== polarity || !valid(s, H, 0)) continue;
      vals.push(fwd(g, H, 0) - base[s]); dayIdx.push(di);
    }
    return clustered(vals, dayIdx);
  };
  for (const H of HOLDS) {
    const bDev = baseline(H, 0, devRange);
    const bHold = baseline(H, 0, holdRange);
    for (const ratio of RATIOS) for (const polarity of [1, -1] as const) {
      const dev = edgeStats(ratio, polarity, H, devRange, bDev);
      const hd = edgeStats(ratio, polarity, H, holdRange, bHold);
      const candidate = dev.n >= MIN_N_DEV && dev.p < ALPHA_DEV && dev.mean !== 0;
      const confirmed = candidate && hd.n >= MIN_N_HOLD && hd.p < ALPHA_HOLD && Math.sign(hd.mean) === Math.sign(dev.mean);
      rows.push({ ratio, polarity, hold: H, dev, hd, candidate, confirmed });
    }
    console.log(`  hold ${H} bars done`);
  }
  rows.sort((a, b) => a.ratio - b.ratio || b.polarity - a.polarity || a.hold - b.hold);
  const candidates = rows.filter((r) => r.candidate);
  const confirmed = rows.filter((r) => r.confirmed);

  /* strategy stage (confirmed only) */
  const dayRet = (di: number) => c[di * SLOTS + SLOTS - 1] / c[(di - 1) * SLOTS + SLOTS - 1] - 1;
  const holdDays = holdRange[1] - holdRange[0];
  const bhPerf = perfMetrics(Array.from({ length: holdDays }, (_, i) => dayRet(holdRange[0] + i)));

  // The intraday edge is the RAW forward return minus the slot average (not direction-adjusted),
  // so the trade direction is simply the sign of the development edge.
  const dirOf = (r: Row) => Math.sign(r.dev.mean);
  const modeOf = (r: Row) => (dirOf(r) === r.polarity ? "(follow)" : "(fade)");
  const sigVals = (r: Row, L: number) => {
    const p = polBy.get(r.ratio)!;
    const pos = dirOf(r);
    const vals: number[] = [], dayIdx: number[] = [];
    for (let di = holdRange[0]; di < holdRange[1]; di++) for (let s = 0; s < SLOTS; s++) {
      const g = di * SLOTS + s;
      if (p[g] !== r.polarity || !valid(s, r.hold, L)) continue;
      vals.push(pos * fwd(g, r.hold, L)); dayIdx.push(di);
    }
    return { vals, dayIdx };
  };
  const simulate = (r: Row, costBps: number) => {
    const p = polBy.get(r.ratio)!;
    const pos = dirOf(r);
    const daily = new Array<number>(holdDays).fill(0);
    let trades = 0, wins = 0, barsHeld = 0;
    for (let di = holdRange[0]; di < holdRange[1]; di++) {
      let free = 0;
      for (let s = 0; s < SLOTS; s++) {
        const g = di * SLOTS + s;
        if (s < free || p[g] !== r.polarity || !valid(s, r.hold, 0)) continue;
        const pnl = pos * fwd(g, r.hold, 0) - (2 * costBps) / 1e4;
        daily[di - holdRange[0]] += pnl;
        trades++; if (pnl > 0) wins++;
        barsHeld += r.hold;
        free = s + r.hold;
      }
    }
    return { perf: perfMetrics(daily), trades, wins, exposure: barsHeld / (holdDays * SLOTS) };
  };
  const part = (s: number) => (s < 6 ? "first 30 min" : s >= SLOTS - 6 ? "last 30 min" : "midday");
  const strat = confirmed.map((r) => {
    const name = `${pol(r.polarity)} ${r.hold * 5}min @ ${r.ratio}x ${modeOf(r)}`;
    const sv = sigVals(r, 0);
    const cl = clustered(sv.vals, sv.dayIdx);
    const net1 = cl.mean - (2 * COST_BPS) / 1e4;
    const net2 = cl.mean - (4 * COST_BPS) / 1e4;
    const net4 = cl.mean - (8 * COST_BPS) / 1e4;
    const netP = cl.se > 0 ? erfc(Math.abs(net1 / cl.se) / Math.SQRT2) : NaN;
    const sim = simulate(r, COST_BPS);
    const dl = sigVals(r, 1);
    const clDelay = clustered(dl.vals, dl.dayIdx);
    // session-part and per-year breakdown of gross directional return
    const p = polBy.get(r.ratio)!;
    const pos = dirOf(r);
    const byPart: Record<string, { n: number; sum: number }> = {};
    for (let di = holdRange[0]; di < holdRange[1]; di++) for (let s = 0; s < SLOTS; s++) {
      const g = di * SLOTS + s;
      if (p[g] !== r.polarity || !valid(s, r.hold, 0)) continue;
      const k = part(s);
      (byPart[k] ??= { n: 0, sum: 0 });
      byPart[k].n++; byPart[k].sum += pos * fwd(g, r.hold, 0);
    }
    const byYear: Record<string, { n: number; sum: number }> = {};
    for (let di = devRange[0]; di < D; di++) for (let s = 0; s < SLOTS; s++) {
      const g = di * SLOTS + s;
      if (p[g] !== r.polarity || !valid(s, r.hold, 0)) continue;
      const y = keep[di].slice(0, 4);
      (byYear[y] ??= { n: 0, sum: 0 });
      byYear[y].n++; byYear[y].sum += pos * fwd(g, r.hold, 0);
    }
    return {
      name, row: r, gross: cl, net1, net2, net4, netP, sim, delayGross: clDelay.mean, delayNet1: clDelay.mean - (2 * COST_BPS) / 1e4,
      byPart, byYear,
      tradeable: net1 > 0 && net2 > 0 && sim.perf.sharpe > 0,
    };
  });

  /* verdict */
  let verdict: string;
  if (candidates.length === 0) {
    verdict =
      `No 5-minute SPY bucket cleared the development bar (16 tests, day-clustered Bonferroni p < ${ALPHA_DEV.toFixed(4)}). ` +
      `At roughly ${Math.round(rows[0].dev.n)} signals per bucket, this test can resolve edges well below one basis point, so the absence is informative: ` +
      `the signal does not predict SPY at this resolution either.`;
  } else if (confirmed.length === 0) {
    verdict = `${candidates.length} development candidate(s), NONE confirmed in the ${SPLIT.slice(0, 4)}+ hold-out. Treat as noise.`;
  } else if (strat.every((s) => !s.tradeable)) {
    verdict =
      `${confirmed.length} bucket(s) confirmed out-of-sample as statistically real, but none is tradeable: after ${COST_BPS} bp/side ` +
      `(and the doubled stress) the matching strategy does not stay positive with a positive Sharpe.`;
  } else {
    verdict =
      `LEAD (not proof): ${strat.filter((s) => s.tradeable).map((s) => s.name).join("; ")} confirmed out-of-sample and survived doubled costs. ` +
      `Check the entry-delay diagnostic before believing it; then forward-test.`;
  }

  /* report */
  const md: string[] = [];
  md.push(`# SPY intraday (5-minute) study`);
  md.push(
    `Generated ${new Date().toISOString().slice(0, 10)} | feed \`sip\` | ${D} sessions (${dropped} dropped) | ${N} bars | ` +
      `development < ${SPLIT} <= hold-out | cost ${COST_BPS} bp/side`,
  );
  md.push(`\n**Verdict:** ${verdict}`);
  md.push(`\n## Protocol (fixed before looking at results)`);
  md.push(
    [
      `1. Signal = the live \`netVolume()\` + \`gate()\` on each 5-min bar. Noise floor = ratio x mean volume of the same time slot over the previous ${LOOKBACK} sessions.`,
      `2. Floors ${RATIOS.join("x, ")}x (0.1x = the daily-chart default) x Drive/Reverse x ${HOLDS.map((h) => `${h * 5} min`).join(" / ")} = ${FAMILY} tests.`,
      `3. Entry = open of the next bar; exit = close of bar s+H; no overnight holds.`,
      `4. Edge = forward return minus the same-time-slot average in the same sample. p-values are day-clustered, two-sided; dev bar = Bonferroni ${ALPHA_DEV.toFixed(4)}, n >= ${MIN_N_DEV}.`,
      `5. Hold-out used once: same sign, p < ${ALPHA_HOLD}, n >= ${MIN_N_HOLD}.`,
      `6. Tradeable = positive net expectancy at ${COST_BPS} bp and ${COST_BPS * 2} bp per side AND positive net Sharpe (non-overlapping simulation). Entry delay is a diagnostic only.`,
    ].join("\n"),
  );
  md.push(`\n## 1. How often does each floor fire?`);
  md.push(mdTable(["Floor", "Drive", "Neutral", "Reverse"], freq.map((f) => {
    const t = f.drive + f.neutral + f.reverse;
    return [`${f.ratio}x`, pct(f.drive / t), pct(f.neutral / t), pct(f.reverse / t)];
  })));
  md.push(`\n## 2. Edge by floor: development vs hold-out`);
  md.push(`Edge = raw forward return after the signal minus the same-time-slot average (> 0: SPY rose more than usual; < 0: fell). It is NOT direction-adjusted: after a Drive signal a negative edge means a fade (short) would profit; after a Reverse signal a positive edge means a fade (long) would profit.\n`);
  md.push(mdTable(
    ["Floor", "Signal", "Hold", "Dev n", "Dev edge", "Dev p", "Hold n", "Hold edge", "Hold p", "Candidate", "Confirmed"],
    rows.map((r) => [
      `${r.ratio}x`, pol(r.polarity), `${r.hold * 5}m`, String(r.dev.n), bps(r.dev.mean), pv(r.dev.p),
      String(r.hd.n), bps(r.hd.mean), pv(r.hd.p), r.candidate ? "YES" : "-", r.confirmed ? "YES" : "-",
    ]),
  ));
  md.push(`\n## 3. Tradeability of confirmed buckets (hold-out ${SPLIT}+)`);
  if (strat.length === 0) {
    md.push(`No bucket confirmed, so no strategy was run (testing unconfirmed buckets would data-mine the hold-out).`);
  } else {
    md.push(mdTable(
      ["Strategy", "Gross / signal", `Net @${COST_BPS}bp`, `Net @${COST_BPS * 2}bp`, `Net @${COST_BPS * 4}bp`, "Net p", "Sim trades", "Win rate", "Net total", "Net Sharpe", "Exposure", "Tradeable"],
      [
        ["Buy & hold SPY", "-", "-", "-", "-", "-", "-", "-", pct(bhPerf.totalReturn), num(bhPerf.sharpe), "100%", "-"],
        ...strat.map((s) => [
          s.name, bps(s.gross.mean), bps(s.net1), bps(s.net2), bps(s.net4), pv(s.netP), String(s.sim.trades),
          pct(s.sim.trades ? s.sim.wins / s.sim.trades : NaN), pct(s.sim.perf.totalReturn), num(s.sim.perf.sharpe),
          pct(s.sim.exposure, 2), s.tradeable ? "YES" : "no",
        ]),
      ],
    ));
    md.push(`\n### Diagnostics`);
    md.push(mdTable(
      ["Strategy", "Gross (normal entry)", "Gross (1-bar-late entry)", "Net @1bp (1-bar-late)", "Gross first 30m (n)", "Gross midday (n)", "Gross last 30m (n)"],
      strat.map((s) => {
        const f = (k: string) => (s.byPart[k] ? `${bps(s.byPart[k].sum / s.byPart[k].n)} (${s.byPart[k].n})` : "-");
        return [s.name, bps(s.gross.mean), bps(s.delayGross), bps(s.delayNet1), f("first 30 min"), f("midday"), f("last 30 min")];
      }),
    ));
    const yrs = [...new Set(strat.flatMap((s) => Object.keys(s.byYear)))].sort();
    md.push(`\n### Gross directional return per signal, by year (n)`);
    md.push(mdTable(["Strategy", ...yrs], strat.map((s) => [
      s.name, ...yrs.map((y) => (s.byYear[y] ? `${bps(s.byYear[y].sum / s.byYear[y].n, 1)} (${s.byYear[y].n})` : "-")),
    ])));
  }
  md.push(`\n## Caveats`);
  md.push([
    `- Entry at the next bar's open ignores real latency; the entry-delay diagnostic shows how fast any edge decays.`,
    `- ${COST_BPS} bp/side is a flat estimate for SPY with marketable orders; no queue position, adverse selection, or fees beyond that.`,
    `- ${dropped} sessions were dropped for not having exactly ${SLOTS} clean regular-hours bars (early closes, gaps, malformed prints); none were patched.`,
    `- Same-slot averages need ${LOOKBACK} prior sessions, so the first ${LOOKBACK} sessions are warm-up only.`,
    `- One ticker, one bar size, one split. A pass is a lead to forward-test, not proof.`,
  ].join("\n"));

  fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "reports", "intraday-study.md"), md.join("\n") + "\n");
  fs.writeFileSync(
    path.join(ROOT, "reports", "intraday-study.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      protocol: { TICKER, RATIOS, HOLDS, SPLIT, LOOKBACK, MIN_N_DEV, MIN_N_HOLD, FAMILY, ALPHA_DEV, ALPHA_HOLD, COST_BPS },
      sessions: D, dropped, verdict, frequency: freq, rows, buyHoldHoldout: bhPerf, strategies: strat,
    }, null, 2),
  );

  console.log(`\nVerdict: ${verdict}\n`);
  console.log(mdTable(["Floor", "Drive", "Neutral", "Reverse"], freq.map((f) => {
    const t = f.drive + f.neutral + f.reverse;
    return [`${f.ratio}x`, pct(f.drive / t), pct(f.neutral / t), pct(f.reverse / t)];
  })));
  console.log("\n" + mdTable(
    ["Floor", "Sig", "Hold", "Dev n", "Dev edge", "Dev p", "Hold n", "Hold edge", "Hold p", "Cand", "Conf"],
    rows.map((r) => [`${r.ratio}x`, pol(r.polarity), `${r.hold * 5}m`, String(r.dev.n), bps(r.dev.mean), pv(r.dev.p),
      String(r.hd.n), bps(r.hd.mean), pv(r.hd.p), r.candidate ? "YES" : "-", r.confirmed ? "YES" : "-"]),
  ));
  if (strat.length) {
    console.log("\n" + mdTable(["Strategy", "Gross", "Net1bp", "Net2bp", "Net4bp", "Trades", "Sharpe", "Tradeable"], strat.map((s) => [
      s.name, bps(s.gross.mean), bps(s.net1), bps(s.net2), bps(s.net4), String(s.sim.trades), num(s.sim.perf.sharpe), s.tradeable ? "YES" : "no",
    ])));
    console.log(`\nBuy & hold SPY (hold-out): ${pct(bhPerf.totalReturn)}, Sharpe ${num(bhPerf.sharpe)}`);
  }
  console.log("\nFull report: reports/intraday-study.md");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
