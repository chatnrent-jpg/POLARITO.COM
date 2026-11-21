/**
 * READ-ONLY study: how should the period-to-date net volume be computed, and how often do the choices disagree?
 *
 *   npx tsx scripts/spy-netvolume-methods.ts [--out-dir=/tmp/spy-study]
 *
 * Keyless (Yahoo public chart endpoint: SPY daily from 1993, SPY 5-minute for the last ~60 days). No secrets, no orders.
 *
 * Reading = one whole-period value (month, quarter, 6-month, year to date) as of each trading day. Methods:
 *   A  candle sign (what src/lib/chartBuckets.ts does today): net = +period volume if the period-to-date candle closed
 *      above its open, -period volume if below (close-location x volume if equal).
 *   B  signed daily sum: net = sum over the period's days of the repo's own daily netVolume (up-day volume minus
 *      down-day volume, day colour = close vs that day's open; flat day = close-location x volume).
 *   C  signed daily sum with the day colour taken from close vs the PREVIOUS close (the usual "up volume minus down
 *      volume" definition).
 *   B0 / C0 / D0  the same sums read by their plain SIGN (positive = Drive, negative = Reverse, no noise band).
 *   D  signed 5-minute sum: sum over the period's 5-minute bars of (+volume if close > open, -volume if below). Only the
 *      last ~60 sessions exist for free, so only periods that started inside that window can be built.
 * Every method uses the same gate as the engine: Drive if net > floor, Reverse if net < -floor, else Neutral, where
 * floor = sum of the period's daily noise floors (polarity.ts computePolaritySeries).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computePolaritySeries, gate, netVolume, type Bar, type Polarity } from "../src/lib/polarity";
import { addDays, COVERAGE_SLACK_DAYS } from "../src/lib/periodCandles";
import { bsDelta, bsPrice } from "../src/lib/optionsSelect";

const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const OUT_DIR = arg("out-dir", "/tmp/spy-study");
const CACHE = path.join(os.tmpdir(), "polarito-spy-bars");
const TFS = ["M", "Q", "H", "Y"] as const;
type TF = (typeof TFS)[number];
const NAMES: Record<TF, string> = { M: "Monthly", Q: "Quarterly", H: "6-month", Y: "Yearly" };
const METHODS = ["A", "B", "B0", "C", "C0"] as const;
type Method = (typeof METHODS)[number] | "D" | "D0";

type Raw = { ts: number[]; q: Record<string, (number | null)[]> };
async function yahoo(symbol: string, query: string, tag: string): Promise<Raw> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${symbol.replace(/\W/g, "_")}-${tag}-${new Date().toISOString().slice(0, 10)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as Raw;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60_000) });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, (number | null)[]>> } }> } };
      const r = body.chart?.result?.[0];
      if (!r?.timestamp || !r.indicators?.quote?.[0]) throw new Error("unexpected response shape");
      const out: Raw = { ts: r.timestamp, q: r.indicators.quote[0] };
      fs.writeFileSync(file, JSON.stringify(out));
      return out;
    } catch (e) {
      if (attempt === 3) throw new Error(`${symbol}: ${e instanceof Error ? e.message : "fetch failed"}`);
    }
  }
  throw new Error(`${symbol}: no data`);
}

const etDate = (sec: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(sec * 1000));
const utcDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const pad2 = (n: number) => String(n).padStart(2, "0");
function keyFor(date: string, tf: TF): string {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  switch (tf) {
    case "M": return `${y}-${pad2(m)}-01`;
    case "Q": return `${y}-${pad2(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
    case "H": return `${y}-${m <= 6 ? "01" : "07"}-01`;
    case "Y": return `${y}-01-01`;
  }
}

async function main(): Promise<void> {
  const daily = await yahoo("SPY", "period1=-631152000&period2=1900000000&interval=1d", "daily");
  const bars: Bar[] = [];
  let prev = "";
  for (let i = 0; i < daily.ts.length; i++) {
    const [o, h, l, c, v] = [daily.q.open[i], daily.q.high[i], daily.q.low[i], daily.q.close[i], daily.q.volume[i]];
    if (o == null || h == null || l == null || c == null || v == null || v <= 0 || o <= 0) continue;
    const date = utcDate(daily.ts[i]);
    if (date <= prev) continue;
    bars.push({ date, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume: v });
    prev = date;
  }
  const results = computePolaritySeries(bars);

  const m5raw = await yahoo("SPY", "range=60d&interval=5m", "5m");
  type M5 = { date: string; open: number; close: number; volume: number };
  const m5: M5[] = [];
  for (let i = 0; i < m5raw.ts.length; i++) {
    const [o, c, v] = [m5raw.q.open[i], m5raw.q.close[i], m5raw.q.volume[i]];
    if (o == null || c == null || v == null) continue;
    m5.push({ date: etDate(m5raw.ts[i]), open: o, close: c, volume: v });
  }
  const m5ByDate = new Map<string, { up: number; down: number; total: number }>();
  for (const b of m5) {
    const e = m5ByDate.get(b.date) ?? { up: 0, down: 0, total: 0 };
    if (b.close > b.open) e.up += b.volume;
    else if (b.close < b.open) e.down += b.volume;
    e.total += b.volume;
    m5ByDate.set(b.date, e);
  }
  const m5First = m5.length ? m5[0].date : "9999-12-31";

  type Row = { date: string; tf: TF; polarity: Record<Method, Polarity | null>; net: Record<Method, number | null>; floor: number; up: number; down: number; candleKind: string; open: number; close: number; volume: number };
  const rows: Row[] = [];
  const firstLoaded = bars[0].date;
  for (const tf of TFS) {
    let i0 = 0;
    let floorSum = 0;
    let floorReady = true;
    let sumB = 0;
    let sumC = 0;
    let up = 0;
    let down = 0;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let d5 = 0;
    let d5ok = true;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (i === 0 || keyFor(b.date, tf) !== keyFor(bars[i - 1].date, tf)) {
        i0 = i; floorSum = 0; floorReady = true; sumB = 0; sumC = 0; up = 0; down = 0; high = -Infinity; low = Infinity; volume = 0; d5 = 0; d5ok = true;
      }
      const f = results[i].noiseFloor;
      if (f === null) floorReady = false; else floorSum += f;
      const nv = netVolume(b);
      sumB += nv;
      if (nv > 0) up += nv; else if (nv < 0) down += -nv;
      const prevClose = i > 0 ? bars[i - 1].close : b.open;
      sumC += b.close > prevClose ? b.volume : b.close < prevClose ? -b.volume : 0;
      high = Math.max(high, b.high); low = Math.min(low, b.low); volume += b.volume;
      const e = m5ByDate.get(b.date);
      if (e) d5 += e.up - e.down; else d5ok = false;
      const covered = firstLoaded <= addDays(keyFor(b.date, tf), COVERAGE_SLACK_DAYS);
      if (!floorReady || !covered) continue;
      const candle: Bar = { date: b.date, open: bars[i0].open, high, low, close: b.close, volume };
      const netA = netVolume(candle);
      const polarity: Record<Method, Polarity | null> = { A: gate(netA, floorSum), B: gate(sumB, floorSum), B0: gate(sumB, 0), C: gate(sumC, floorSum), C0: gate(sumC, 0), D: null, D0: null };
      const net: Record<Method, number | null> = { A: netA, B: sumB, B0: sumB, C: sumC, C0: sumC, D: null, D0: null };
      if (d5ok && keyFor(b.date, tf) >= m5First) { polarity.D = gate(d5, floorSum); polarity.D0 = gate(d5, 0); net.D = d5; net.D0 = d5; }
      rows.push({ date: b.date, tf, polarity, net, floor: floorSum, up, down, candleKind: candle.close > candle.open ? "green" : candle.close < candle.open ? "red" : "flat", open: candle.open, close: candle.close, volume });
    }
  }

  const g = (p: Polarity | null) => (p === 1 ? "D" : p === -1 ? "R" : p === 0 ? "N" : "-");
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  const out: string[] = [];
  const isLastDayOfMonth = new Set<string>();
  for (let i = 0; i < bars.length; i++) if (i === bars.length - 1 || bars[i + 1].date.slice(0, 7) !== bars[i].date.slice(0, 7)) isLastDayOfMonth.add(bars[i].date);

  out.push(`SPY daily ${bars[0].date} to ${bars[bars.length - 1].date}; 5-minute bars ${m5.length ? `${m5[0].date} to ${m5[m5.length - 1].date}` : "none"}.`, "");
  out.push("## 1. How often the methods disagree (reading differs: Drive / Neutral / Reverse), every trading day, period to date", "");
  out.push("| Timeframe | Days | Candle sign (A) vs signed daily sum by sign (B0) | A vs C0 | B0 vs C0 | A vs B (B with the noise band) | B is Neutral | Month-end days only: A vs B0 | Month-end: A vs C0 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const disagree: Record<string, unknown> = {};
  for (const tf of TFS) {
    const r = rows.filter((x) => x.tf === tf);
    const me = r.filter((x) => isLastDayOfMonth.has(x.date));
    const diff = (xs: Row[], a: Method, b: Method) => xs.filter((x) => x.polarity[a] !== x.polarity[b]).length;
    const neu = (m: Method) => r.filter((x) => x.polarity[m] === 0).length;
    out.push(`| ${NAMES[tf]} | ${r.length} | ${pct(diff(r, "A", "B0"), r.length)} | ${pct(diff(r, "A", "C0"), r.length)} | ${pct(diff(r, "B0", "C0"), r.length)} | ${pct(diff(r, "A", "B"), r.length)} | ${pct(neu("B"), r.length)} | ${pct(diff(me, "A", "B0"), me.length)} (${me.length}) | ${pct(diff(me, "A", "C0"), me.length)} |`);
    disagree[tf] = { days: r.length, aB0: diff(r, "A", "B0") / r.length, aC0: diff(r, "A", "C0") / r.length, b0c0: diff(r, "B0", "C0") / r.length, aB: diff(r, "A", "B") / r.length, bNeutral: neu("B") / r.length, monthEnds: me.length, aB0MonthEnd: diff(me, "A", "B0") / me.length };
  }

  out.push("", "## 2. Flips of the period-to-date reading (a flip = the reading changes from one trading day to the next; Neutral counts as a state)", "");
  const flipsOf = (tf: TF, m: Method, from: string, to: string) => {
    const r = rows.filter((x) => x.tf === tf && x.date >= from && x.date <= to && x.polarity[m] !== null);
    let n = 0;
    for (let i = 1; i < r.length; i++) if (r[i].polarity[m] !== r[i - 1].polarity[m]) n++;
    return { n, days: r.length };
  };
  out.push("| Timeframe | Method | Flips 1993-2026 | Per year | Flips 1 Sep - 20 Nov 2026 | 1 Sep - 20 Nov: days in Reverse |", "| --- | --- | --- | --- | --- | --- |");
  const FLIP_METHODS = ["A", "B0", "C0"] as const;
  const flipJson: Record<string, unknown> = {};
  const years = (new Date(bars[bars.length - 1].date).getTime() - new Date(bars[0].date).getTime()) / (365.25 * 86_400_000);
  for (const tf of TFS) for (const m of FLIP_METHODS) {
    const all = flipsOf(tf, m, "0000-01-01", "9999-12-31");
    const fall = flipsOf(tf, m, "2026-09-01", "2026-11-20");
    const revDays = rows.filter((x) => x.tf === tf && x.date >= "2026-09-01" && x.polarity[m] === -1).length;
    out.push(`| ${NAMES[tf]} | ${m} | ${all.n} | ${(all.n / years).toFixed(1)} | ${fall.n} | ${revDays} of ${fall.days} |`);
    flipJson[`${tf}|${m}`] = { all: all.n, perYear: all.n / years, fall: fall.n };
  }

  out.push("", "## 3. Where the methods disagree: the period candle is red/green but the signed volume says otherwise (examples, month to date, most recent first)", "");
  const ex = rows.filter((x) => x.tf === "M" && x.polarity.A !== x.polarity.B0 && isLastDayOfMonth.has(x.date)).slice(-12).reverse();
  out.push("| Month end | Candle (open to close) | A (candle sign) | B0 (signed daily sum) | Up-day volume | Down-day volume |", "| --- | --- | --- | --- | --- | --- |");
  for (const x of ex) out.push(`| ${x.date} | ${x.open.toFixed(2)} to ${x.close.toFixed(2)} (${x.candleKind}) | ${g(x.polarity.A)} | ${g(x.polarity.B0)} | ${(x.up / 1e6).toFixed(0)}M | ${(x.down / 1e6).toFixed(0)}M |`);

  out.push("", "## 4. Right now (as of the last bar), each timeframe, to date", "");
  const lastDate = bars[bars.length - 1].date;
  out.push(`As of ${lastDate} close. Net volume in millions of shares; floor = sum of the period's daily floors.`, "", "| Timeframe | Period start | Candle open to close | A candle sign: net (reading) | B0 signed daily sum: net (reading) | C0 daily, prior-close colour: net (reading) | D0 signed 5-minute sum: net (reading) | Up-day volume | Down-day volume | Floor |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const nowJson: Record<string, unknown> = {};
  for (const tf of TFS) {
    const x = rows.filter((r) => r.tf === tf).at(-1);
    if (!x || x.date !== lastDate) continue;
    const f = (m: Method) => (x.net[m] === null ? "n/a" : `${((x.net[m] as number) / 1e6).toFixed(0)} (${g(x.polarity[m])})`);
    out.push(`| ${NAMES[tf]} | ${keyFor(lastDate, tf)} | ${x.open.toFixed(2)} to ${x.close.toFixed(2)} | ${f("A")} | ${f("B0")} | ${f("C0")} | ${f("D0")} | ${(x.up / 1e6).toFixed(0)} | ${(x.down / 1e6).toFixed(0)} | ${(x.floor / 1e6).toFixed(0)} |`);
    nowJson[tf] = { start: keyFor(lastDate, tf), open: x.open, close: x.close, net: x.net, polarity: x.polarity, up: x.up, down: x.down, floor: x.floor };
  }

  out.push("", "## 5. Five-minute check (periods that began inside the 5-minute window only: October-to-date, November-to-date, Q4-to-date)", "");
  let same = 0;
  let total = 0;
  const per: Record<string, { n: number; dVsA: number; dVsB: number; dVsC: number }> = {};
  for (const x of rows.filter((r) => r.polarity.D0 !== null && keyFor(r.date, r.tf) >= m5First && r.date >= m5First)) {
    const k = `${x.tf}`;
    const e = (per[k] ??= { n: 0, dVsA: 0, dVsB: 0, dVsC: 0 });
    e.n++;
    if (x.polarity.D0 !== x.polarity.A) e.dVsA++;
    if (x.polarity.D0 !== x.polarity.B0) e.dVsB++;
    if (x.polarity.D0 !== x.polarity.C0) e.dVsC++;
    total++;
    if (x.polarity.D0 === x.polarity.B0) same++;
  }
  void same; void total;
  out.push("| Timeframe | Days compared | 5-minute sign (D0) differs from A | from B0 | from C0 |", "| --- | --- | --- | --- | --- |");
  for (const [k, e] of Object.entries(per)) out.push(`| ${NAMES[k as TF]} | ${e.n} | ${pct(e.dVsA, e.n)} | ${pct(e.dVsB, e.n)} | ${pct(e.dVsC, e.n)} |`);
  const daysWithBoth = [...m5ByDate.keys()].filter((d) => bars.some((b) => b.date === d));
  let ratioSum = 0;
  for (const d of daysWithBoth) ratioSum += (m5ByDate.get(d)!.total) / (bars.find((b) => b.date === d)!.volume);
  out.push("", `5-minute volume sums to ${(ratioSum / Math.max(1, daysWithBoth.length) * 100).toFixed(0)}% of the daily volume on average (Yahoo's 5-minute feed is regular-hours consolidated trades; the daily volume field includes the full day), so D is a cross-check, not an exact copy.`);

  out.push("", "## 6. Forward SPY return after each reading, taken at month ends (next open to the open 21 x N trading days later; price only; overlapping windows, so differences are indicative, not tests)", "");
  const idxByDate = new Map(bars.map((b, i) => [b.date, i] as const));
  out.push("| Timeframe | Method | After Drive: 1m / 3m / 6m / 12m average (cases) | After Reverse: 1m / 3m / 6m / 12m average (cases) |", "| --- | --- | --- | --- |");
  const fwd: Record<string, unknown> = {};
  for (const tf of TFS) for (const m of ["A", "B0", "C0"] as const) {
    const cell = (want: Polarity) =>
      [1, 3, 6, 12]
        .map((h) => {
          const vals: number[] = [];
          for (const x of rows) {
            if (x.tf !== tf || !isLastDayOfMonth.has(x.date) || x.polarity[m] !== want) continue;
            const i = idxByDate.get(x.date) as number;
            const j = i + 1 + 21 * h;
            if (j >= bars.length) continue;
            vals.push(bars[j].open / bars[i + 1].open - 1);
          }
          const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
          fwd[`${tf}|${m}|${want}|${h}`] = { mean, n: vals.length };
          return `${(mean * 100).toFixed(1)}% (${vals.length})`;
        })
        .join(" / ");
    out.push(`| ${NAMES[tf]} | ${m} | ${cell(1)} | ${cell(-1)} |`);
  }

  /* ---- 7. Modelled cost of a delta >= 0.80, >= 365-day option if re-bought on every flip vs held until the next flip ---- */
  const vixRaw = await yahoo("^VIX", "period1=-631152000&period2=1900000000&interval=1d", "daily");
  const irxRaw = await yahoo("^IRX", "period1=-631152000&period2=1900000000&interval=1d", "daily");
  const series = (raw: Raw): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < raw.ts.length; i++) {
      const c = raw.q.close[i];
      if (c != null && Number.isFinite(c)) m.set(utcDate(raw.ts[i]), c);
    }
    return m;
  };
  const vix = series(vixRaw);
  const irx = series(irxRaw);
  const carry = (m: Map<string, number>, fallback: number) => {
    const out = new Map<string, number>();
    let last = fallback;
    for (const b of bars) {
      const v = m.get(b.date);
      if (v !== undefined) last = v;
      out.set(b.date, last);
    }
    return out;
  };
  const vixC = carry(vix, 20);
  const irxC = carry(irx, 4);
  const Q_YIELD = 0.016;
  const sigmaAtm = (date: string) => 0.5 * ((vixC.get(date) as number) / 100) + 0.5 * 0.19;
  const sigmaAt = (date: string, spot: number, k: number) => Math.max(0.08, sigmaAtm(date) + 0.4 * Math.max(0, (spot - k) / spot) - 0.3 * Math.max(0, (k - spot) / spot));
  const modelOf = (date: string) => ({ rate: Math.max(0, (irxC.get(date) as number) / 100), dividendYield: Q_YIELD });
  const T0 = 365 / 365;
  const ROLL_AT_DAYS = 305; // the repo rolls a held option within 60 days of expiry
  const HALF_SPREADS = [0.0025, 0.01];

  function strikeFor(type: "call" | "put", date: string, spot: number): number {
    const m = modelOf(date);
    let lo = type === "call" ? 0.2 * spot : spot;
    let hi = type === "call" ? spot : 3 * spot;
    for (let i = 0; i < 80; i++) {
      const k = (lo + hi) / 2;
      const d = Math.abs(bsDelta(type, spot, k, T0, sigmaAt(date, spot, k), m));
      if (type === "call") (d > 0.8 ? (lo = k) : (hi = k));
      else (d > 0.8 ? (hi = k) : (lo = k));
    }
    return type === "call" ? Math.floor(lo) : Math.ceil(hi);
  }
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  const spotOn = new Map(bars.map((b) => [b.date, b.close] as const));
  const todaySpot = bars[bars.length - 1].close;
  const refPremium = (type: "call" | "put") => {
    const k = strikeFor(type, lastDate, todaySpot);
    return bsPrice(type, todaySpot, k, T0, sigmaAt(lastDate, todaySpot, k), modelOf(lastDate)) * 100;
  };
  const REF = { call: refPremium("call"), put: refPremium("put") };

  type Leg = { type: "call" | "put"; start: string; end: string; days: number; decayPct: number; entryMid: number; exitMid: number; expiryRoll: boolean };
  function legsFor(tf: TF, m: Method): Leg[] {
    const r = rows.filter((x) => x.tf === tf && (x.polarity[m] === 1 || x.polarity[m] === -1));
    const legs: Leg[] = [];
    let i = 0;
    while (i < r.length) {
      let j = i;
      while (j + 1 < r.length && r[j + 1].polarity[m] === r[i].polarity[m]) j++;
      const type: "call" | "put" = r[i].polarity[m] === 1 ? "call" : "put";
      let a = r[i].date;
      const spellEnd = j + 1 < r.length ? r[j + 1].date : r[j].date;
      if (i > 0 || true) {
        while (a < spellEnd) {
          const spot0 = spotOn.get(a) as number;
          const k = strikeFor(type, a, spot0);
          const m0 = modelOf(a);
          const sig0 = sigmaAt(a, spot0, k);
          const mid0 = bsPrice(type, spot0, k, T0, sig0, m0);
          let b = spellEnd;
          let expiryRoll = false;
          if (daysBetween(a, b) > ROLL_AT_DAYS) {
            const target = new Date(Date.parse(`${a}T00:00:00Z`) + ROLL_AT_DAYS * 86_400_000).toISOString().slice(0, 10);
            const next = r.find((x) => x.date >= target && x.date < spellEnd);
            if (next) { b = next.date; expiryRoll = true; }
          }
          const days = daysBetween(a, b);
          if (days > 0) {
            const spot1 = spotOn.get(b) as number;
            const mid1 = bsPrice(type, spot1, k, Math.max(T0 - days / 365, 1 / 365), sigmaAt(b, spot1, k), modelOf(b));
            const timeOnly = bsPrice(type, spot0, k, Math.max(T0 - days / 365, 1 / 365), sig0, m0);
            legs.push({ type, start: a, end: b, days, decayPct: (mid0 - timeOnly) / mid0, entryMid: mid0, exitMid: mid1, expiryRoll });
          }
          if (b === a) break;
          a = b;
        }
      }
      i = j + 1;
    }
    return legs;
  }

  out.push("", "## 7. Modelled cost of holding a delta >= 0.80, 365-day option on the reading (Black-Scholes MODEL, not quotes)", "");
  out.push(
    `Assumptions: bought at the close of the day the reading flips, sold at the close of the day it flips back; strike set so |delta| = 0.80 on a 365-day option; volatility = half VIX, half 19% (a 1-year blend), +4 vol points per 10% in the money for calls, -3 per 10% for puts (skew); T-bill rate from ^IRX; dividend yield 1.6%; a held option is replaced by a fresh 365-day one when 60 days remain (the repo's roll rule); half-spread of 0.25% (tight) or 1.0% (wide) of the option price paid on each buy and each sell. 'Decay' = value lost to the passage of time alone with price, volatility and rates held fixed (for a deep in-the-money call this is mostly the interest on the strike). Dollar figures scale each percentage to ONE contract at today's modelled price: call ${REF.call.toFixed(0)} dollars, put ${REF.put.toFixed(0)} dollars (modelled, SPY ${todaySpot.toFixed(2)}); the real quotes come from the chain job.`,
    "",
    "Variant 1 = ROLL ON EVERY FLIP: always hold one option; at every flip sell it and buy a fresh one on the other side (calls on Drive, puts on Reverse). Variant 2 = HOLD UNTIL THE NEXT FLIP: buy a call on a flip to Drive (or a put on a flip to Reverse), sell at the next flip and sit in cash until the same side returns.",
    "",
  );
  out.push("| Timeframe | Method | Legs | Flips per year | Average days held | Variant | Decay per leg (% of option price) | Transaction cost per leg, tight / wide (% of option price) | Decay per year (dollars, 1 contract) | Transaction per year, tight / wide (dollars) | Total per year, tight / wide (dollars) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const costJson: Record<string, unknown> = {};
  const yearsSpan = years;
  for (const tf of TFS) for (const m of ["A", "B0"] as const) {
    const legs = legsFor(tf, m);
    const variants: Array<{ name: string; legs: Leg[] }> = [
      { name: "1: roll on every flip", legs },
      { name: "2a: calls only, hold to next flip", legs: legs.filter((l) => l.type === "call") },
      { name: "2b: puts only, hold to next flip", legs: legs.filter((l) => l.type === "put") },
    ];
    for (const v of variants) {
      if (v.legs.length === 0) continue;
      const avgDays = v.legs.reduce((a, l) => a + l.days, 0) / v.legs.length;
      const decayPct = v.legs.reduce((a, l) => a + l.decayPct, 0) / v.legs.length;
      const trPct = HALF_SPREADS.map((h) => v.legs.reduce((a, l) => a + (h * (l.entryMid + l.exitMid)) / l.entryMid, 0) / v.legs.length);
      const dollars = (f: (l: Leg) => number) => v.legs.reduce((a, l) => a + f(l) * REF[l.type], 0) / yearsSpan;
      const decayY = dollars((l) => l.decayPct);
      const trY = HALF_SPREADS.map((h) => dollars((l) => (h * (l.entryMid + l.exitMid)) / l.entryMid));
      const flipsPerYear = legs.length / yearsSpan;
      out.push(`| ${NAMES[tf]} | ${m === "A" ? "A candle sign" : "B0 signed daily sum"} | ${v.legs.length} | ${flipsPerYear.toFixed(1)} | ${avgDays.toFixed(0)} | ${v.name} | ${(decayPct * 100).toFixed(2)}% | ${(trPct[0] * 100).toFixed(2)}% / ${(trPct[1] * 100).toFixed(2)}% | $${decayY.toFixed(0)} | $${trY[0].toFixed(0)} / $${trY[1].toFixed(0)} | $${(decayY + trY[0]).toFixed(0)} / $${(decayY + trY[1]).toFixed(0)} |`);
      costJson[`${tf}|${m}|${v.name}`] = { legs: v.legs.length, avgDays, decayPct, trPct, decayY, trY };
    }
  }
  out.push("", "Sept - Nov 2026 only (legs that started on or after 1 Sep 2026, same assumptions, tight spread):", "", "| Timeframe | Method | Legs | Decay (dollars, 1 contract each leg) | Transaction (dollars) |", "| --- | --- | --- | --- | --- |");
  for (const tf of TFS) for (const m of ["A", "B0"] as const) {
    const legs = legsFor(tf, m).filter((l) => l.start >= "2026-09-01");
    const decay = legs.reduce((a, l) => a + l.decayPct * REF[l.type], 0);
    const tr = legs.reduce((a, l) => a + (HALF_SPREADS[0] * (l.entryMid + l.exitMid)) / l.entryMid * REF[l.type], 0);
    out.push(`| ${NAMES[tf]} | ${m} | ${legs.length} | $${decay.toFixed(0)} | $${tr.toFixed(0)} |`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "spy-netvolume-methods.md"), out.join("\n"));
  fs.writeFileSync(path.join(OUT_DIR, "spy-netvolume-methods.json"), JSON.stringify({ disagree, flips: flipJson, now: nowJson, per, fwd, cost: costJson }, null, 1));
  console.log(out.join("\n"));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
