import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { periodBucketsFor, sentimentForBucket } from "../src/lib/chartBuckets";
import {
  aggregatePeriods,
  easternDate,
  mergeBars,
  periodEnd,
  periodStart,
  weekStart,
  type Period,
} from "../src/lib/periodCandles";
import { computePolaritySeries, type Bar } from "../src/lib/polarity";

/** Weekday bars from `from` (inclusive), n of them, deterministic prices and volume. */
function makeBars(from: string, n: number): Bar[] {
  const bars: Bar[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (bars.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const i = bars.length;
      const open = 100 + (i % 17);
      const close = open + ((i * 7) % 5) - 2;
      bars.push({
        date: d.toISOString().slice(0, 10),
        open,
        high: Math.max(open, close) + 1 + (i % 3),
        low: Math.min(open, close) - 1 - (i % 2),
        close,
        volume: 1_000_000 + (i % 7) * 111_111,
      });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

const PERIODS: Period[] = ["week", "month", "quarter", "year"];

describe("period boundaries", () => {
  it("ISO weeks start on Monday and span a year boundary as one week", () => {
    assert.equal(weekStart("2026-12-31"), "2026-12-28"); // Thursday
    assert.equal(weekStart("2027-01-01"), "2026-12-28"); // Friday, same ISO week
    assert.equal(periodEnd("2027-01-01", "week"), "2027-01-03");
    assert.equal(weekStart("2026-01-04"), "2025-12-29"); // Sunday belongs to the week before
    assert.equal(weekStart("2026-01-05"), "2026-01-05");
  });

  it("calendar month, quarter and year start/end, including a leap February", () => {
    assert.equal(periodStart("2028-02-17", "month"), "2028-02-01");
    assert.equal(periodEnd("2028-02-17", "month"), "2028-02-29");
    assert.equal(periodEnd("2027-02-17", "month"), "2027-02-28");
    assert.equal(periodStart("2026-05-20", "quarter"), "2026-04-01");
    assert.equal(periodEnd("2026-05-20", "quarter"), "2026-06-30");
    assert.equal(periodStart("2026-12-31", "quarter"), "2026-10-01");
    assert.equal(periodEnd("2026-12-31", "quarter"), "2026-12-31");
    assert.equal(periodStart("2026-09-30", "quarter"), "2026-07-01");
    assert.equal(periodStart("2026-07-04", "year"), "2026-01-01");
    assert.equal(periodEnd("2026-07-04", "year"), "2026-12-31");
  });

  it("a week that straddles two months is one weekly candle but splits across two monthly ones", () => {
    const bars = makeBars("2026-01-26", 10); // Mon Jan 26 ... Fri Feb 6
    const weekly = aggregatePeriods(bars, "week", "2026-02-06");
    const monthly = aggregatePeriods(bars, "month", "2026-02-06");
    assert.equal(weekly.length, 2);
    assert.deepEqual(weekly[0].dates, bars.slice(0, 5).map((b) => b.date)); // Jan 26-30
    assert.equal(monthly.length, 2);
    assert.deepEqual(monthly[0].dates, bars.slice(0, 5).map((b) => b.date)); // Jan 26-30
    assert.equal(monthly[1].key, "2026-02-01");
  });

  it("easternDate gives the New York session date, not the UTC date", () => {
    assert.equal(easternDate(new Date("2026-11-20T03:00:00Z")), "2026-11-19"); // 22:00 EST the night before
    assert.equal(easternDate(new Date("2026-07-01T03:59:00Z")), "2026-06-30"); // 23:59 EDT
    assert.equal(easternDate(new Date("2026-07-01T04:00:00Z")), "2026-07-01");
  });
});

describe("aggregatePeriods builds real OHLC", () => {
  const bars = makeBars("2025-10-01", 330);
  const today = bars[bars.length - 1].date;

  for (const period of PERIODS) {
    it(`${period}: open of first, high of max, low of min, close of last, volume summed`, () => {
      for (const c of aggregatePeriods(bars, period, today)) {
        const days = bars.filter((b) => c.dates.includes(b.date));
        assert.equal(c.open, days[0].open);
        assert.equal(c.close, days[days.length - 1].close);
        assert.equal(c.high, Math.max(...days.map((d) => d.high)));
        assert.equal(c.low, Math.min(...days.map((d) => d.low)));
        assert.equal(c.volume, days.reduce((s, d) => s + d.volume, 0));
        assert.ok(c.dates.every((d) => d >= c.start && d <= c.end), "every day sits inside its period");
      }
    });
  }

  it("every bar lands in exactly one candle", () => {
    for (const period of PERIODS) {
      const total = aggregatePeriods(bars, period, today).reduce((s, c) => s + c.dates.length, 0);
      assert.equal(total, bars.length, period);
    }
  });
});

describe("only the current candle changes", () => {
  const all = makeBars("2025-10-01", 330);

  for (const period of PERIODS) {
    it(`${period}: finished candles are identical as later bars arrive`, () => {
      const cut = 250;
      const earlier = aggregatePeriods(all.slice(0, cut), period, all[cut - 1].date);
      const later = aggregatePeriods(all, period, all[all.length - 1].date);
      // Every candle except the one the earlier snapshot was still inside is final.
      const finished = earlier.slice(0, -1);
      assert.ok(finished.length > 0);
      for (const c of finished) {
        const same = later.find((x) => x.key === c.key);
        assert.deepEqual({ ...same, live: undefined }, { ...c, live: undefined });
      }
    });

    it(`${period}: a price tick moves only the live candle`, () => {
      const today = all[all.length - 1].date;
      const before = aggregatePeriods(all, period, today);
      const ticked = all.map((b, i) =>
        i === all.length - 1 ? { ...b, close: b.close + 3, high: b.high + 3, volume: b.volume + 500 } : b,
      );
      const after = aggregatePeriods(ticked, period, today);
      assert.equal(before.length, after.length);
      before.slice(0, -1).forEach((c, i) => assert.deepEqual(after[i], c));
      const liveBefore = before[before.length - 1];
      const liveAfter = after[after.length - 1];
      assert.notEqual(liveAfter.close, liveBefore.close);
      assert.equal(liveAfter.volume, liveBefore.volume + 500);
      assert.equal(liveAfter.live, true);
    });
  }

  it("a period is live until its last calendar day has passed", () => {
    const bars = makeBars("2026-10-26", 5); // Mon Oct 26 - Fri Oct 30
    assert.equal(aggregatePeriods(bars, "week", "2026-10-30")[0].live, true);
    assert.equal(aggregatePeriods(bars, "week", "2026-11-02")[0].live, false);
    assert.equal(aggregatePeriods(bars, "month", "2026-10-30")[0].live, true);
    assert.equal(aggregatePeriods(bars, "month", "2026-11-02")[0].live, false);
  });
});

describe("coverage and merging", () => {
  it("a period is covered only when the loaded history reaches its start", () => {
    const bars = makeBars("2026-01-14", 120); // starts mid January
    const c = aggregatePeriods(bars, "month", bars[bars.length - 1].date);
    assert.equal(c[0].key, "2026-01-01");
    assert.equal(c[0].covered, false);
    assert.equal(c[1].covered, true);
    const y = aggregatePeriods(bars, "year", bars[bars.length - 1].date);
    assert.equal(y[0].covered, false);
  });

  it("a period that opens on a weekend or holiday still counts as covered", () => {
    const bars = makeBars("2026-01-02", 60); // Jan 1 is a holiday: first bar is Fri Jan 2
    assert.equal(aggregatePeriods(bars, "year", "2026-03-01")[0].covered, true);
    assert.equal(aggregatePeriods(bars, "quarter", "2026-03-01")[0].covered, true);
  });

  it("mergeBars puts older history under the live bars, recent wins, no duplicates", () => {
    const history = makeBars("2025-01-02", 40);
    const recent = makeBars(history[30].date, 30).map((b) => ({ ...b, close: b.close + 50 }));
    const merged = mergeBars(history, recent);
    const dates = merged.map((b) => b.date);
    assert.deepEqual(dates, [...dates].sort());
    assert.equal(new Set(dates).size, dates.length);
    const overlap = merged.find((b) => b.date === history[35].date)!;
    assert.equal(overlap.close, recent.find((b) => b.date === history[35].date)!.close);
    assert.equal(merged[0].date, history[0].date);
  });
});

describe("period buckets through the engine", () => {
  const bars = makeBars("2024-06-03", 600);
  const series = computePolaritySeries(bars);
  const today = bars[bars.length - 1].date;

  it("shows only covered periods, newest last, capped per view", () => {
    const week = periodBucketsFor(bars, series, "1W", today);
    const year = periodBucketsFor(bars, series, "1Y", today);
    assert.equal(week.length, 26);
    assert.ok(year.length >= 2 && year.length <= 7);
    assert.equal(week[week.length - 1].live, true);
    assert.ok(week.slice(0, -1).every((b) => b.live === false));
    assert.equal(year[year.length - 1].mode, "year");
  });

  it("the live bucket's Net Volume follows the partial candle; finished ones never move", () => {
    const live = periodBucketsFor(bars, series, "1M", today);
    const bumped = bars.map((b, i) => (i === bars.length - 1 ? { ...b, close: b.open - 5, low: b.low - 5 } : b));
    const bumpedSeries = computePolaritySeries(bumped);
    const after = periodBucketsFor(bumped, bumpedSeries, "1M", today);
    live.slice(0, -1).forEach((b, i) => assert.deepEqual(after[i], b));
    assert.notDeepEqual(after[after.length - 1].candle, live[live.length - 1].candle);
  });

  it("sentimentForBucket pools the live news days of a period bar", () => {
    const [b] = periodBucketsFor(bars, series, "1M", today);
    assert.equal(sentimentForBucket(b, {}).live, false);
    const byDate: Record<string, unknown> = {};
    for (const date of b.dates) {
      byDate[date] = { date, positiveHits: 3, negativeHits: 0, articles: 2, velocity: 1, polarity: 1, source: "news" };
    }
    const s = sentimentForBucket(b, byDate as never);
    assert.equal(s.live, true);
    assert.equal(s.polarity, 1);
    assert.equal(s.positiveHits, 3 * b.dates.length);
  });
});
