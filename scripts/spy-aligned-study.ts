/**
 * READ-ONLY study of the ALIGNED definition with the ONE net volume definition (the chart's): a period-to-date reading
 * counts only when the candle colour and the net volume agree (green candle + positive net volume = Drive, red + negative
 * = Reverse, otherwise Neutral).
 *
 *   npx tsx scripts/spy-aligned-study.ts [--out-dir=/tmp/spy-study]
 *
 * Keyless (Yahoo public chart endpoint: SPY daily bars back to 1993). No secrets, no orders, no 5-minute data.
 *
 * Candle colour = the period-to-date candle: latest close vs the period's first open (month, quarter, 6-month, year).
 * Net volume = the chart definition (TradingView Net Volume on the period's own timeframe): the total daily volume of the
 * period to date, signed +/- by the latest close vs the PREVIOUS PERIOD'S LAST CLOSE. Exactly equal closes give a zero net
 * volume, which is Neutral and counted separately. Verified on SPY monthly 20 Nov 2026: chart -957,839,594 vs -957,406,100
 * from Yahoo daily volume (0.05% apart). The first period of the history has no previous close and is skipped.
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

type Row = { date: string; tf: TF; kind: Kind; open: number; prevClose: number; close: number; total: number; net: number; reading: P };

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

  const rows: Row[] = [];
  for (const tf of TFS) {
    let i0 = 0;
    let total = 0;
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      if (keyFor(b.date, tf) !== keyFor(bars[i - 1].date, tf)) { i0 = i; total = 0; }
      total += b.volume;
      if (i0 === 0) continue; // the first period has no previous close
      const open = bars[i0].open;
      const prevClose = bars[i0 - 1].close;
      const kind: Kind = b.close > open ? "green" : b.close < open ? "red" : "flat";
      const net = b.close > prevClose ? total : b.close < prevClose ? -total : 0;
      rows.push({ date: b.date, tf, kind, open, prevClose, close: b.close, total, net, reading: aligned(kind, net) });
    }
  }

  const last = bars[bars.length - 1].date;
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  const g = (p: P) => (p === 1 ? "Drive" : p === -1 ? "Reverse" : "Neutral");
  const out: string[] = [];
  out.push(
    "# SPY aligned definition study (chart net volume: period-to-date daily volume signed by close vs previous period's last close)",
    "",
    `SPY daily 1993 to ${last}. Every trading day is one observation of each timeframe's period-to-date reading. Aligned rule: green candle + positive net volume = Drive, red candle + negative net volume = Reverse, anything else Neutral (including an exactly zero net volume, counted separately). Net volume = total period-to-date daily volume signed by the latest close vs the previous period's last close.`,
    "",
  );

  const ranges: Array<{ name: string; from: string }> = [
    { name: "This month (1 Nov - 20 Nov 2026)", from: "2026-11-01" },
    { name: "Sept - Nov 2026 (1 Sep - 20 Nov)", from: "2026-09-01" },
    { name: "1993 - 2026", from: "0000-00-00" },
  ];

  out.push("## 1. How often candle colour and net volume DISAGREE (so the reading is Neutral)", "", "Disagree = green candle with negative or zero net volume, red candle with positive or zero net volume, or a flat candle.", "");
  const disJson: Record<string, unknown> = {};
  out.push("| Window | Timeframe | Days | Disagree | Green candle, net not positive | Red candle, net not negative | Flat candle | Zero net volume |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of ranges) for (const tf of TFS) {
    const xs = rows.filter((x) => x.tf === tf && x.date >= r.from);
    if (xs.length === 0) {
      out.push(`| ${r.name} | ${NAMES[tf]} | n/a | | | | | |`);
      continue;
    }
    const dis = xs.filter((x) => x.reading === 0);
    const gr = dis.filter((x) => x.kind === "green").length;
    const rd = dis.filter((x) => x.kind === "red").length;
    const fl = dis.filter((x) => x.kind === "flat").length;
    const zero = xs.filter((x) => x.net === 0).length;
    out.push(`| ${r.name} | ${NAMES[tf]} | ${xs.length} | ${dis.length} (${pct(dis.length, xs.length)}) | ${gr} | ${rd} | ${fl} | ${zero} |`);
    disJson[`${r.name}|${tf}`] = { days: xs.length, disagree: dis.length, green: gr, red: rd, flat: fl, zero };
  }
  out.push("");

  out.push("## 2. Flips and Neutral spells of the ALIGNED reading", "", "Flip = the reading changes from one trading day to the next (Neutral is a state, so Drive to Neutral and Neutral to Reverse are each a flip). Neutral spell = a run of consecutive trading days in Neutral. On Neutral the engine does nothing automatic (the trader decides). 'Side changes skipping Neutral' = changes between Drive and Reverse when Neutral days are skipped over. Flips are counted within one continuous run of days; the period-to-date reading resets at each period start, so day-to-day changes at a period boundary are included.", "");
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

  out.push("## 3. Right now (as of the last bar)", "", `As of ${last} close; the raw net volume is in shares so it can be compared with the chart.`, "", "| Timeframe | Period start | Candle (open to close) | Colour | Previous period close | Net volume (raw) | Flag | Reading |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  const nowJson: Record<string, unknown> = {};
  for (const tf of TFS) {
    const x = rows.filter((r) => r.tf === tf).at(-1);
    if (!x || x.date !== last) {
      out.push(`| ${NAMES[tf]} | ${keyFor(last, tf)} | n/a | n/a | n/a | n/a | | Data unavailable |`);
      continue;
    }
    const raw = `${x.net > 0 ? "+" : ""}${Math.round(x.net).toLocaleString("en-US")}`;
    out.push(`| ${NAMES[tf]} | ${keyFor(last, tf)} | ${x.open.toFixed(2)} to ${x.close.toFixed(2)} | ${x.kind} | ${x.prevClose.toFixed(2)} | ${raw} | ${x.net === 0 ? "ZERO NET VOLUME" : ""} | ${g(x.reading)} |`);
    nowJson[tf] = { start: keyFor(last, tf), kind: x.kind, open: x.open, prevClose: x.prevClose, close: x.close, total: x.total, net: x.net, reading: x.reading };
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
