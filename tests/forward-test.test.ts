import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bar } from "../src/lib/polarity";
import {
  completedBars, evaluateAt, isLive, parseCsv, settleOne, summarize, toCsvLine, UNIVERSE,
} from "../scripts/forwardTestCore";

/** 22 ascending weekday-ish dates; flat green bars on volume 1000, then a custom last bar. */
function makeBars(last: Partial<Bar> = {}): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10); // from 2026-10-01
    bars.push({ date: d, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 });
  }
  const l = bars[bars.length - 1];
  bars[bars.length - 1] = { ...l, open: 100, high: 101, low: 97, close: 98, volume: 2000, ...last }; // red, 2x avg volume
  return bars;
}

test("completedBars drops today's partial bar before 16:20 ET and keeps it after", () => {
  const bars = makeBars();
  const lastDate = bars[bars.length - 1].date; // 2026-10-24
  // 2026-10-24 14:50 UTC = 10:50 EDT: session still open
  const during = completedBars(bars, new Date(`${lastDate}T14:50:00Z`));
  assert.equal(during[during.length - 1].date, bars[bars.length - 2].date);
  // 2026-10-24 21:00 UTC = 17:00 EDT: finished
  const after = completedBars(bars, new Date(`${lastDate}T21:00:00Z`));
  assert.equal(after[after.length - 1].date, lastDate);
  // 16:10 ET is still too early (late prints)
  const early = completedBars(bars, new Date(`${lastDate}T20:10:00Z`));
  assert.equal(early[early.length - 1].date, bars[bars.length - 2].date);
});

test("evaluateAt fires on a red day with volume > 1.5x average, not on 1.4x or a green day", () => {
  const date = makeBars()[23].date;
  assert.equal(evaluateAt(makeBars(), date)?.fires, true);
  assert.equal(evaluateAt(makeBars({ volume: 1400 }), date)?.fires, false);
  assert.equal(evaluateAt(makeBars({ open: 98, close: 100, low: 97, high: 101 }), date)?.fires, false);
  assert.equal(evaluateAt(makeBars(), "1999-01-01"), null);
});

test("evaluateAt uses no data after the evaluated date", () => {
  const bars = makeBars();
  const date = bars[22].date;
  const a = evaluateAt(bars, date);
  const tampered = bars.map((b, i) => (i === 23 ? { ...b, volume: 9_999_999, close: 50, low: 40 } : b));
  const b = evaluateAt(tampered, date);
  assert.deepEqual(a, b);
});

test("evaluateAt is not ready without 20 prior sessions", () => {
  const ev = evaluateAt(makeBars().slice(0, 10), makeBars()[9].date);
  assert.equal(ev?.ready, false);
  assert.equal(ev?.fires, false);
});

test("isLive is true only when no later session bar exists", () => {
  const bars = makeBars();
  assert.equal(isLive(bars[23].date, bars), true);
  assert.equal(isLive(bars[22].date, bars), false);
});

test("settleOne buys the next open and sells that close; null until that session is final", () => {
  const sigDate = makeBars()[23].date;
  const bars = makeBars();
  bars.push({ date: "2026-10-25", open: 98, high: 101, low: 97.5, close: 99.96, volume: 1500 });
  const oc = () => 0.001;
  const r = settleOne({ signal_date: sigDate, ticker: "X" }, bars, oc)!;
  assert.equal(r.entry_date, "2026-10-25");
  assert.ok(Math.abs(r.ret - (99.96 / 98 - 1)) < 1e-12);
  assert.ok(Math.abs(r.excess - (r.ret - 0.001)) < 1e-12);
  assert.equal(r.still_fires, true);
  assert.equal(settleOne({ signal_date: sigDate, ticker: "X" }, makeBars(), oc), null); // no later bar yet
  assert.equal(settleOne({ signal_date: sigDate, ticker: "X" }, bars, () => null), null); // no baseline yet
});

test("settleOne flags a signal that no longer fires once volume is revised down", () => {
  const sigDate = makeBars()[23].date;
  const revised = makeBars({ volume: 1200 }); // final volume lower than the live reading
  revised.push({ date: "2026-10-25", open: 98, high: 99, low: 97, close: 98.5, volume: 1000 });
  const r = settleOne({ signal_date: sigDate, ticker: "X" }, revised, () => 0)!;
  assert.equal(r.still_fires, false);
  assert.equal(r.volume_final, 1200);
});

test("summarize: means, net-of-cost figures and day clustering", () => {
  const s = summarize([
    { entry_date: "d1", ret: 0.01, excess: 0.008, still_fires: true },
    { entry_date: "d1", ret: 0.005, excess: 0.003, still_fires: true },
    { entry_date: "d2", ret: -0.002, excess: -0.004, still_fires: false },
  ]);
  assert.equal(s.n, 3);
  assert.equal(s.days, 2);
  assert.ok(Math.abs(s.meanRet - 0.004333333) < 1e-8);
  assert.ok(Math.abs(s.meanExcess - 0.002333333) < 1e-8);
  assert.ok(Math.abs(s.winRate - 2 / 3) < 1e-12);
  assert.ok(Math.abs(s.stillFiresShare - 2 / 3) < 1e-12);
  const n2 = s.net.find((c) => c.bps === 2)!;
  assert.ok(Math.abs(n2.ret - (s.meanRet - 0.0004)) < 1e-12); // round trip = 2 x 2 bps
  assert.equal(summarize([]).n, 0);
});

test("csv helpers round-trip and the universe is fixed and duplicate-free", () => {
  const text = `a,b\n${toCsvLine(["x", 1])}\n${toCsvLine(["y", true])}\n`;
  assert.deepEqual(parseCsv(text), [{ a: "x", b: "1" }, { a: "y", b: "true" }]);
  assert.equal(new Set(UNIVERSE).size, UNIVERSE.length);
  assert.equal(UNIVERSE.length, 48);
});
