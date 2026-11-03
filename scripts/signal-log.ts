/**
 * Daily forward-test logger for the capitulation fade. Research tool: never touches the app.
 *
 *   npm run signal-log                run after 16:20 ET, before the next 09:30 ET open
 *   npm run signal-log -- --dry-run   show what would be logged/settled; writes nothing
 *
 * See forward-test/PROTOCOL.md for the frozen rule and the integrity guards:
 *   - partial sessions are ignored (finished only after 16:20 ET)
 *   - a signal is logged only if live (the next session has not started)
 *   - idempotent: re-running never duplicates a session, signal or result
 *   - stale/failed tickers are skipped and counted, never filled in
 */
import fs from "node:fs";
import path from "node:path";
import { fetchHistory } from "./alpacaHistory";
import type { Bar } from "../src/lib/polarity";
import {
  RATIO, REFERENCE, UNIVERSE,
  completedBars, etParts, evaluateAt, isLive, parseCsv, settleOne, summarize, toCsvLine,
} from "./forwardTestCore";

const DIR = path.resolve(__dirname, "..", "forward-test");
const F = {
  universe: path.join(DIR, "universe.json"),
  signals: path.join(DIR, "signals.csv"),
  results: path.join(DIR, "results.csv"),
  sessions: path.join(DIR, "sessions.csv"),
  summary: path.join(DIR, "summary.md"),
};
const H = {
  signals: "logged_at,signal_date,ticker,volume,avg_volume,vol_ratio,close",
  results: "signal_date,ticker,entry_date,entry_open,exit_close,ret,universe_oc_mean,excess,still_fires,volume_final",
  sessions: "session_date,logged_at,tickers_ok,tickers_failed,signals",
};
const MIN_COVERAGE = 0.8;
const dry = process.argv.includes("--dry-run");

const read = (f: string) => (fs.existsSync(f) ? parseCsv(fs.readFileSync(f, "utf8")) : []);
const append = (f: string, header: string, lines: string[]) => {
  if (dry || lines.length === 0) return;
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, header + "\n");
  fs.appendFileSync(f, lines.join("\n") + "\n");
};
const dayMinus = (iso: string, days: number) => new Date(new Date(iso).getTime() - days * 86_400_000).toISOString().slice(0, 10);
const bpsFmt = (x: number) => (Number.isFinite(x) ? `${(x * 1e4).toFixed(1)} bps` : "n/a");
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");

function checkUniverse() {
  const want = JSON.stringify({ ratio: RATIO, tickers: [...UNIVERSE] });
  if (fs.existsSync(F.universe)) {
    const have = JSON.stringify(JSON.parse(fs.readFileSync(F.universe, "utf8")));
    if (have !== want) {
      throw new Error("Universe/rule in the code differs from forward-test/universe.json. The protocol is frozen: start a NEW log directory instead of editing this one.");
    }
  } else if (!dry) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(F.universe, JSON.stringify({ ratio: RATIO, tickers: [...UNIVERSE] }, null, 2) + "\n");
  }
}

