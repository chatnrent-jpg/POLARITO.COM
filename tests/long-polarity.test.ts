import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { periodBucketsFor } from "../src/lib/chartBuckets";
import {
  DEFAULT_DECISION_TIMEFRAME,
  DEFAULT_NET_VOLUME_METHOD,
  LONG_TIMEFRAMES,
  alignedPolarity,
  coerceLongTimeframe,
  computeLongReadings,
  longPeriodEnd,
  longPeriodStart,
  readingsSummary,
  type IntradayBar,
} from "../src/lib/longPolarity";
import { isTradingDay, tradingDaysBetween } from "../src/lib/marketCalendar";
import { computePolaritySeries, type Bar, type CandleKind } from "../src/lib/polarity";

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

/** Random-walk daily bars on real trading days only. */
function walk(from: string, to: string, seed = 7): Bar[] {
  const r = rng(seed);
  let price = 400;
  return tradingDaysBetween(from, to).map((date) => {
    const open = price;
    const close = open * (1 + (r() - 0.5) * 0.03);
    const high = Math.max(open, close) * (1 + r() * 0.005);
    const low = Math.min(open, close) * (1 - r() * 0.005);
    price = close;
    return { date, open, high, low, close, volume: 50_000_000 + Math.floor(r() * 100_000_000) };
  });
}

const closeOf = (date: string) => new Date(`${date}T21:30:00Z`); // after the close, New York

describe("only month, quarter, 6-month and year exist", () => {
  it("no daily or weekly timeframe", () => {
    assert.deepEqual([...LONG_TIMEFRAMES], ["M", "Q", "H", "Y"]);
    assert.equal(coerceLongTimeframe("1D"), DEFAULT_DECISION_TIMEFRAME);
    assert.equal(coerceLongTimeframe("1W"), DEFAULT_DECISION_TIMEFRAME);
    assert.equal(coerceLongTimeframe("Q"), "Q");
    assert.equal(DEFAULT_DECISION_TIMEFRAME, "M");
  });
  it("6-month boundaries", () => {
    assert.equal(longPeriodStart("2026-06-30", "H"), "2026-01-01");
    assert.equal(longPeriodEnd("2026-06-30", "H"), "2026-06-30");
    assert.equal(longPeriodStart("2026-07-01", "H"), "2026-07-01");
    assert.equal(longPeriodEnd("2026-11-20", "H"), "2026-12-31");
  });
});

describe("candle method equals the chart's own rule (periodBucketsFor) for month, quarter and year", () => {
  const bars = walk("2023-06-01", "2026-11-20");
  it("same polarity, net volume and floor at many cut points", () => {
    let compared = 0;
    for (let cut = 300; cut < bars.length; cut += 11) {
      const slice = bars.slice(0, cut + 1);
      const results = computePolaritySeries(slice);
      const readings = computeLongReadings({ daily: slice, now: closeOf(slice[slice.length - 1].date), method: "candle" });
      for (const [tf, frame] of [["M", "1M"], ["Q", "3M"], ["Y", "1Y"]] as const) {
        const app = periodBucketsFor(slice, results, frame)[0];
        const mine = readings[tf];
        if (!app) {
          assert.equal(mine.status, "unavailable");
          continue;
        }
        assert.equal(mine.status, "ok", `${slice[slice.length - 1].date} ${tf}: ${mine.reason}`);
        assert.equal(mine.polarity, app.polarity, `${slice[slice.length - 1].date} ${tf}`);
        assert.equal(mine.netVolume, app.netVolume);
        assert.equal(mine.noiseFloor, app.noiseFloor);
        compared++;
      }
    }
    assert.ok(compared > 50);
  });
});

