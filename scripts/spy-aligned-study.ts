/**
 * READ-ONLY study of the ALIGNED definition with the ONE net volume method: a period-to-date reading counts only when
 * the candle colour and the net volume agree (green candle + positive net volume = Drive, red + negative = Reverse,
 * otherwise Neutral).
 *
 *   npx tsx scripts/spy-aligned-study.ts [--out-dir=/tmp/spy-study]
 *
 * Keyless (Yahoo public chart endpoint: SPY daily bars and SPY 5-minute bars for the last ~60 sessions). No secrets, no orders.
 *
 * Candle colour = the period-to-date candle: latest close vs the period's first open (month, quarter, 6-month, year).
 * Net volume = the sum over every 5-minute bar of the period of +volume (bar closed above its open) or -volume (below).
 * Only periods that began inside the free 5-minute window can be built: the month since 1 Sep 2026 and the quarter
 * since 1 Oct 2026. The 6-month and yearly periods began before it, and the 1993-2026 history has no 5-minute data, so
 * none of those can be studied with this method (and no daily approximation is used instead).
 * The aligned rule is written out here (not imported) so this script stands alone on any branch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bar } from "../src/lib/polarity";

const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const OUT_DIR = arg("out-dir", "/tmp/spy-study");
const CACHE = path.join(os.tmpdir(), "polarito-spy-bars");
const TFS = ["M", "Q", "H", "Y"] as const;
type TF = (typeof TFS)[number];
const NAMES: Record<TF, string> = { M: "Monthly", Q: "Quarterly", H: "6-month", Y: "Yearly" };
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

type Row = { date: string; tf: TF; kind: Kind; open: number; close: number; net: number; reading: P };

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
    let d5 = 0;
    let d5ok = true;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (i === 0 || keyFor(b.date, tf) !== keyFor(bars[i - 1].date, tf)) { i0 = i; d5 = 0; d5ok = true; }
      const e = m5ByDate.get(b.date);
      if (e !== undefined) d5 += e; else d5ok = false;
      if (!(d5ok && keyFor(b.date, tf) >= m5First)) continue; // the whole period must be covered by 5-minute bars
      const open = bars[i0].open;
      const kind: Kind = b.close > open ? "green" : b.close < open ? "red" : "flat";
      rows.push({ date: b.date, tf, kind, open, close: b.close, net: d5, reading: aligned(kind, d5) });
    }
  }

  const last = bars[bars.length - 1].date;
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  const g = (p: P) => (p === 1 ? "Drive" : p === -1 ? "Reverse" : "Neutral");
  const out: string[] = [];
  out.push(
    "# SPY aligned definition study (signed 5-minute net volume only)",
    "",
    `SPY daily to ${last}; 5-minute bars ${m5First} to ${last}. Every trading day is one observation of each timeframe's period-to-date reading. Aligned rule: green candle + positive net volume = Drive, red candle + negative net volume = Reverse, anything else Neutral. Net volume = 5-minute up-bar volume minus down-bar volume, summed over the whole period.`,
    "",
    "Coverage: free 5-minute history is about 60 sessions, so only periods that began inside it can be built: the month since 1 Sep and the quarter since 1 Oct. The 6-month and yearly periods began earlier, and 1993-2026 has no 5-minute data, so they cannot be studied with this method. No daily approximation is substituted.",
    "",
  );

  const ranges: Array<{ name: string; from: string }> = [
    { name: "This month (1 Nov - 20 Nov 2026)", from: "2026-11-01" },
    { name: "Sept - Nov 2026 (1 Sep - 20 Nov)", from: "2026-09-01" },
  ];

  out.push("## 1. How often candle colour and net volume DISAGREE (so the reading is Neutral)", "", "Disagree = green candle with negative or zero net volume, red candle with positive or zero net volume, or a flat candle.", "");
  const disJson: Record<string, unknown> = {};
  out.push("| Window | Timeframe | Days | Disagree | Green candle, net not positive | Red candle, net not negative | Flat candle |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of ranges) for (const tf of TFS) {
    const xs = rows.filter((x) => x.tf === tf && x.date >= r.from);
    if (xs.length === 0) {
      out.push(`| ${r.name} | ${NAMES[tf]} | n/a: period began before the 5-minute window | | | | |`);
      continue;
    }
    const dis = xs.filter((x) => x.reading === 0);
    const gr = dis.filter((x) => x.kind === "green").length;
    const rd = dis.filter((x) => x.kind === "red").length;
    const fl = dis.filter((x) => x.kind === "flat").length;
    out.push(`| ${r.name} | ${NAMES[tf]} | ${xs.length} | ${dis.length} (${pct(dis.length, xs.length)}) | ${gr} | ${rd} | ${fl} |`);
    disJson[`${r.name}|${tf}`] = { days: xs.length, disagree: dis.length, green: gr, red: rd, flat: fl };
  }
  out.push("");

  out.push("## 2. Flips and Neutral spells of the ALIGNED reading", "", "Flip = the reading changes from one trading day to the next (Neutral is a state, so Drive to Neutral and Neutral to Reverse are each a flip). Neutral spell = a run of consecutive trading days in Neutral. On Neutral the engine does nothing automatic (the trader decides). 'Side changes skipping Neutral' = changes between Drive and Reverse when Neutral days are skipped over. Windows are short, so no per-year figures are given.", "");
  const flipJson: Record<string, unknown> = {};
  out.push("| Window | Timeframe | Days | Neutral days | Flips | Flips direct Drive<->Reverse | Neutral spells | Average Neutral spell (days) | Side changes skipping Neutral |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of ranges) for (const tf of TFS) {
    const xs = rows.filter((x) => x.tf === tf && x.date >= r.from);
    if (xs.length < 2) continue;
    const seq = xs.map((x) => x.reading);
    let flips = 0;
    let direct = 0;
    let spells = 0;
    let neutralDays = 0;
    for (let i = 0; i < seq.length; i++) {
      if (seq[i] === 0) { neutralDays++; if (i === 0 || seq[i - 1] !== 0) spells++; }
      if (i > 0 && seq[i] !== seq[i - 1]) { flips++; if (seq[i] !== 0 && seq[i - 1] !== 0) direct++; }
    }
    const nz = seq.filter((p) => p !== 0);
    let sides = 0;
    for (let i = 1; i < nz.length; i++) if (nz[i] !== nz[i - 1]) sides++;
    out.push(`| ${r.name} | ${NAMES[tf]} | ${seq.length} | ${neutralDays} (${pct(neutralDays, seq.length)}) | ${flips} | ${direct} | ${spells} | ${spells ? (neutralDays / spells).toFixed(1) : "n/a"} | ${sides} |`);
    flipJson[`${r.name}|${tf}`] = { days: seq.length, neutralDays, flips, direct, spells, sides };
  }
  out.push("");

  out.push("## 3. Right now (as of the last bar)", "", `As of ${last} close; net volume in millions of shares.`, "", "| Timeframe | Period start | Candle (open to close) | Colour | Net volume | Reading |", "| --- | --- | --- | --- | --- | --- |");
  const nowJson: Record<string, unknown> = {};
  for (const tf of TFS) {
    const x = rows.filter((r) => r.tf === tf).at(-1);
    if (!x || x.date !== last) {
      out.push(`| ${NAMES[tf]} | ${keyFor(last, tf)} | n/a | n/a | n/a | Data unavailable (period began before the 5-minute window) |`);
      continue;
    }
    out.push(`| ${NAMES[tf]} | ${keyFor(last, tf)} | ${x.open.toFixed(2)} to ${x.close.toFixed(2)} | ${x.kind} | ${(x.net / 1e6).toFixed(0)}M | ${g(x.reading)} |`);
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
