import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUCKET_MODE, bucketsFor, periodBucketsFor, sentimentForBucket, weekStart } from "../src/lib/chartBuckets";
import { computePolaritySeries, gate, netVolume, windowFor, type Bar } from "../src/lib/polarity";

function makeBars(n: number): Bar[] {
  const bars: Bar[] = [];
  const d = new Date(Date.UTC(2026, 0, 5)); // Monday
  while (bars.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const i = bars.length;
      const open = 100 + i;
      const close = open + (i % 2 ? 1 : -1);
      bars.push({
        date: d.toISOString().slice(0, 10),
        open,
        high: Math.max(open, close) + 1,
        low: Math.min(open, close) - 1,
        close,
        volume: 1_000_000 + (i % 5) * 300_000,
      });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

const results = computePolaritySeries(makeBars(300));

describe("chartBuckets", () => {
  it("weekStart maps any weekday to its Monday", () => {
    assert.equal(weekStart("2026-01-05"), "2026-01-05");
    assert.equal(weekStart("2026-01-09"), "2026-01-05");
    assert.equal(weekStart("2026-01-11"), "2026-01-05");
  });

  it("1D keeps one bar for the latest session with the engine's own numbers", () => {
    const view = windowFor(results, "1D");
    const buckets = bucketsFor(view);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].netVolume, view[0].netVolume);
    assert.equal(buckets[0].noiseFloor, view[0].noiseFloor);
    assert.equal(buckets[0].polarity, view[0].polarity);
    assert.equal(buckets[0].candle, undefined);
    assert.equal(buckets[0].mode, "day");
  });

  it("maps 1W/1M/3M/1Y to week/month/quarter/year bars", () => {
    assert.deepEqual(
      ["1D", "1W", "1M", "3M", "1Y"].map((tf) => BUCKET_MODE[tf as keyof typeof BUCKET_MODE]),
      ["day", "week", "month", "quarter", "year"],
    );
  });

  it("period bars are real candles read with the engine's own netVolume and gate", () => {
    const bars = makeBars(300);
    const series = computePolaritySeries(bars);
    const today = bars[bars.length - 1].date;
    const weekly = periodBucketsFor(bars, series, "1W", today);
    assert.ok(weekly.length > 20 && weekly.length <= 26);
    const full = weekly.find((b) => b.dates.length === 5 && !b.live);
    assert.ok(full && full.candle);
    const days = bars.filter((b) => full.dates.includes(b.date));
    assert.equal(full.candle.open, days[0].open);
    assert.equal(full.candle.close, days[days.length - 1].close);
    assert.equal(full.candle.high, Math.max(...days.map((d) => d.high)));
    assert.equal(full.candle.low, Math.min(...days.map((d) => d.low)));
    assert.equal(full.candle.volume, days.reduce((s, d) => s + d.volume, 0));
    assert.equal(
      full.netVolume,
      netVolume({ date: days[4].date, ...full.candle }),
    );
    const floors = series.filter((r) => full.dates.includes(r.date)).map((r) => r.noiseFloor as number);
    assert.equal(full.noiseFloor, floors.reduce((s, f) => s + f, 0));
    assert.equal(full.polarity, gate(full.netVolume, full.noiseFloor as number));
  });

  it("a period with a not-ready day stays Neutral with no floor", () => {
    const bars = makeBars(30).slice(0, 10); // fewer than 20 bars of history
    const series = computePolaritySeries(bars);
    const [b] = periodBucketsFor(bars, series, "1W", bars[bars.length - 1].date);
    assert.equal(b.noiseFloor, null);
    assert.equal(b.polarity, 0);
  });

  it("only fully covered periods are drawn: a cut-off first period is dropped", () => {
    const bars = makeBars(300); // starts Mon 2026-01-05
    const series = computePolaritySeries(bars);
    const monthly = periodBucketsFor(bars, series, "1M", bars[bars.length - 1].date);
    // January starts before the loaded history reaches the 1st only by 4 days: Jan 5 > Jan 1 + 4? No, Jan 5 > Jan 5 is false, so it is covered.
    assert.equal(monthly[0].key, "2026-01-01");
    const trimmed = bars.slice(10); // starts mid-January
    const m2 = periodBucketsFor(trimmed, computePolaritySeries(trimmed), "1M", trimmed[trimmed.length - 1].date);
    assert.equal(m2[0].key, "2026-02-01");
    const y = periodBucketsFor(trimmed, computePolaritySeries(trimmed), "1Y", trimmed[trimmed.length - 1].date);
    assert.ok(y.every((b) => b.key !== "2026-01-01"), "a year that starts before the data is never a candle");
  });

  it("quarterly and yearly bars carry the right labels", () => {
    const bars = makeBars(300);
    const series = computePolaritySeries(bars);
    const today = bars[bars.length - 1].date;
    const q = periodBucketsFor(bars, series, "3M", today);
    assert.match(q[0].label, /^Q[1-4] \d{4}$/);
    const m = periodBucketsFor(bars, series, "1M", today);
    assert.match(m[0].label, /^[A-Z][a-z]+ \d{4}$/);
  });

  it("sentimentForBucket still pools the live days of a period bar", () => {
    const bars = makeBars(300);
    const series = computePolaritySeries(bars);
    const [b] = periodBucketsFor(bars, series, "3M", bars[bars.length - 1].date);
    const none = sentimentForBucket(b, {});
    assert.equal(none.live, false);
    assert.equal(none.polarity, 0);
  });
});