/** September 2026 trading days as a base, then October 1-2 with a red heavy day and a green light day. */
function disagreementCase(): { daily: Bar[]; intraday: IntradayBar[] } {
  const daily: Bar[] = tradingDaysBetween("2026-08-03", "2026-09-30").map((date, i) => ({
    date, open: 100, high: 101, low: 99, close: i % 2 === 0 ? 100.5 : 99.5, volume: 100,
  }));
  daily.push({ date: "2026-10-01", open: 100, high: 100.5, low: 89.5, close: 90, volume: 300 });
  daily.push({ date: "2026-10-02", open: 90, high: 101.5, low: 89.8, close: 101, volume: 100 });
  const intraday: IntradayBar[] = [];
  for (const d of daily.filter((x) => x.date >= "2026-10-01")) {
    const n = 4;
    for (let k = 0; k < n; k++) {
      const up = d.close > d.open;
      intraday.push({ t: `${d.date}T${String(14 + k).padStart(2, "0")}:30:00Z`, date: d.date, open: 100, close: up ? 101 : 99, volume: d.volume / n });
    }
  }
  return { daily, intraday };
}

describe("signed volume versus the candle sign", () => {
  const { daily } = disagreementCase();
  const now = new Date("2026-10-02T21:30:00Z");
  it("the candle is green (close above the month's open) but the signed volume is negative: Neutral", () => {
    const candle = computeLongReadings({ daily, now, method: "candle" }).M;
    const signed = computeLongReadings({ daily, now, method: "signed-daily" }).M;
    assert.equal(candle.status, "ok");
    assert.equal(candle.polarity, 1);
    assert.equal(candle.kind, "green");
    assert.equal(signed.polarity, 0);
    assert.equal(signed.label, "Neutral");
    assert.equal(signed.netSign, -1);
    assert.equal(signed.agreement, "disagree");
    assert.equal(signed.netVolume, -200);
    assert.equal(signed.upVolume, 100);
    assert.equal(signed.downVolume, 300);
    assert.equal(signed.periodStart, "2026-10-01");
    assert.equal(signed.throughDate, "2026-10-02");
    assert.equal(signed.asOf, now.toISOString());
  });
  it("exactly zero is Neutral, not a guess", () => {
    const flat = daily.map((b) => (b.date === "2026-10-01" ? { ...b, close: 90, volume: 100 } : b));
    const r = computeLongReadings({ daily: flat, now, method: "signed-daily" }).M;
    assert.equal(r.netVolume, 0);
    assert.equal(r.polarity, 0);
    assert.equal(r.label, "Neutral");
  });
  it("a flat day uses close-location x volume (the repo's daily rule)", () => {
    const d2 = daily.map((b) => (b.date === "2026-10-02" ? { ...b, open: 95, close: 95, high: 100, low: 90, volume: 100 } : b));
    const r = computeLongReadings({ daily: d2, now, method: "signed-daily" }).M;
    assert.equal(r.netVolume, -300); // CLV 0 on the flat day
  });
});