async function main() {
  const now = new Date();
  checkUniverse();

  const signalsOld = read(F.signals);
  const resultsOld = read(F.results);
  const sessionsOld = read(F.sessions);
  const done = new Set(resultsOld.map((r) => `${r.signal_date}|${r.ticker}`));
  const pending = signalsOld.filter((s) => !done.has(`${s.signal_date}|${s.ticker}`));

  // History window: enough for the 20-day average, and back to the oldest pending signal.
  const today = etParts(now).date;
  const oldestPending = pending.map((p) => p.signal_date).sort()[0];
  const start = [dayMinus(today, 75), oldestPending ? dayMinus(oldestPending, 5) : "9999"].sort()[0];
  const end = new Date(now.getTime() - 16 * 60_000).toISOString(); // SIP: nothing newer than 15 min

  const all = new Map<string, Bar[]>();
  const failed: string[] = [];
  for (const t of [REFERENCE, ...UNIVERSE]) {
    try {
      all.set(t, await fetchHistory(t, start, end, "sip"));
    } catch (e) {
      if (t === REFERENCE) throw new Error(`Calendar reference ${REFERENCE} failed: ${e instanceof Error ? e.message : e}`);
      failed.push(t);
      console.warn(`  ${t} FAILED: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  if (failed.length > UNIVERSE.length * (1 - MIN_COVERAGE)) {
    throw new Error(`${failed.length}/${UNIVERSE.length} tickers failed; refusing to log a partial universe.`);
  }
  const done_ = (t: string) => completedBars(all.get(t)!, now);

  // Mean open->close return across the universe, by finished session.
  const ocSum = new Map<string, { s: number; n: number }>();
  for (const t of UNIVERSE) {
    if (!all.has(t)) continue;
    for (const b of done_(t)) {
      const c = ocSum.get(b.date) ?? { s: 0, n: 0 };
      c.s += b.close / b.open - 1;
      c.n += 1;
      ocSum.set(b.date, c);
    }
  }
  const universeOc = (d: string) => {
    const c = ocSum.get(d);
    return c && c.n >= UNIVERSE.length * MIN_COVERAGE ? c.s / c.n : null;
  };

  /* 1. settle earlier signals */
  const newResults: string[] = [];
  let stillOpen = 0;
  for (const s of pending) {
    const bars = all.get(s.ticker);
    const r = bars ? settleOne({ signal_date: s.signal_date, ticker: s.ticker }, done_(s.ticker), universeOc) : null;
    if (!r) { stillOpen++; continue; }
    newResults.push(toCsvLine([s.signal_date, s.ticker, r.entry_date, r.entry_open, r.exit_close, r.ret, r.universe_oc_mean, r.excess, r.still_fires, r.volume_final]));
    console.log(`  settled ${s.ticker} ${s.signal_date}: ${bpsFmt(r.ret)} (excess ${bpsFmt(r.excess)})${r.still_fires ? "" : "  [no longer fires on final data]"}`);
  }
  append(F.results, H.results, newResults);
  if (pending.length) console.log(`Pending signals: ${pending.length} (${newResults.length} settled now, ${stillOpen} awaiting their session).`);

  /* 2. log today's live signals */
  const refDone = done_(REFERENCE);
  const candidates = [...new Set(UNIVERSE.flatMap((t) => (all.has(t) ? done_(t).map((b) => b.date) : [])))].sort();
  let sessionDate: string | null = null;
  for (const d of [...candidates].reverse()) {
    const have = UNIVERSE.filter((t) => all.has(t) && done_(t).some((b) => b.date === d)).length;
    if (have >= UNIVERSE.length * MIN_COVERAGE && refDone.some((b) => b.date === d)) { sessionDate = d; break; }
  }
  if (!sessionDate) throw new Error("No finished session with enough coverage found.");

  let logged = 0;
  let loggedSession = false; // true only when this run recorded a new live session
  const newSignals: string[] = [];
  if (sessionsOld.some((s) => s.session_date === sessionDate)) {
    console.log(`Session ${sessionDate} already logged; nothing new to record.`);
  } else if (!isLive(sessionDate, all.get(REFERENCE)!)) {
    console.log(
      `Session ${sessionDate} is NOT live: a later session has already started, so logging it would be hindsight. ` +
        `Run after 16:20 ET and before the next 09:30 ET open. Nothing logged.`,
    );
    if (dry) {
      const hyp = UNIVERSE.filter((t) => all.has(t) && evaluateAt(done_(t), sessionDate!)?.fires);
      console.log(`  (dry run, for information only) ${sessionDate} would have fired: ${hyp.join(", ") || "none"}`);
    }
  } else {
    const ok = UNIVERSE.filter((t) => all.has(t) && done_(t).some((b) => b.date === sessionDate));
    for (const t of ok) {
      const ev = evaluateAt(done_(t), sessionDate);
      if (ev?.fires) {
        newSignals.push(toCsvLine([now.toISOString(), sessionDate, t, ev.volume, ev.avgVolume?.toFixed(0) ?? "", ev.volRatio?.toFixed(3) ?? "", ev.close]));
        console.log(`  SIGNAL ${t}: red close ${ev.close} on ${ev.volRatio?.toFixed(2)}x average volume -> buy next open, sell that close`);
      }
    }
    logged = newSignals.length;
    loggedSession = true;
    append(F.signals, H.signals, newSignals);
    append(F.sessions, H.sessions, [toCsvLine([sessionDate, now.toISOString(), ok.length, UNIVERSE.length - ok.length, logged])]);
    console.log(`Logged session ${sessionDate}: ${ok.length}/${UNIVERSE.length} tickers evaluated, ${logged} signal(s).`);
  }

  /* 3. summary */
  const results = [...resultsOld, ...parseCsv(newResults.length ? `${H.results}\n${newResults.join("\n")}` : "")];
  const sessions = [...sessionsOld.map((s) => s.session_date), ...(loggedSession ? [sessionDate] : [])];
  const first = [...sessions].sort()[0];
  const missed = first ? refDone.map((b) => b.date).filter((d) => d >= first && !sessions.includes(d)) : [];
  const stats = summarize(results.map((r) => ({ entry_date: r.entry_date, ret: Number(r.ret), excess: Number(r.excess), still_fires: r.still_fires === "true" })));
  const totalSignals = signalsOld.length + newSignals.length;

  const md: string[] = [];
  md.push(`# Forward test: capitulation fade`);
  md.push(`Updated ${now.toISOString()} | rule: Reverse day at ${RATIO}x floor -> buy next open, sell that close | frozen protocol: forward-test/PROTOCOL.md`);
  md.push(`\n- Sessions logged: ${sessions.length}${first ? ` (since ${first})` : ""}; **missed** sessions: ${missed.length}${missed.length ? ` (${missed.join(", ")})` : ""}`);
  md.push(`- Signals logged: ${totalSignals}; settled: ${stats.n}; awaiting next session: ${totalSignals - stats.n}`);
  if (stats.n === 0) {
    md.push(`\nNo settled signals yet.`);
  } else {
    md.push(`\n| Measure | Value |\n| --- | --- |`);
    md.push(`| Settled signals (distinct days) | ${stats.n} (${stats.days}) |`);
    md.push(`| Mean open->close return | ${bpsFmt(stats.meanRet)} |`);
    md.push(`| Mean excess vs universe same day | ${bpsFmt(stats.meanExcess)} (SE ${bpsFmt(stats.seExcess)}, t ${stats.tExcess.toFixed(2)}) |`);
    md.push(`| Win rate | ${pct(stats.winRate)} |`);
    md.push(`| Still fires on final data | ${pct(stats.stillFiresShare)} |`);
    for (const c of stats.net) md.push(`| Net @ ${c.bps} bps/side: return / excess | ${bpsFmt(c.ret)} / ${bpsFmt(c.excess)} |`);
    md.push(`\nThe standard error is large until several hundred signals have settled; do not read the mean as proof either way (see PROTOCOL.md).`);
  }
  if (!dry) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(F.summary, md.join("\n") + "\n");
  }
  console.log("\n" + md.join("\n"));
  if (dry) console.log("\n(dry run: nothing written)");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
