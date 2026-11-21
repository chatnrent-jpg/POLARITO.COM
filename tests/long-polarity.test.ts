import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LONG_TIMEFRAMES,
  DEFAULT_DECISION_TIMEFRAME,
  alignedPolarity,
  coerceLongTimeframe,
  computeLongReadings,
  longPeriodEnd,
  longPeriodStart,
  readingsSummary,
  type IntradayBar,
} from "../src/lib/longPolarity";
import * as lib from "../src/lib/longPolarity";
import { isTradingDay, tradingDaysBetween } from "../src/lib/marketCalendar";
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

/** Two 5-minute bars for a session: one rising bar carrying `up` volume, one falling bar carrying `down` volume. */
function sessionBars(date: string, up: number, down: number): IntradayBar[] {
  const out: IntradayBar[] = [];
  if (up > 0) out.push({ t: `${date}T15:00:00Z`, date, open: 100, close: 101, volume: up });
  if (down > 0) out.push({ t: `${date}T17:30:00Z`, date, open: 101, close: 100, volume: down });
  return out;
}

/** Random-walk daily bars on real trading days, with matching 5-minute bars (random up/down split of each day's volume). */
function walk(from: string, to: string, seed = 7): { daily: Bar[]; intraday: IntradayBar[] } {
  const r = rng(seed);
  let price = 400;
  const daily: Bar[] = [];
  const intraday: IntradayBar[] = [];
  for (const date of tradingDaysBetween(from, to)) {
    const open = price;
    const close = open * (1 + (r() - 0.5) * 0.03);
    const volume = 50_000_000 + Math.floor(r() * 100_000_000);
    price = close;
    daily.push({ date, open, close, high: Math.max(open, close) * (1 + r() * 0.005), low: Math.min(open, close) * (1 - r() * 0.005), volume });
    const share = r();
    intraday.push(...sessionBars(date, Math.round(volume * share), volume - Math.round(volume * share)));
  }
  return { daily, intraday };
}

const closeOf = (date: string) => new Date(`${date}T21:30:00Z`); // after the close, New York

type Day = { open: number; close: number; up: number; down: number };

/** Calm history to 2026-09-30, then October 1 and 2 as given, with 5-minute bars for October only. */
function october(a: Day, b: Day): { daily: Bar[]; intraday: IntradayBar[] } {
  const daily: Bar[] = tradingDaysBetween("2026-08-03", "2026-09-30").map((date, i) => ({ date, open: 100, high: 101, low: 99, close: i % 2 === 0 ? 100.5 : 99.5, volume: 100 }));
  const mk = (date: string, d: Day): Bar => ({ date, open: d.open, close: d.close, volume: d.up + d.down, high: Math.max(d.open, d.close) + 0.1, low: Math.min(d.open, d.close) - 0.1 });
  daily.push(mk("2026-10-01", a), mk("2026-10-02", b));
  return { daily, intraday: [...sessionBars("2026-10-01", a.up, a.down), ...sessionBars("2026-10-02", b.up, b.down)] };
}

const NOW = new Date("2026-10-02T21:30:00Z");
const read = (s: { daily: Bar[]; intraday: IntradayBar[] }, now = NOW) => computeLongReadings({ daily: s.daily, intraday: s.intraday, now }).M;

describe("only month, quarter, 6-month and year exist, and there is one net volume method", () => {
  it("no daily or weekly timeframe", () => {
    assert.deepEqual([...LONG_TIMEFRAMES], ["M", "Q", "H", "Y"]);
    assert.equal(coerceLongTimeframe("1D"), DEFAULT_DECISION_TIMEFRAME);
    assert.equal(coerceLongTimeframe("1W"), DEFAULT_DECISION_TIMEFRAME);
    assert.equal(coerceLongTimeframe("Q"), "Q");
    assert.equal(DEFAULT_DECISION_TIMEFRAME, "M");
  });
  it("no method selector or daily/candle net volume variants are exported", () => {
    for (const name of ["NET_VOLUME_METHODS", "DEFAULT_NET_VOLUME_METHOD", "isNetVolumeMethod"]) assert.equal(name in lib, false, name);
  });
  it("6-month boundaries", () => {
    assert.equal(longPeriodStart("2026-06-30", "H"), "2026-01-01");
    assert.equal(longPeriodEnd("2026-06-30", "H"), "2026-06-30");
    assert.equal(longPeriodStart("2026-07-01", "H"), "2026-07-01");
    assert.equal(longPeriodEnd("2026-11-20", "H"), "2026-12-31");
  });
});