describe("alignment rule: candle colour and net volume must match", () => {
  const now = new Date("2026-10-02T21:30:00Z");
  const oct = (a: { open: number; close: number; volume: number }, b: { open: number; close: number; volume: number }): Bar[] => {
    const { daily } = disagreementCase();
    const base = daily.filter((x) => x.date < "2026-10-01");
    const mk = (date: string, v: { open: number; close: number; volume: number }): Bar => ({ date, open: v.open, close: v.close, volume: v.volume, high: Math.max(v.open, v.close) + 0.1, low: Math.min(v.open, v.close) - 0.1 });
    return [...base, mk("2026-10-01", a), mk("2026-10-02", b)];
  };
  const read = (daily: Bar[]) => computeLongReadings({ daily, now, method: "signed-daily" }).M;

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
    const r = read(oct({ open: 100, close: 100.5, volume: 100 }, { open: 100.5, close: 101, volume: 100 }));
    assert.equal(r.kind, "green");
    assert.equal(r.netVolume, 200);
    assert.equal(r.polarity, 1);
    assert.equal(r.label, "Drive");
    assert.equal(r.agreement, "agree");
  });
  it("red candle and negative net volume = -1 Reverse", () => {
    const r = read(oct({ open: 100, close: 90, volume: 300 }, { open: 90, close: 89, volume: 100 }));
    assert.equal(r.kind, "red");
    assert.equal(r.netVolume, -400);
    assert.equal(r.polarity, -1);
    assert.equal(r.label, "Reverse");
    assert.equal(r.agreement, "agree");
  });
  it("green candle but negative net volume = 0 Neutral", () => {
    const r = read(oct({ open: 100, close: 90, volume: 300 }, { open: 90, close: 101, volume: 100 }));
    assert.equal(r.kind, "green");
    assert.equal(r.netVolume, -200);
    assert.equal(r.polarity, 0);
    assert.equal(r.label, "Neutral");
    assert.equal(r.status, "ok");
    assert.equal(r.agreement, "disagree");
  });
  it("red candle but positive net volume = 0 Neutral", () => {
    const r = read(oct({ open: 100, close: 95, volume: 100 }, { open: 95, close: 98, volume: 300 }));
    assert.equal(r.kind, "red");
    assert.equal(r.netVolume, 200);
    assert.equal(r.polarity, 0);
    assert.equal(r.label, "Neutral");
    assert.equal(r.agreement, "disagree");
  });
  it("zero net volume is Neutral whatever the colour", () => {
    const r = read(oct({ open: 100, close: 90, volume: 100 }, { open: 90, close: 101, volume: 100 }));
    assert.equal(r.kind, "green");
    assert.equal(r.netVolume, 0);
    assert.equal(r.polarity, 0);
    assert.equal(r.netSign, 0);
  });
  it("a flat candle (close equals the period's open) is Neutral even with positive net volume", () => {
    const r = read(oct({ open: 100, close: 95, volume: 100 }, { open: 95, close: 100, volume: 300 }));
    assert.equal(r.kind, "flat");
    assert.equal(r.netVolume, 200);
    assert.equal(r.polarity, 0);
  });
  it("missing or zero volume or no bars is Data unavailable, never Neutral", () => {
    const zero = read(oct({ open: 100, close: 100.5, volume: 0 }, { open: 100.5, close: 101, volume: 100 }));
    assert.equal(zero.status, "unavailable");
    assert.equal(zero.polarity, null);
    assert.equal(zero.label, "Data unavailable");
    assert.equal(zero.agreement, null);
    const none = computeLongReadings({ daily: [], now, method: "signed-daily" }).M;
    assert.equal(none.status, "unavailable");
    assert.equal(none.polarity, null);
    const nanVol = read(oct({ open: 100, close: 100.5, volume: Number.NaN }, { open: 100.5, close: 101, volume: 100 }));
    assert.equal(nanVol.polarity, null);
  });
  it("the aligned rule also applies to the 5-minute method, with the candle and net volume shown side by side", () => {
    const { daily, intraday } = disagreementCase();
    const r = computeLongReadings({ daily, intraday, now, method: "signed-intraday" }).M;
    assert.equal(r.kind, "green");
    assert.equal(r.open, 100);
    assert.equal(r.close, 101);
    assert.equal(r.netVolume, -200);
    assert.equal(r.polarity, 0);
    assert.equal(r.asOf, now.toISOString());
  });
});

