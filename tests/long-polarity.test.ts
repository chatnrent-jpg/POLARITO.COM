import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LONG_TIMEFRAMES,
  DEFAULT_DECISION_TIMEFRAME,
  alignedPolarity,
  chartNetVolume,
  coerceLongTimeframe,
  computeLongReadings,
  longPeriodEnd,
  longPeriodStart,
  readingsSummary,
} from "../src/lib/longPolarity";
import * as lib from "../src/lib/longPolarity";
import { tradingDaysBetween } from "../src/lib/marketCalendar";
import type { Bar, CandleKind } from "../src/lib/polarity";

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random-walk daily bars on real trading days. */
function walk(from: string, to: string, seed = 7): Bar[] {
  const r = rng(seed);
  let price = 400;
  const daily: Bar[] = [];
  for (const date of tradingDaysBetween(from, to)) {
    const open = price;
    const close = open * (1 + (r() - 0.5) * 0.03);
    const volume = 50_000_000 + Math.floor(r() * 100_000_000);
    price = close;
    daily.push({ date, open, close, high: Math.max(open, close) * (1 + r() * 0.005), low: Math.min(open, close) * (1 - r() * 0.005), volume });
  }
  return daily;
}

const closeOf = (date: string) => new Date(`${date}T21:30:00Z`); // after the close, New York

type Day = { open: number; close: number; volume: number };