describe("alignment rule: candle colour and signed 5-minute net volume must match", () => {
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
    const r = read(october({ open: 100, close: 100.5, up: 80, down: 20 }, { open: 100.5, close: 101, up: 70, down: 30 }));
    assert.equal(r.status, "ok", r.reason ?? "");
    assert.equal(r.kind, "green");
    assert.equal(r.netVolume, 100);
    assert.equal(r.upVolume, 150);
    assert.equal(r.downVolume, 50);
    assert.equal(r.polarity, 1);
    assert.equal(r.label, "Drive");
    assert.equal(r.agreement, "agree");
  });
  it("red candle and negative net volume = -1 Reverse", () => {
    const r = read(october({ open: 100, close: 95, up: 10, down: 90 }, { open: 95, close: 94, up: 20, down: 80 }));
    assert.equal(r.kind, "red");
    assert.equal(r.netVolume, -140);
    assert.equal(r.polarity, -1);
    assert.equal(r.label, "Reverse");
    assert.equal(r.agreement, "agree");
  });
  it("green candle but negative net volume = 0 Neutral (a valid reading, not unavailable)", () => {
    const r = read(october({ open: 100, close: 90, up: 20, down: 80 }, { open: 90, close: 101, up: 30, down: 70 }));
    assert.equal(r.status, "ok");
    assert.equal(r.kind, "green");
    assert.equal(r.netVolume, -100);
    assert.equal(r.netSign, -1);
    assert.equal(r.polarity, 0);
    assert.equal(r.label, "Neutral");
    assert.equal(r.agreement, "disagree");
  });
  it("red candle but positive net volume = 0 Neutral", () => {
    const r = read(october({ open: 100, close: 95, up: 40, down: 60 }, { open: 95, close: 98, up: 90, down: 10 }));
    assert.equal(r.kind, "red");
    assert.equal(r.netVolume, 60);
    assert.equal(r.polarity, 0);
    assert.equal(r.agreement, "disagree");
  });
  it("zero net volume is Neutral whatever the colour", () => {
    const r = read(october({ open: 100, close: 90, up: 50, down: 50 }, { open: 90, close: 101, up: 50, down: 50 }));
    assert.equal(r.kind, "green");
    assert.equal(r.netVolume, 0);
    assert.equal(r.netSign, 0);
    assert.equal(r.polarity, 0);
  });
  it("a flat candle (close equals the period's open) is Neutral even with positive net volume", () => {
    const r = read(october({ open: 100, close: 95, up: 40, down: 60 }, { open: 95, close: 100, up: 90, down: 10 }));
    assert.equal(r.kind, "flat");
    assert.equal(r.netVolume, 60);
    assert.equal(r.polarity, 0);
  });
  it("flat 5-minute bars add nothing to net volume", () => {
    const s = october({ open: 100, close: 100.5, up: 80, down: 20 }, { open: 100.5, close: 101, up: 70, down: 30 });
    const flat: IntradayBar = { t: "2026-10-02T16:00:00Z", date: "2026-10-02", open: 100, close: 100, volume: 0 };
    assert.equal(read({ daily: s.daily, intraday: [...s.intraday, flat] }).netVolume, 100);
  });
  it("the candle, net volume, match, reading and as-of time are all on the reading", () => {
    const r = read(october({ open: 100, close: 90, up: 20, down: 80 }, { open: 90, close: 101, up: 30, down: 70 }));
    assert.equal(r.open, 100);
    assert.equal(r.close, 101);
    assert.equal(r.periodStart, "2026-10-01");
    assert.equal(r.throughDate, "2026-10-02");
    assert.equal(r.asOf, NOW.toISOString());
    assert.equal(r.lastBarAt, "2026-10-02T17:30:00Z");
    assert.equal(r.sessions, 2);
  });
});