describe("signed 5-minute method", () => {
  const { daily, intraday } = disagreementCase();
  const now = new Date("2026-10-02T21:30:00Z");
  it("sums the whole period's 5-minute bars into one value", () => {
    const r = computeLongReadings({ daily, intraday, now, method: "signed-intraday" }).M;
    assert.equal(r.status, "ok", r.reason ?? "");
    assert.equal(r.netVolume, -200);
    assert.equal(r.kind, "green");
    assert.equal(r.polarity, 0);
    assert.equal(r.lastBarAt, "2026-10-02T17:30:00Z");
  });
  it("is the default method", () => {
    assert.equal(DEFAULT_NET_VOLUME_METHOD, "signed-intraday");
  });
  it("is unavailable when the 5-minute volume does not add up to the daily volume", () => {
    const thin = intraday.map((b) => (b.date === "2026-10-01" ? { ...b, volume: b.volume / 2 } : b));
    const r = computeLongReadings({ daily, intraday: thin, now, method: "signed-intraday" }).M;
    assert.equal(r.status, "unavailable");
    assert.equal(r.polarity, null);
    assert.match(r.reason ?? "", /5-minute volume on 2026-10-01/);
  });
  it("is unavailable when a whole session has no 5-minute bars", () => {
    const r = computeLongReadings({ daily, intraday: intraday.filter((b) => b.date !== "2026-10-01"), now, method: "signed-intraday" }).M;
    assert.equal(r.status, "unavailable");
    assert.match(r.reason ?? "", /no 5-minute bars on 2026-10-01/);
  });
  it("is unavailable with no 5-minute bars at all", () => {
    assert.equal(computeLongReadings({ daily, now, method: "signed-intraday" }).M.status, "unavailable");
  });
  it("during the session the newest 5-minute bar must be recent", () => {
    const during = new Date("2026-10-02T18:30:00Z"); // 14:30 ET
    const stale = computeLongReadings({ daily, intraday, now: during, method: "signed-intraday" }).M;
    assert.equal(stale.status, "unavailable");
    assert.match(stale.reason ?? "", /minutes old/);
    const fresh = computeLongReadings({ daily, intraday, now: new Date("2026-10-02T17:40:00Z"), method: "signed-intraday" }).M;
    assert.equal(fresh.status, "ok", fresh.reason ?? "");
  });
  it("the in-progress session is not ratio-checked, but a malformed bar is rejected", () => {
    const partial = intraday.filter((b) => !(b.date === "2026-10-02" && b.t > "2026-10-02T15:30:00Z"));
    const r = computeLongReadings({ daily, intraday: partial, now: new Date("2026-10-02T15:45:00Z"), method: "signed-intraday" }).M;
    assert.equal(r.status, "ok", r.reason ?? "");
    const bad = intraday.map((b, i) => (i === 3 ? { ...b, volume: Number.NaN } : b));
    assert.equal(computeLongReadings({ daily, intraday: bad, now, method: "signed-intraday" }).M.status, "unavailable");
  });
});

describe("stale or incomplete data is never decided on", () => {
  const { daily } = disagreementCase();
  const now = new Date("2026-10-02T21:30:00Z");
  it("a newest bar that is not the current session's makes every reading unavailable", () => {
    const next = computeLongReadings({ daily, now: new Date("2026-10-05T15:00:00Z"), method: "signed-daily" }); // Monday, needs Monday's bar
    for (const tf of LONG_TIMEFRAMES) {
      assert.equal(next[tf].status, "unavailable");
      assert.equal(next[tf].polarity, null);
      assert.match(next[tf].reason ?? "", /stale data/);
    }
    assert.equal(readingsSummary(next), "M:- Q:- H:- Y:-");
  });
  it("a weekend uses Friday's bar and is fine", () => {
    assert.equal(computeLongReadings({ daily, now: new Date("2026-10-03T18:00:00Z"), method: "signed-daily" }).M.status, "ok");
  });
  it("a missing session inside the period", () => {
    const gap = daily.filter((b) => b.date !== "2026-10-01");
    const r = computeLongReadings({ daily: gap, now, method: "signed-daily" }).M;
    assert.equal(r.status, "unavailable");
    assert.match(r.reason ?? "", /no daily bar for 2026-10-01/);
  });
  it("zero or missing volume", () => {
    const zero = daily.map((b) => (b.date === "2026-10-02" ? { ...b, volume: 0 } : b));
    const r = computeLongReadings({ daily: zero, now, method: "signed-daily" }).M;
    assert.equal(r.status, "unavailable");
    assert.match(r.reason ?? "", /volume missing or zero on 2026-10-02/);
    const nan = daily.map((b) => (b.date === "2026-10-02" ? { ...b, volume: Number.NaN } : b));
    const r2 = computeLongReadings({ daily: nan, now, method: "signed-daily" });
    assert.equal(r2.M.status, "unavailable");
    assert.match(r2.M.reason ?? "", /rejected/);
  });
  it("malformed bars", () => {
    const bad = daily.map((b) => (b.date === "2026-10-02" ? { ...b, high: 80 } : b));
    assert.equal(computeLongReadings({ daily: bad, now, method: "signed-daily" }).Y.status, "unavailable");
  });
  it("a period that starts before the loaded history is unavailable (6-month and year here)", () => {
    const r = computeLongReadings({ daily, now, method: "signed-daily" });
    assert.equal(r.M.status, "ok");
    assert.equal(r.H.status, "unavailable");
    assert.equal(r.Y.status, "unavailable");
    assert.match(r.H.reason ?? "", /does not reach the start/);
  });
  it("an unknown method or no bars is unavailable, never a throw", () => {
    assert.equal(computeLongReadings({ daily: [], now }).M.status, "unavailable");
    assert.equal(computeLongReadings({ daily, now, method: "bogus" as never }).M.status, "unavailable");
  });
});

