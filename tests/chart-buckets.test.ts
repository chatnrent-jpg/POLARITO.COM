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

  it("each of 1W/1M/3M/1Y shows exactly ONE bar: the current period, scored by the engine", () => {
    const bars = makeBars(300); // Mon 2026-01-05 .. Fri 2027-02-26 region
    const series = computePolaritySeries(bars);
    const lastDate = bars[bars.length - 1].date;
    for (const tf of ["1W", "1M", "3M", "1Y"] as const) {
      const out = periodBucketsFor(bars, series, tf);
      assert.equal(out.length, 1, tf);
      const [b] = out;
      assert.ok(b.dates.includes(lastDate), `${tf} bar contains the newest day`);
      const days = bars.filter((x) => b.dates.includes(x.date));
      assert.ok(b.candle);
      assert.equal(b.candle.open, days[0].open);
      assert.equal(b.candle.close, days[days.length - 1].close);
      assert.equal(b.candle.high, Math.max(...days.map((d) => d.high)));
      assert.equal(b.candle.low, Math.min(...days.map((d) => d.low)));
      assert.equal(b.candle.volume, days.reduce((sum, d) => sum + d.volume, 0));
      assert.equal(b.netVolume, netVolume({ date: lastDate, ...b.candle }));
      const floors = series.filter((r) => b.dates.includes(r.date)).map((r) => r.noiseFloor as number);
      assert.equal(b.noiseFloor, floors.reduce((sum, f) => sum + f, 0));
      assert.equal(b.polarity, gate(b.netVolume, b.noiseFloor as number));
    }
  });

  it("the single bar covers exactly the current ISO week / month / quarter / year", () => {
    const bars = makeBars(300);
    const series = computePolaritySeries(bars);
    const lastDate = bars[bars.length - 1].date;
    const [w] = periodBucketsFor(bars, series, "1W");
    assert.ok(w.dates.every((d) => weekStart(d) === weekStart(lastDate)));
    const [m] = periodBucketsFor(bars, series, "1M");
    assert.ok(m.dates.every((d) => d.slice(0, 7) === lastDate.slice(0, 7)));
    const [y] = periodBucketsFor(bars, series, "1Y");
    assert.ok(y.dates.every((d) => d.slice(0, 4) === lastDate.slice(0, 4)));
    const q = (d: string) => `${d.slice(0, 4)}-${Math.floor((Number(d.slice(5, 7)) - 1) / 3)}`;
    const [qb] = periodBucketsFor(bars, series, "3M");
    assert.ok(qb.dates.every((d) => q(d) === q(lastDate)));
  });

  it("the bar moves with the live day; a new period replaces it", () => {
    const bars = makeBars(300);
    const before = periodBucketsFor(bars, computePolaritySeries(bars), "1M")[0];
    const ticked = bars.map((b, i) => (i === bars.length - 1 ? { ...b, close: b.close + 2, high: b.high + 2, volume: b.volume + 777 } : b));
    const after = periodBucketsFor(ticked, computePolaritySeries(ticked), "1M")[0];
    assert.equal(after.key, before.key);
    assert.equal(after.candle!.volume, before.candle!.volume + 777);
    const next = makeBars(300 + 25);
    const rolled = periodBucketsFor(next, computePolaritySeries(next), "1M")[0];
    assert.notEqual(rolled.key, before.key);
  });

  it("a period with a not-ready day stays Neutral with no floor", () => {
    const bars = makeBars(30).slice(0, 10); // fewer than 20 bars of history
    const [b] = periodBucketsFor(bars, computePolaritySeries(bars), "1W");
    assert.equal(b.noiseFloor, null);
    assert.equal(b.polarity, 0);
  });

  it("a period the loaded bars do not reach back to is never drawn half-full", () => {
    const trimmed = makeBars(300).slice(10); // starts mid-January
    assert.deepEqual(periodBucketsFor(trimmed.slice(0, 40), computePolaritySeries(trimmed.slice(0, 40)), "1Y"), []);
    assert.deepEqual(periodBucketsFor([], [], "1W"), []);
  });

  it("labels: week range, month, quarter, year", () => {
    const bars = makeBars(300);
    const series = computePolaritySeries(bars);
    assert.match(periodBucketsFor(bars, series, "1W")[0].label, /^[A-Z][a-z]{2} \d{1,2}( – [A-Z][a-z]{2} \d{1,2})?, \d{4}$|^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    assert.match(periodBucketsFor(bars, series, "1M")[0].label, /^[A-Z][a-z]+ \d{4}$/);
    assert.match(periodBucketsFor(bars, series, "3M")[0].label, /^Q[1-4] \d{4}$/);
    assert.match(periodBucketsFor(bars, series, "1Y")[0].label, /^\d{4}$/);
  });

  it("sentimentForBucket pools the live days of the period bar", () => {
    const bars = makeBars(300);
    const series = computePolaritySeries(bars);
    const [b] = periodBucketsFor(bars, series, "3M");
    const none = sentimentForBucket(b, {});
    assert.equal(none.live, false);
    assert.equal(none.polarity, 0);
  });
});
