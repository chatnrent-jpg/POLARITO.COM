import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bucketsFor, sentimentForBucket, weekStart } from "../src/lib/chartBuckets";
import { computePolaritySeries, windowFor, type Bar } from "../src/lib/polarity";

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

  it("1D / 1W / 1M keep one bar per day and the engine's own numbers", () => {
    for (const tf of ["1D", "1W", "1M"] as const) {
      const view = windowFor(results, tf);
      const buckets = bucketsFor(view, tf);
      assert.equal(buckets.length, view.length);
      buckets.forEach((b, i) => {
        assert.equal(b.netVolume, view[i].netVolume);
        assert.equal(b.noiseFloor, view[i].noiseFloor);
        assert.equal(b.polarity, view[i].polarity);
      });
    }
  });

  it("3M groups into weekly bars, 1Y into monthly bars (far fewer bars)", () => {
    const w = bucketsFor(windowFor(results, "3M"), "3M");
    const m = bucketsFor(windowFor(results, "1Y"), "1Y");
    assert.ok(w.length >= 12 && w.length <= 14, `weekly bars: ${w.length}`);
    assert.ok(m.length >= 12 && m.length <= 13, `monthly bars: ${m.length}`);
    assert.equal(w.reduce((s, b) => s + b.dates.length, 0), 63);
    assert.equal(m.reduce((s, b) => s + b.dates.length, 0), 252);
  });

  it("a grouped bar sums Net Volume and Noise Floor and gates the sums", () => {
    const view = windowFor(results, "3M");
    const [first] = bucketsFor(view, "3M");
    const days = view.filter((d) => first.dates.includes(d.date));
    assert.equal(first.netVolume, days.reduce((s, d) => s + d.netVolume, 0));
    assert.equal(first.noiseFloor, days.reduce((s, d) => s + (d.noiseFloor as number), 0));
  });

  it("a bar with a not-ready day stays Neutral with no floor", () => {
    const early = results.slice(0, 5); // fewer than 20 bars of history
    const [b] = bucketsFor(early, "3M");
    assert.equal(b.noiseFloor, null);
    assert.equal(b.polarity, 0);
  });

  it("sentimentForBucket pools live days, and reports unavailable when none are live", () => {
    const [b] = bucketsFor(windowFor(results, "3M"), "3M");
    const none = sentimentForBucket(b, {});
    assert.equal(none.live, false);
    assert.equal(none.polarity, 0);

    const byDate: Record<string, never> = {} as never;
    for (const date of b.dates) {
      (byDate as Record<string, unknown>)[date] = {
        date,
        positiveHits: 3,
        negativeHits: 0,
        articles: 2,
        velocity: 1,
        polarity: 1,
        source: "news",
      };
    }
    const live = sentimentForBucket(b, byDate);
    assert.equal(live.live, true);
    assert.equal(live.polarity, 1);
    assert.equal(live.positiveHits, 3 * b.dates.length);
  });
});