describe("missing, stale or incomplete data is Data unavailable, never a guess", () => {
  const s = october({ open: 100, close: 100.5, up: 80, down: 20 }, { open: 100.5, close: 101, up: 70, down: 30 });
  const unavailable = (r: ReturnType<typeof read>, re: RegExp) => {
    assert.equal(r.status, "unavailable");
    assert.equal(r.polarity, null);
    assert.equal(r.label, "Data unavailable");
    assert.equal(r.agreement, null);
    assert.equal(r.netVolume, null);
    assert.match(r.reason ?? "", re);
  };
  it("sanity: the clean scenario reads", () => {
    assert.equal(read(s).status, "ok");
  });
  it("no 5-minute bars at all", () => {
    unavailable(computeLongReadings({ daily: s.daily, now: NOW }).M, /no 5-minute bars/);
    unavailable(read({ daily: s.daily, intraday: [] }), /no 5-minute bars/);
  });
  it("a whole session without 5-minute bars", () => {
    unavailable(read({ daily: s.daily, intraday: s.intraday.filter((b) => b.date !== "2026-10-01") }), /no 5-minute bars on 2026-10-01/);
  });
  it("5-minute volume that does not add up to the daily volume", () => {
    const thin = s.intraday.map((b) => (b.date === "2026-10-01" ? { ...b, volume: b.volume / 2 } : b));
    unavailable(read({ daily: s.daily, intraday: thin }), /5-minute volume on 2026-10-01/);
  });
  it("during the session the newest 5-minute bar must be recent", () => {
    unavailable(read(s, new Date("2026-10-02T18:30:00Z")), /minutes old/); // 14:30 ET, newest bar 13:30 ET
    assert.equal(read(s, new Date("2026-10-02T17:40:00Z")).status, "ok");
  });
  it("the in-progress session is not ratio-checked", () => {
    const partial = s.intraday.filter((b) => !(b.date === "2026-10-02" && b.t > "2026-10-02T15:30:00Z"));
    assert.equal(read({ daily: s.daily, intraday: partial }, new Date("2026-10-02T15:15:00Z")).status, "ok");
  });
  it("after the close the newest 5-minute bar must be from the session", () => {
    unavailable(read({ daily: s.daily, intraday: s.intraday.filter((b) => b.date !== "2026-10-02") }), /no 5-minute bars on 2026-10-02/);
  });
  it("a malformed 5-minute bar", () => {
    unavailable(read({ daily: s.daily, intraday: s.intraday.map((b, i) => (i === 1 ? { ...b, volume: Number.NaN } : b)) }), /malformed 5-minute bar/);
    unavailable(read({ daily: s.daily, intraday: s.intraday.map((b, i) => (i === 1 ? { ...b, volume: -5 } : b)) }), /malformed 5-minute bar/);
    unavailable(read({ daily: s.daily, intraday: s.intraday.map((b, i) => (i === 1 ? { ...b, t: "garbage" } : b)) }), /malformed 5-minute bar/);
  });
  it("a newest daily bar that is not the current session's makes every reading unavailable", () => {
    const next = computeLongReadings({ daily: s.daily, intraday: s.intraday, now: new Date("2026-10-05T15:00:00Z") }); // Monday, needs Monday's bar
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
    unavailable(read({ daily: s.daily.filter((b) => b.date !== "2026-10-01"), intraday: s.intraday }), /no daily bar for 2026-10-01/);
  });
  it("zero or missing daily volume", () => {
    unavailable(read({ daily: s.daily.map((b) => (b.date === "2026-10-02" ? { ...b, volume: 0 } : b)), intraday: s.intraday }), /volume missing or zero on 2026-10-02/);
    unavailable(read({ daily: s.daily.map((b) => (b.date === "2026-10-02" ? { ...b, volume: Number.NaN } : b)), intraday: s.intraday }), /rejected/);
  });
  it("malformed daily bars", () => {
    assert.equal(computeLongReadings({ daily: s.daily.map((b) => (b.date === "2026-10-02" ? { ...b, high: 80 } : b)), intraday: s.intraday, now: NOW }).Y.status, "unavailable");
  });
  it("a period that starts before the loaded history is unavailable (6-month and year here)", () => {
    const r = computeLongReadings({ daily: s.daily, intraday: s.intraday, now: NOW });
    assert.equal(r.M.status, "ok");
    assert.equal(r.H.status, "unavailable");
    assert.equal(r.Y.status, "unavailable");
    assert.match(r.H.reason ?? "", /does not reach the start/);
  });
  it("no daily bars is unavailable, never a throw", () => {
    assert.equal(computeLongReadings({ daily: [], now: NOW }).M.status, "unavailable");
  });
});

