/**
 * READ-ONLY study of the ALIGNED definition: a period-to-date reading counts only when the candle colour and the net
 * volume agree (green candle + positive net volume = Drive, red + negative = Reverse, otherwise Neutral).
 *
 *   npx tsx scripts/spy-aligned-study.ts [--out-dir=/tmp/spy-study]
 *
 * Keyless (Yahoo public chart endpoint: SPY daily from 1993, SPY 5-minute for the last ~60 days). No secrets, no orders.
 *
 * Candle colour = the period-to-date candle: latest close vs the period's first open (month, quarter, 6-month, year).
 * Net volume methods (one whole-period number each):
 *   B0  signed daily sum with the repo's own daily rule (up-day volume minus down-day volume, day colour = close vs open)
 *   C0  signed daily sum with the day colour = close vs the PREVIOUS close
 *   D0  signed 5-minute sum (up-bar volume minus down-bar volume); only ~60 sessions are free, so only periods that began
 *       inside that window (the month since Sept 1, the quarter since Oct 1) can be built; 6-month and year cannot.
 * 1993-2026 can only use B0 and C0 (daily data). The app's recommended method is D0 (the engine's "signed-intraday").
 * The aligned rule is written out here (not imported) so this script stands alone on any branch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { netVolume, type Bar } from "../src/lib/polarity";

const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const OUT_DIR = arg("out-dir", "/tmp/spy-study");
const CACHE = path.join(os.tmpdir(), "polarito-spy-bars");
const TFS = ["M", "Q", "H", "Y"] as const;
type TF = (typeof TFS)[number];
const NAMES: Record<TF, string> = { M: "Monthly", Q: "Quarterly", H: "6-month", Y: "Yearly" };
const METHODS = ["B0", "C0", "D0"] as const;
type Method = (typeof METHODS)[number];
type Kind = "green" | "red" | "flat";
type P = 1 | 0 | -1;

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
const aligned = (kind: Kind, net: number): P => (kind === "green" && net > 0 ? 1 : kind === "red" && net < 0 ? -1 : 0);

type Row = { date: string; tf: TF; kind: Kind; open: number; close: number; net: Record<Method, number | null>; reading: Record<Method, P | null> };

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
  const m5raw = await yahoo("SPY", "range=60d&interval=5m", "5m");
  const m5ByDate = new Map<string, number>();
  let m5First = "9999-12-31";
  for (let i = 0; i < m5raw.ts.length; i++) {
    const [o, c, v] = [m5raw.q.open[i], m5raw.q.close[i], m5raw.q.volume[i]];
    if (o == null || c == null || v == null) continue;
    const d = etDate(m5raw.ts[i]);
    if (d < m5First) m5First = d;
    m5ByDate.set(d, (m5ByDate.get(d) ?? 0) + (c > o ? v : c < o ? -v : 0));
  }

  const rows: Row[] = [];
  for (const tf of TFS) {
    let i0 = 0;
    let sumB = 0;
    let sumC = 0;
    let d5 = 0;
    let d5ok = true;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (i === 0 || keyFor(b.date, tf) !== keyFor(bars[i - 1].date, tf)) { i0 = i; sumB = 0; sumC = 0; d5 = 0; d5ok = true; }
      sumB += netVolume(b);
      const prevClose = i > 0 ? bars[i - 1].close : b.open;
      sumC += b.close > prevClose ? b.volume : b.close < prevClose ? -b.volume : 0;
      const e = m5ByDate.get(b.date);
      if (e !== undefined) d5 += e; else d5ok = false;
      const open = bars[i0].open;
      const kind: Kind = b.close > open ? "green" : b.close < open ? "red" : "flat";
      const haveD = d5ok && keyFor(b.date, tf) >= m5First;
      if (keyFor(b.date, tf) < bars[0].date.slice(0, 7) + "-01" || (i0 === 0 && keyFor(b.date, tf) < bars[0].date)) continue; // period began before the data
      rows.push({
        date: b.date, tf, kind, open, close: b.close,
        net: { B0: sumB, C0: sumC, D0: haveD ? d5 : null },
        reading: { B0: aligned(kind, sumB), C0: aligned(kind, sumC), D0: haveD ? aligned(kind, d5) : null },
      });
    }
  }

  const last = bars[bars.length - 1].date;
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  const g = (p: P | null) => (p === 1 ? "Drive" : p === -1 ? "Reverse" : p === 0 ? "Neutral" : "n/a");
  const out: string[] = [];
  out.push(`# SPY aligned definition study`, "", `SPY daily ${bars[0].date} to ${last}; 5-minute bars ${m5First} to ${last}. Every trading day is one observation of each timeframe's period-to-date reading. Aligned rule: green candle + positive net volume = Drive, red candle + negative net volume = Reverse, anything else Neutral.`, "");

  const ranges: Array<{ name: string; from: string }> = [
    { name: "This month (1 Nov - 20 Nov 2026)", from: "2026-11-01" },
    { name: "Sept - Nov 2026 (1 Sep - 20 Nov)", from: "2026-09-01" },
    { name: "1993 - 2026 (all days)", from: "0000-01-01" },
  ];

  out.push("## 1. How often candle colour and net volume DISAGREE (so the reading is Neutral)", "", "Disagree = green candle with negative or zero net volume, red candle with positive or zero net volume, or a flat candle. D0 (5-minute) exists only for periods that began inside the free 5-minute window; blank = not buildable.", "");
  const disJson: Record<string, unknown> = {};
  for (const r of ranges) {
    out.push(`### ${r.name}`, "", "| Timeframe | Net volume method | Days | Disagree | Of which: green candle, net not positive | Of which: red candle, net not negative | Of which: flat candle |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const tf of TFS) for (const m of METHODS) {
      const xs = rows.filter((x) => x.tf === tf && x.date >= r.from && x.reading[m] !== null);
      if (xs.length === 0) continue;
      const dis = xs.filter((x) => x.reading[m] === 0);
      const gr = dis.filter((x) => x.kind === "green").length;
      const rd = dis.filter((x) => x.kind === "red").length;
      const fl = dis.filter((x) => x.kind === "flat").length;
      out.push(`| ${NAMES[tf]} | ${m} | ${xs.length} | ${dis.length} (${pct(dis.length, xs.length)}) | ${gr} | ${rd} | ${fl} |`);
      disJson[`${r.name}|${tf}|${m}`] = { days: xs.length, disagree: dis.length, green: gr, red: rd, flat: fl };
    }
    out.push("");
  }

  out.push("## 2. Flips and Neutral spells of the ALIGNED reading", "", "Flip = the reading changes from one trading day to the next (Neutral is a state, so Drive to Neutral and Neutral to Reverse are each a flip). Neutral spell = a run of consecutive trading days in Neutral. On Neutral the engine does nothing automatic (the trader decides), so a Neutral spell is a stretch of manual decisions. 'Side changes skipping Neutral' = changes between Drive and Reverse when Neutral days are skipped over (the automatic rolls the engine would make if the trader leaves a position alone through Neutral). 'Non-Neutral runs' = number of runs of consecutive Drive/Reverse days (how often a clear reading starts after a Neutral spell or at the start). Readings straddling a period boundary (e.g. 31 Oct to 1 Nov) count like any other day.", "");
  const flipJson: Record<string, unknown> = {};
  const ranges2 = ranges.slice(1);
  const spanYears = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (365.25 * 86_400_000);
  for (const r of ranges2) {
    out.push(`### ${r.name}`, "", "| Timeframe | Method | Days | Neutral days | Flips | Flips direct Drive<->Reverse | Neutral spells | Average Neutral spell (days) | Side changes skipping Neutral | Non-Neutral runs | Flips per year (extrapolated for short windows) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const tf of TFS) for (const m of METHODS) {
      const xs = rows.filter((x) => x.tf === tf && x.date >= r.from && x.reading[m] !== null);
      if (xs.length < 2) continue;
      const seq = xs.map((x) => x.reading[m] as P);
      let flips = 0;
      let direct = 0;
      let spells = 0;
      let neutralDays = 0;
      let entries = 0;
      for (let i = 0; i < seq.length; i++) {
        if (seq[i] === 0) { neutralDays++; if (i === 0 || seq[i - 1] !== 0) spells++; }
        if (seq[i] !== 0 && (i === 0 || seq[i - 1] === 0)) entries++;
        if (i > 0 && seq[i] !== seq[i - 1]) { flips++; if (seq[i] !== 0 && seq[i - 1] !== 0) direct++; }
      }
      const nz = seq.filter((p) => p !== 0);
      let sides = 0;
      for (let i = 1; i < nz.length; i++) if (nz[i] !== nz[i - 1]) sides++;
      const yrs = spanYears(xs[0].date, xs[xs.length - 1].date) || 1;
      out.push(`| ${NAMES[tf]} | ${m} | ${seq.length} | ${neutralDays} (${pct(neutralDays, seq.length)}) | ${flips} | ${direct} | ${spells} | ${spells ? (neutralDays / spells).toFixed(1) : "n/a"} | ${sides} | ${entries} | ${(flips / yrs).toFixed(1)} |`);
      flipJson[`${r.name}|${tf}|${m}`] = { days: seq.length, neutralDays, flips, direct, spells, sides, entries };
    }
    out.push("");
  }

  out.push("## 3. Right now (as of the last bar)", "", `As of ${last} close; net volume in millions of shares.`, "", "| Timeframe | Period start | Candle (open to close) | Colour | B0 net (reading) | C0 net (reading) | D0 5-minute net (reading) |", "| --- | --- | --- | --- | --- | --- | --- |");
  const nowJson: Record<string, unknown> = {};
  const cell = (x: Row, m: Method) => (x.net[m] === null ? "n/a" : `${((x.net[m] as number) / 1e6).toFixed(0)} (${g(x.reading[m])})`);
  for (const tf of TFS) {
    const x = rows.filter((r) => r.tf === tf).at(-1);
    if (!x || x.date !== last) continue;
    out.push(`| ${NAMES[tf]} | ${keyFor(last, tf)} | ${x.open.toFixed(2)} to ${x.close.toFixed(2)} | ${x.kind} | ${cell(x, "B0")} | ${cell(x, "C0")} | ${cell(x, "D0")} |`);
    nowJson[tf] = { start: keyFor(last, tf), kind: x.kind, open: x.open, close: x.close, net: x.net, reading: x.reading };
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "spy-aligned-study.md"), out.join("\n"));
  fs.writeFileSync(path.join(OUT_DIR, "spy-aligned-study.json"), JSON.stringify({ disagree: disJson, flips: flipJson, now: nowJson }, null, 1));
  console.log(out.join("\n"));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