/** Calm history to 2026-09-30 (every close is exactly 100, the previous period's last close), then October 1 and 2 as given. */
function october(a: Day, b: Day): Bar[] {
  const daily: Bar[] = tradingDaysBetween("2026-08-03", "2026-09-30").map((date) => ({ date, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
  const mk = (date: string, d: Day): Bar => ({ date, open: d.open, close: d.close, volume: d.volume, high: Math.max(d.open, d.close) + 0.1, low: Math.min(d.open, d.close) - 0.1 });
  daily.push(mk("2026-10-01", a), mk("2026-10-02", b));
  return daily;
}

const NOW = new Date("2026-10-02T21:30:00Z");
const read = (daily: Bar[], now = NOW) => computeLongReadings({ daily, now }).M;

describe("only month, quarter, 6-month and year exist, and there is one net volume definition", () => {
  it("no daily or weekly timeframe", () => {
    assert.deepEqual([...LONG_TIMEFRAMES], ["M", "Q", "H", "Y"]);
    assert.equal(coerceLongTimeframe("1D"), DEFAULT_DECISION_TIMEFRAME);
    assert.equal(coerceLongTimeframe("1W"), DEFAULT_DECISION_TIMEFRAME);
    assert.equal(coerceLongTimeframe("Q"), "Q");
    assert.equal(DEFAULT_DECISION_TIMEFRAME, "M");
  });
  it("no method selector, 5-minute type or other net volume variants are exported", () => {
    for (const name of ["NET_VOLUME_METHODS", "DEFAULT_NET_VOLUME_METHOD", "isNetVolumeMethod", "IntradayBar"]) assert.equal(name in lib, false, name);
  });
  it("6-month boundaries", () => {
    assert.equal(longPeriodStart("2026-06-30", "H"), "2026-01-01");
    assert.equal(longPeriodEnd("2026-06-30", "H"), "2026-06-30");
    assert.equal(longPeriodStart("2026-07-01", "H"), "2026-07-01");
    assert.equal(longPeriodEnd("2026-11-20", "H"), "2026-12-31");
  });
});

describe("chart net volume: total period volume signed by close vs the previous period's last close", () => {
  it("positive, negative, zero and missing", () => {
    assert.deepEqual(chartNetVolume(100, 101, 500), { net: 500, flag: null });
    assert.deepEqual(chartNetVolume(100, 99, 500), { net: -500, flag: null });
    assert.deepEqual(chartNetVolume(100, 100, 500), { net: 0, flag: "zero" });
    assert.deepEqual(chartNetVolume(100, 101, Number.NaN), { net: null, flag: "missing" });
    assert.deepEqual(chartNetVolume(Number.NaN, 101, 500), { net: null, flag: "missing" });
    assert.deepEqual(chartNetVolume(100, Number.POSITIVE_INFINITY, 500), { net: null, flag: "missing" });
  });
  it("reproduces the chart's SPY November 2026 value in sign and size (total volume 957,406,100, close below the previous close)", () => {
    assert.deepEqual(chartNetVolume(755.72, 689.81, 957_406_100), { net: -957_406_100, flag: null });
  });
});

describe("alignment rule: candle colour and chart net volume must match", () => {
  it("alignedPolarity covers all combinations", () => {
    assert.equal(alignedPolarity("green", 1), 1);
    assert.equal(alignedPolarity("red", -1), -1);
    assert.equal(alignedPolarity("green", -1), 0);
    assert.equal(alignedPolarity("red", 1), 0);
    assert.equal(alignedPolarity("green", 0), 0);
    assert.equal(alignedPolarity("red", 0), 0);
    assert.equal(alignedPolarity("flat", 5), 0);
    assert.equal(alignedPolarity("flat", -5), 0);
  });
  it("green candle and positive net volume = +1 Drive", () => {
    const r = read(october({ open: 100, close: 101, volume: 80 }, { open: 101, close: 103, volume: 70 }));
    assert.equal(r.status, "ok", r.reason ?? "");
    assert.equal(r.kind, "green");
    assert.equal(r.previousClose, 100);
    assert.equal(r.totalVolume, 150);
    assert.equal(r.netVolume, 150);
    assert.equal(r.netFlag, null);
    assert.equal(r.polarity, 1);
    assert.equal(r.label, "Drive");
    assert.equal(r.agreement, "agree");
  });
  it("red candle and negative net volume = -1 Reverse", () => {
    const r = read(october({ open: 100, close: 95, volume: 100 }, { open: 95, close: 94, volume: 100 }));
    assert.equal(r.kind, "red");
    assert.equal(r.netVolume, -200);
    assert.equal(r.polarity, -1);
    assert.equal(r.label, "Reverse");
    assert.equal(r.agreement, "agree");
  });
  it("green candle but close below the previous close (negative net volume) = 0 Neutral, a valid reading", () => {
    const r = read(october({ open: 98, close: 98.5, volume: 80 }, { open: 98.5, close: 99.5, volume: 70 }));
    assert.equal(r.status, "ok");
    assert.equal(r.kind, "green");
    assert.equal(r.netVolume, -150);
    assert.equal(r.netSign, -1);
    assert.equal(r.netFlag, null);
    assert.equal(r.polarity, 0);
    assert.equal(r.label, "Neutral");
    assert.equal(r.agreement, "disagree");
  });
  it("red candle but close above the previous close (positive net volume) = 0 Neutral", () => {
    const r = read(october({ open: 103, close: 102, volume: 40 }, { open: 102, close: 101, volume: 60 }));
    assert.equal(r.kind, "red");
    assert.equal(r.netVolume, 100);
    assert.equal(r.polarity, 0);
    assert.equal(r.agreement, "disagree");
  });
  it("exact zero net volume (close equals the previous close) is Neutral with an explicit flag, whatever the colour", () => {
    const r = read(october({ open: 98, close: 99, volume: 50 }, { open: 99, close: 100, volume: 50 }));
    assert.equal(r.status, "ok");
    assert.equal(r.kind, "green");
    assert.equal(r.netVolume, 0);
    assert.equal(r.totalVolume, 100);
    assert.equal(r.netFlag, "zero");
    assert.equal(r.netSign, 0);
    assert.equal(r.polarity, 0);
    assert.equal(r.label, "Neutral");
    assert.match(r.reason ?? "", /exactly zero/);
    const red = read(october({ open: 103, close: 101, volume: 50 }, { open: 101, close: 100, volume: 50 }));
    assert.equal(red.kind, "red");
    assert.equal(red.netFlag, "zero");
    assert.equal(red.polarity, 0);
  });
  it("a flat candle (close equals the period's open) is Neutral even with positive net volume", () => {
    const r = read(october({ open: 100, close: 105, volume: 40 }, { open: 105, close: 100, volume: 60 }));
    assert.equal(r.kind, "flat");
    assert.equal(r.polarity, 0);
  });
  it("the candle, previous close, close, raw net volume, match, reading and as-of time are all on the reading", () => {
    const r = read(october({ open: 98, close: 98.5, volume: 80 }, { open: 98.5, close: 99.5, volume: 70 }));
    assert.equal(r.open, 98);
    assert.equal(r.previousClose, 100);
    assert.equal(r.close, 99.5);
    assert.equal(r.periodStart, "2026-10-01");
    assert.equal(r.throughDate, "2026-10-02");
    assert.equal(r.asOf, NOW.toISOString());
    assert.equal(r.sessions, 2);
    assert.equal(r.netVolume, -150);
  });
});

describe("missing, stale or incomplete data is Data unavailable, never a guess", () => {
  const s = october({ open: 100, close: 101, volume: 80 }, { open: 101, close: 103, volume: 70 });
  const unavailable = (r: ReturnType<typeof read>, re: RegExp) => {
    assert.equal(r.status, "unavailable");
    assert.equal(r.polarity, null);
    assert.equal(r.label, "Data unavailable");
    assert.equal(r.agreement, null);
    assert.equal(r.netVolume, null);
    assert.equal(r.netFlag, null);
    assert.match(r.reason ?? "", re);
  };
  it("sanity: the clean scenario reads", () => {
    assert.equal(read(s).status, "ok");
  });
  it("a newest daily bar that is not the current session's makes every reading unavailable", () => {
    const next = computeLongReadings({ daily: s, now: new Date("2026-10-05T15:00:00Z") }); // Monday, needs Monday's bar
    for (const tf of LONG_TIMEFRAMES) {
      assert.equal(next[tf].status, "unavailable");
      assert.equal(next[tf].polarity, null);
      assert.match(next[tf].reason ?? "", /stale data/);
    }
    assert.equal(readingsSummary(next), "M:- Q:- H:- Y:-");
  });
  it("a weekend uses Friday's bars and is fine", () => {
    assert.equal(read(s, new Date("2026-10-03T18:00:00Z")).status, "ok");
  });
  it("a missing daily session inside the period", () => {
    unavailable(read(s.filter((b) => b.date !== "2026-10-01")), /no daily bar for 2026-10-01/);
  });
  it("zero or missing daily volume", () => {
    unavailable(read(s.map((b) => (b.date === "2026-10-02" ? { ...b, volume: 0 } : b))), /volume missing or zero on 2026-10-02/);
    unavailable(read(s.map((b) => (b.date === "2026-10-02" ? { ...b, volume: Number.NaN } : b))), /rejected/);
  });
  it("malformed daily bars", () => {
    assert.equal(computeLongReadings({ daily: s.map((b) => (b.date === "2026-10-02" ? { ...b, high: 80 } : b)), now: NOW }).Y.status, "unavailable");
  });
  it("the previous period's last close must be loaded: missing bar or history that starts too late", () => {
    unavailable(read(s.filter((b) => b.date !== "2026-09-30")), /no daily bar for the previous period's last session \(2026-09-30\)/);
    unavailable(read(s.filter((b) => b.date >= "2026-10-01")), /does not reach the previous period's last session/);
  });
  it("a period whose previous close lies before the loaded history is unavailable (6-month and year here)", () => {
    const r = computeLongReadings({ daily: s, now: NOW });
    assert.equal(r.M.status, "ok");
    assert.equal(r.Q.status, "ok");
    assert.equal(r.H.status, "unavailable");
    assert.equal(r.Y.status, "unavailable");
    assert.match(r.H.reason ?? "", /does not reach the previous period's last session \(2026-06-30\)/);
  });
  it("no daily bars is unavailable, never a throw", () => {
    assert.equal(computeLongReadings({ daily: [], now: NOW }).M.status, "unavailable");
  });
});

describe("audit inputs and live behaviour on a long history", () => {
  const daily = walk("2025-12-01", "2026-11-20", 11);
  const now = new Date("2026-11-20T21:30:00Z");
  const sum = (from: string) => daily.filter((b) => b.date >= from).reduce((n, b) => n + b.volume, 0);
  it("all four periods read, with candle, previous close, raw net volume and as-of time", () => {
    const r = computeLongReadings({ daily, now });
    assert.deepEqual(Object.keys(r), ["M", "Q", "H", "Y"]);
    assert.equal(r.M.periodStart, "2026-11-01");
    assert.equal(r.Q.periodStart, "2026-10-01");
    assert.equal(r.H.periodStart, "2026-07-01");
    assert.equal(r.Y.periodStart, "2026-01-01");
    const prevCloses = { M: "2026-10-30", Q: "2026-09-30", H: "2026-06-30", Y: "2025-12-31" } as const;
    for (const tf of LONG_TIMEFRAMES) {
      const x = r[tf];
      assert.equal(x.status, "ok", x.reason ?? "");
      assert.equal(x.asOf, now.toISOString());
      assert.equal(x.throughDate, "2026-11-20");
      assert.equal(x.previousClose, daily.find((b) => b.date === prevCloses[tf])?.close);
      assert.equal(x.polarity, alignedPolarity(x.kind as CandleKind, x.netVolume as number));
      assert.equal(x.netSign, Math.sign(x.netVolume as number));
      assert.equal(Math.abs(x.netVolume as number), x.totalVolume);
    }
  });
  it("net volume is the whole-period sum of daily volume, signed by close vs the previous period's last close", () => {
    const r = computeLongReadings({ daily, now });
    const lastClose = daily[daily.length - 1].close;
    const expected = { M: sum("2026-11-01"), Q: sum("2026-10-01"), H: sum("2026-07-01"), Y: sum("2026-01-01") };
    for (const tf of LONG_TIMEFRAMES) {
      const x = r[tf];
      assert.equal(x.totalVolume, expected[tf]);
      assert.equal(x.netVolume, (lastClose > (x.previousClose as number) ? 1 : -1) * expected[tf]);
    }
  });
  it("no look-ahead: readings from truncated data never use later bars", () => {
    const cut = daily.findIndex((b) => b.date === "2026-09-30");
    const at = computeLongReadings({ daily: daily.slice(0, cut + 1), now: closeOf("2026-09-30") });
    const polluted = daily.map((b) => (b.date > "2026-09-30" ? { ...b, volume: 1, close: b.open - 5 } : b));
    const same = computeLongReadings({ daily: polluted.slice(0, cut + 1), now: closeOf("2026-09-30") });
    for (const tf of LONG_TIMEFRAMES) assert.deepEqual(at[tf], same[tf]);
  });
  it("the reading follows the data live: the sign of the net volume follows the latest close vs the previous close", () => {
    const base = daily.slice(0, -1);
    const last = daily[daily.length - 1];
    const prev = computeLongReadings({ daily, now }).M.previousClose as number;
    const up = computeLongReadings({ daily: [...base, { ...last, close: prev * 1.05, high: prev * 1.06, low: Math.min(last.low, prev) }], now }).M;
    const down = computeLongReadings({ daily: [...base, { ...last, close: prev * 0.9, low: prev * 0.85, high: Math.max(last.high, prev) }], now }).M;
    assert.ok((up.netVolume as number) > 0);
    assert.ok((down.netVolume as number) < 0);
    assert.equal(up.totalVolume, down.totalVolume);
  });
});