describe("audit inputs and live behaviour on a long history", () => {
  const { daily, intraday } = walk("2025-12-01", "2026-11-20", 11);
  const now = new Date("2026-11-20T21:30:00Z");
  it("all four periods read, with candle, net volume and as-of time", () => {
    const r = computeLongReadings({ daily, intraday, now });
    assert.deepEqual(Object.keys(r), ["M", "Q", "H", "Y"]);
    assert.equal(r.M.periodStart, "2026-11-01");
    assert.equal(r.Q.periodStart, "2026-10-01");
    assert.equal(r.H.periodStart, "2026-07-01");
    assert.equal(r.Y.periodStart, "2026-01-01");
    for (const tf of LONG_TIMEFRAMES) {
      const x = r[tf];
      assert.equal(x.status, "ok", x.reason ?? "");
      assert.equal(x.asOf, now.toISOString());
      assert.equal(x.throughDate, "2026-11-20");
      assert.equal(x.polarity, alignedPolarity(x.kind as CandleKind, x.netVolume as number));
      assert.equal(x.netSign, Math.sign(x.netVolume as number));
      assert.equal((x.upVolume as number) - (x.downVolume as number), x.netVolume);
    }
  });
  it("net volume is the whole-period sum of the 5-minute bars", () => {
    const r = computeLongReadings({ daily, intraday, now }).Q;
    const expected = intraday.filter((b) => b.date >= "2026-10-01").reduce((n, b) => n + (b.close > b.open ? b.volume : b.close < b.open ? -b.volume : 0), 0);
    assert.equal(r.netVolume, expected);
  });
  it("no look-ahead: readings from truncated data never use later bars", () => {
    const cut = daily.findIndex((b) => b.date === "2026-09-30");
    const at = computeLongReadings({ daily: daily.slice(0, cut + 1), intraday: intraday.filter((b) => b.date <= "2026-09-30"), now: closeOf("2026-09-30") });
    const polluted = intraday.map((b) => (b.date > "2026-09-30" ? { ...b, volume: 1, close: b.open - 5 } : b));
    const same = computeLongReadings({ daily: daily.slice(0, cut + 1), intraday: polluted.filter((b) => b.date <= "2026-09-30"), now: closeOf("2026-09-30") });
    for (const tf of LONG_TIMEFRAMES) assert.deepEqual(at[tf], same[tf]);
    assert.ok(isTradingDay("2026-09-30"));
  });
  it("the reading follows the data live: a last close below the period's open turns the candle red", () => {
    const base = daily.slice(0, -1);
    const last = daily[daily.length - 1];
    const up = computeLongReadings({ daily: [...base, { ...last, close: last.open * 1.05, high: last.open * 1.06 }], intraday, now }).M;
    const down = computeLongReadings({ daily: [...base, { ...last, close: last.open * 0.9, low: last.open * 0.85 }], intraday, now }).M;
    assert.equal(up.netVolume, down.netVolume);
    assert.notEqual(up.kind, "red");
    assert.equal(down.kind, "red");
  });
});