describe("audit inputs and live behaviour on a long history", () => {
  const bars = walk("2025-01-02", "2026-11-20", 11);
  const now = new Date("2026-11-20T20:00:00Z");
  it("all four periods read, with their start, net volume and as-of time", () => {
    const r = computeLongReadings({ daily: bars, now, method: "signed-daily" });
    assert.deepEqual(Object.keys(r), ["M", "Q", "H", "Y"]);
    assert.equal(r.M.periodStart, "2026-11-01");
    assert.equal(r.Q.periodStart, "2026-10-01");
    assert.equal(r.H.periodStart, "2026-07-01");
    assert.equal(r.Y.periodStart, "2026-01-01");
    for (const tf of LONG_TIMEFRAMES) {
      assert.equal(r[tf].status, "ok", r[tf].reason ?? "");
      assert.ok(typeof r[tf].netVolume === "number");
      assert.equal(r[tf].asOf, now.toISOString());
      assert.equal(r[tf].throughDate, "2026-11-20");
      assert.equal(r[tf].polarity, alignedPolarity(r[tf].kind as CandleKind, r[tf].netVolume as number));
      assert.equal(r[tf].netSign, Math.sign(r[tf].netVolume as number));
      assert.equal((r[tf].upVolume as number) - (r[tf].downVolume as number), r[tf].netVolume);
    }
  });
  it("the reading follows the data live: a lower last close can turn the candle reading", () => {
    const base = bars.slice(0, -1);
    const last = bars[bars.length - 1];
    const up = [...base, { ...last, open: last.open, close: last.open * 1.05, high: last.open * 1.06, low: last.open * 0.99 }];
    const down = [...base, { ...last, open: last.open, close: last.open * 0.95, high: last.open * 1.01, low: last.open * 0.94 }];
    const a = computeLongReadings({ daily: up, now, method: "signed-daily" }).M;
    const b = computeLongReadings({ daily: down, now, method: "signed-daily" }).M;
    assert.ok((a.netVolume as number) > (b.netVolume as number));
  });
  it("no look-ahead: the reading from truncated bars never uses later bars", () => {
    const cut = bars.findIndex((b) => b.date === "2026-09-30");
    const at = computeLongReadings({ daily: bars.slice(0, cut + 1), now: closeOf("2026-09-30"), method: "signed-daily" });
    const polluted = bars.map((b, i) => (i > cut ? { ...b, volume: 1, close: b.open * 0.5, low: b.open * 0.4 } : b));
    const same = computeLongReadings({ daily: polluted.slice(0, cut + 1), now: closeOf("2026-09-30"), method: "signed-daily" });
    for (const tf of LONG_TIMEFRAMES) assert.deepEqual(at[tf], same[tf]);
    assert.ok(isTradingDay("2026-09-30"));
  });
});
