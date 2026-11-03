import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectObservations,
  eventStudy,
  equalWeightPortfolio,
  forwardReturn,
  makeRng,
  perfMetrics,
  runStrategy,
  fwdKey,
  type Observation,
} from "../src/lib/backtester";
import { computePolaritySeries, type Bar } from "../src/lib/polarity";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function dateAt(i: number): string {
  return new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
}

function bar(i: number, o: number, h: number, l: number, c: number, v: number): Bar {
  return { date: dateAt(i), open: o, high: h, low: l, close: c, volume: v };
}

/**
 * 20 neutral warm-up dojis, ONE Drive day (idx 20), then quiet bars.
 *   idx 20: green 100 -> 102, vol 1000  => Net Volume +1000 > floor (100): Drive
 *   idx 21: open 101, close 103
 *   idx 22: open 103, close 104
 *   idx 23..29: flat at 104 (volume 50 stays inside the noise floor: Neutral)
 */
function scenario(): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < 20; i++) bars.push(bar(i, 100, 101, 99, 100, 1000));
  bars.push(bar(20, 100, 103, 99, 102, 1000));
  bars.push(bar(21, 101, 104, 100, 103, 50));
  bars.push(bar(22, 103, 105, 102, 104, 50));
  for (let i = 23; i < 30; i++) bars.push(bar(i, 104, 104, 104, 104, 50));
  return bars;
}

function randomBars(count: number, seed: number): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  let px = 100;
  for (let i = 0; i < count; i++) {
    const o = px * (1 + (rng() - 0.5) * 0.01);
    const c = o * (1 + (rng() - 0.5) * 0.04);
    const h = Math.max(o, c) * (1 + rng() * 0.01);
    const l = Math.min(o, c) * (1 - rng() * 0.01);
    bars.push(bar(i, o, h, l, c, 1000 + rng() * 4000));
    px = c;
  }
  return bars;
}

test("scenario produces exactly one Drive signal", () => {
  const series = computePolaritySeries(scenario());
  assert.equal(series.filter((r) => r.polarity === 1).length, 1);
  assert.equal(series.filter((r) => r.polarity === -1).length, 0);
  assert.equal(series[20].polarity, 1);
});

test("forward returns: nextOpen enters the NEXT open, close enters the signal close", () => {
  const bars = scenario();
  close(forwardReturn(bars, 20, 1, "nextOpen")!, 103 / 101 - 1);
  close(forwardReturn(bars, 20, 1, "close")!, 103 / 102 - 1);
  close(forwardReturn(bars, 20, 5, "nextOpen")!, 104 / 101 - 1);
  assert.equal(forwardReturn(bars, 28, 5, "nextOpen"), null);
});

test("event study counts only signals with a full forward window", () => {
  const obs = collectObservations("TEST", scenario());
  const stats = eventStudy(obs);
  const drive1 = stats.find((s) => s.polarity === 1 && s.horizon === 1 && s.entry === "nextOpen")!;
  assert.equal(drive1.n, 1);
  close(drive1.meanDirectional, 103 / 101 - 1);
  const drive20 = stats.find((s) => s.polarity === 1 && s.horizon === 20 && s.entry === "nextOpen")!;
  assert.equal(drive20.n, 0); // only 9 bars remain after the signal
});

test("Reverse is scored short: a falling price is a win", () => {
  const k = fwdKey("nextOpen", 5);
  const obs: Observation[] = [
    { ticker: "X", date: "2024-02-01", index: 25, polarity: -1, fwd: { [k]: -0.02 } },
    { ticker: "X", date: "2024-02-02", index: 26, polarity: 0, fwd: { [k]: 0.0 } },
  ];
  const s = eventStudy(obs).find((x) => x.polarity === -1 && x.horizon === 5 && x.entry === "nextOpen");
  assert.ok(s);
  close(s!.meanDirectional, 0.02);
  assert.equal(s!.hitRate, 1);
});

test("strategy hold=1, zero cost: one trade, return = next open -> next close", () => {
  const r = runStrategy(scenario(), { name: "t", holdDays: 1, allowShort: true, costBps: 0 });
  assert.equal(r.trades.length, 1);
  close(r.trades[0].returnPct, 103 / 101 - 1);
  assert.equal(r.trades[0].entryDate, dateAt(21));
  assert.equal(r.trades[0].sessionsHeld, 1);
  close(r.perf.totalReturn, 103 / 101 - 1);
});

test("strategy hold=5 earns open[21] -> close[25] with overnight legs included", () => {
  const r = runStrategy(scenario(), { name: "t", holdDays: 5, allowShort: false, costBps: 0 });
  assert.equal(r.trades.length, 1);
  close(r.trades[0].returnPct, 104 / 101 - 1);
  close(r.perf.totalReturn, 104 / 101 - 1);
});

test("costs are charged on both sides of the trade", () => {
  const r = runStrategy(scenario(), { name: "t", holdDays: 1, allowShort: false, costBps: 10 });
  close(r.trades[0].returnPct, 103 / 101 - 1 - 0.002);
  close(r.perf.totalReturn, (103 / 101) * (1 - 0.001) * (1 - 0.001) - 1, 1e-12);
});

test("NO LOOK-AHEAD: truncating the future never changes the past", () => {
  const full = randomBars(160, 7);
  const cut = 100;
  const head = full.slice(0, cut);

  assert.deepEqual(computePolaritySeries(full).slice(0, cut), computePolaritySeries(head));

  for (const holdDays of [null, 5]) {
    const cfg = { name: "t", holdDays, allowShort: true, costBps: 5 };
    const a = runStrategy(full, cfg).returns.slice(0, cut - 20);
    const b = runStrategy(head, cfg).returns;
    assert.deepEqual(a, b);
  }
});

test("long-only never goes short; long/short reaches both sides", () => {
  const bars = randomBars(400, 3);
  const lo = runStrategy(bars, { name: "lo", holdDays: 5, allowShort: false, costBps: 0 });
  const ls = runStrategy(bars, { name: "ls", holdDays: 5, allowShort: true, costBps: 0 });
  assert.ok(lo.trades.every((t) => t.direction === 1));
  assert.ok(ls.trades.some((t) => t.direction === -1));
});

test("permutation p-value is reproducible for a fixed seed and lies in (0, 1]", () => {
  const bars = randomBars(500, 11);
  const obs = collectObservations("R", bars);
  const a = eventStudy(obs, { permutations: 200, seed: 5 });
  const b = eventStudy(obs, { permutations: 200, seed: 5 });
  assert.deepEqual(a, b);
  for (const s of a.filter((x) => x.pValue !== null)) {
    assert.ok(s.pValue! > 0 && s.pValue! <= 1);
  }
});

test("perfMetrics: drawdown and total return on a known path", () => {
  const m = perfMetrics([0.1, -0.5, 0.2]);
  close(m.totalReturn, 1.1 * 0.5 * 1.2 - 1);
  close(m.maxDrawdown, -0.5);
});

test("equal-weight portfolio averages by date", () => {
  const p = equalWeightPortfolio([
    { dates: ["2024-01-01", "2024-01-02"], returns: [0.02, 0.04] },
    { dates: ["2024-01-02"], returns: [0.0] },
  ]);
  assert.deepEqual(p.dates, ["2024-01-01", "2024-01-02"]);
  close(p.returns[0], 0.02);
  close(p.returns[1], 0.02);
});
