import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TIMEFRAME_NAMES, computeDeskReadings, isDeskTimeframe, readingKeys } from "../src/lib/deskReadings";
import { tradingDaysBetween } from "../src/lib/marketCalendar";
import type { Bar } from "../src/lib/polarity";
import { buildWaves, computeWwvReading, wwvPolarity } from "../src/lib/wwv";
import { wwvBars, type Row } from "./helpers/wwvFixtures";

const AFTER_CLOSE = new Date("2026-11-03T21:30:00Z");
const compute = (rows: readonly Row[], now = AFTER_CLOSE) => computeWwvReading({ daily: wwvBars(rows), now });

describe("buildWaves (setting 1: close against the previous close)", () => {
  it("a run of the same direction is one wave; the turning bar belongs to the NEW wave", () => {
    const bars = wwvBars([[10, 1], [11, 2], [12, 3], [11, 4], [10, 5], [11, 6]]);
    const w = buildWaves(bars);
    assert.deepEqual(w.map((x) => [x.direction, x.bars, x.volume]), [["up", 2, 5], ["down", 2, 9], ["up", 1, 6]]);
    assert.equal(w[1].startDate, bars[3].date, "the first down bar starts the down wave and carries its own volume");
    assert.equal(w[0].endDate, bars[2].date);
  });
  it("an equal close continues the wave that is running and adds its volume", () => {
    const w = buildWaves(wwvBars([[10, 1], [11, 2], [11, 7], [11, 8], [10, 4], [10, 5]]));
    assert.deepEqual(w.map((x) => [x.direction, x.bars, x.volume]), [["up", 3, 17], ["down", 2, 9]]);
  });
  it("an equal close with no wave yet belongs to no wave; the first bar never has a direction", () => {
    const w = buildWaves(wwvBars([[10, 9], [10, 9], [10, 9], [11, 2]]));
    assert.deepEqual(w.map((x) => [x.direction, x.bars, x.volume]), [["up", 1, 2]]);
  });
  it("one-bar waves each carry only their own bar's volume", () => {
    const w = buildWaves(wwvBars([[10, 1], [11, 2], [10, 3], [11, 4], [10, 5]]));
    assert.deepEqual(w.map((x) => [x.direction, x.bars, x.volume]), [["up", 1, 2], ["down", 1, 3], ["up", 1, 4], ["down", 1, 5]]);
  });
  it("empty and single-bar histories have no wave", () => {
    assert.deepEqual(buildWaves([]), []);
    assert.deepEqual(buildWaves(wwvBars([[10, 1]])), []);
  });
});

describe("the alignment rule", () => {
  it("green + up = Drive, red + down = Reverse, everything else Neutral", () => {
    assert.equal(wwvPolarity("green", "up"), 1);
    assert.equal(wwvPolarity("red", "down"), -1);
    for (const [k, d] of [["green", "down"], ["red", "up"], ["flat", "up"], ["flat", "down"]] as const) assert.equal(wwvPolarity(k, d), 0, `${k} ${d}`);
  });
});

describe("computeWwvReading", () => {
  const history: Row[] = Array.from({ length: 20 }, () => [100, 100] as Row);

  it("Drive: green candle in an up wave; shows wave volume, previous wave volume and the bar used", () => {
    const r = compute([...history, [98, 150], [97, 250], [99, 400], [101, 300]]);
    assert.equal(r.status, "ok");
    assert.equal(r.polarity, 1);
    assert.equal(r.label, "Drive");
    assert.equal(r.kind, "green");
    assert.equal(r.agreement, "agree");
    assert.ok(r.wwv);
    assert.equal(r.wwv.direction, "up");
    assert.equal(r.wwv.waveVolume, 700);
    assert.equal(r.wwv.waveBars, 2);
    assert.deepEqual(r.wwv.previous && [r.wwv.previous.direction, r.wwv.previous.volume, r.wwv.previous.bars], ["down", 400, 2]);
    assert.equal(r.wwv.barDate, "2026-11-03");
    assert.equal(r.wwv.inProgress, false);
    assert.equal(r.throughDate, "2026-11-03");
    assert.equal(r.reason, null);
  });
  it("Reverse: red candle in a down wave", () => {
    const r = compute([...history, [102, 150], [103, 250], [101, 400], [99, 300]]);
    assert.equal(r.polarity, -1);
    assert.equal(r.label, "Reverse");
    assert.equal(r.wwv?.direction, "down");
    assert.equal(r.wwv?.waveVolume, 700);
    assert.equal(r.wwv?.previous?.volume, 400);
  });
  it("Neutral when the candle and the wave disagree, with the reason", () => {
    const greenInDown = compute([...history, [101, 150], [100, 300, 98]]);
    assert.equal(greenInDown.status, "ok");
    assert.equal(greenInDown.polarity, 0);
    assert.equal(greenInDown.agreement, "disagree");
    assert.match(greenInDown.reason ?? "", /candle is green but the wave is down/);
    const redInUp = compute([...history, [99, 150], [101, 300, 102]]);
    assert.equal(redInUp.polarity, 0);
    assert.match(redInUp.reason ?? "", /candle is red but the wave is up/);
  });
  it("a gap does not matter: only close against the previous close sets the direction", () => {
    const gapDownGreen = compute([...history, [100, 100], [99, 300, 98]]);
    assert.equal(gapDownGreen.wwv?.direction, "down");
    assert.equal(gapDownGreen.kind, "green");
    assert.equal(gapDownGreen.polarity, 0);
    const gapUpRed = compute([...history, [101, 300, 103]]);
    assert.equal(gapUpRed.wwv?.direction, "up");
    assert.equal(gapUpRed.kind, "red");
    assert.equal(gapUpRed.polarity, 0);
    const gapUpGreen = compute([...history, [103, 300, 101]]);
    assert.equal(gapUpGreen.polarity, 1);
  });
  it("a flat candle is Neutral", () => {
    const r = compute([...history, [101, 300, 101]]);
    assert.equal(r.kind, "flat");
    assert.equal(r.polarity, 0);
    assert.match(r.reason ?? "", /flat/);
  });
  it("an equal close on the latest bar continues the wave (and its volume counts)", () => {
    const r = compute([...history, [98, 150], [99, 400], [99, 250, 98]]);
    assert.equal(r.wwv?.direction, "up");
    assert.equal(r.wwv?.waveVolume, 650);
    assert.equal(r.wwv?.waveBars, 2);
    assert.equal(r.polarity, 1);
  });
  it("one-bar current wave: only the turning bar's volume; the previous wave is the one before", () => {
    const r = compute([...history, [98, 150], [97, 250], [99, 400]]);
    assert.equal(r.wwv?.waveBars, 1);
    assert.equal(r.wwv?.waveVolume, 400);
    assert.equal(r.wwv?.previous?.volume, 400);
    assert.equal(r.polarity, 1);
  });
  it("every close equal: no direction, unavailable", () => {
    const r = compute(history);
    assert.equal(r.status, "unavailable");
    assert.equal(r.polarity, null);
    assert.match(r.reason ?? "", /no direction/);
    assert.equal(r.wwv, null);
  });
  it("zero or missing volume inside the current wave: unavailable, never a guess", () => {
    const zero = compute([...history, [98, 150], [97, 250], [99, 0], [101, 300]]);
    assert.equal(zero.status, "unavailable");
    assert.match(zero.reason ?? "", /volume missing or zero on 2026-11-02/);
    const missing = compute([...history, [99, 100], [101, Number.NaN]]);
    assert.equal(missing.status, "unavailable");
  });
  it("zero volume outside the current wave does not block it; zero in the previous wave is shown as not trusted", () => {
    const before = compute([...history, [98, 0], [99, 400], [101, 300]]);
    assert.equal(before.status, "ok");
    assert.equal(before.wwv?.waveVolume, 700);
    assert.equal(before.wwv?.previous, null);
    assert.match(before.wwv?.previousNote ?? "", /cannot be trusted: volume missing or zero/);
    const zeroBarBeforeWave = compute([...history, [98, 200], [97, 0], [99, 400], [101, 300]]);
    assert.equal(zeroBarBeforeWave.status, "ok");
    assert.equal(zeroBarBeforeWave.wwv?.previous, null);
  });
  it("the previous wave starting at the first loaded bar is not shown", () => {
    const r = compute([[10, 5], [9, 5], [8, 5], [9, 7], [10, 7]]);
    assert.equal(r.status, "ok");
    assert.equal(r.wwv?.waveVolume, 14);
    assert.equal(r.wwv?.previous?.volume, 10);
    const r2 = compute([[10, 5], [11, 5], [12, 5]]);
    assert.equal(r2.wwv?.previous, null);
    assert.match(r2.wwv?.previousNote ?? "", /no earlier wave/);
    const r3 = compute([[10, 5], [11, 5], [10, 5], [11, 5]]);
    assert.equal(r3.wwv?.previous?.volume, 5);
  });
  it("a missing session inside the current wave (or just before it) makes it unavailable", () => {
    const rows: Row[] = [...history, [98, 150], [99, 400], [101, 300]];
    const all = wwvBars(rows);
    const gap = all.filter((_, i) => i !== all.length - 2);
    const r = computeWwvReading({ daily: gap, now: AFTER_CLOSE });
    assert.equal(r.status, "unavailable");
    assert.match(r.reason ?? "", /no daily bar for 2026-11-02/);
  });
  it("a missing session before the wave start only blocks the previous wave", () => {
    const all = wwvBars([...history, [98, 150], [97, 250], [99, 400], [101, 300]]);
    const gap = all.filter((_, i) => i !== all.length - 4);
    const r = computeWwvReading({ daily: gap, now: AFTER_CLOSE });
    assert.equal(r.status, "ok");
    assert.equal(r.wwv?.previous, null);
    assert.match(r.wwv?.previousNote ?? "", /no daily bar for/);
  });
  it("stale or missing newest bar: unavailable", () => {
    const all = wwvBars([...history, [98, 150], [99, 400], [101, 300]]);
    const stale = computeWwvReading({ daily: all.slice(0, -1), now: AFTER_CLOSE });
    assert.equal(stale.status, "unavailable");
    assert.match(stale.reason ?? "", /stale data/);
    const empty = computeWwvReading({ daily: [], now: AFTER_CLOSE });
    assert.equal(empty.status, "unavailable");
    const weekend = computeWwvReading({ daily: all, now: new Date("2026-11-08T15:00:00Z") });
    assert.equal(weekend.status, "unavailable");
  });
  it("malformed bars (non-finite price, high below low, out of order) are rejected", () => {
    const all = wwvBars([...history, [98, 150], [99, 400], [101, 300]]);
    const nan: Bar[] = all.map((b, i) => (i === all.length - 1 ? { ...b, close: Number.NaN } : b));
    assert.equal(computeWwvReading({ daily: nan, now: AFTER_CLOSE }).status, "unavailable");
    const inverted: Bar[] = all.map((b, i) => (i === 3 ? { ...b, high: b.low - 1 } : b));
    assert.equal(computeWwvReading({ daily: inverted, now: AFTER_CLOSE }).status, "unavailable");
    const shuffled = [...all];
    [shuffled[5], shuffled[6]] = [shuffled[6], shuffled[5]];
    assert.equal(computeWwvReading({ daily: shuffled, now: AFTER_CLOSE }).status, "unavailable");
  });
  it("during the session the bar is in progress (and says so); after the close it is final; before the open it is the day before", () => {
    const rows: Row[] = [...history, [98, 150], [99, 400], [101, 300]];
    const mid = computeWwvReading({ daily: wwvBars(rows), now: new Date("2026-11-03T15:00:00Z") });
    assert.equal(mid.status, "ok");
    assert.equal(mid.wwv?.inProgress, true);
    const fin = computeWwvReading({ daily: wwvBars(rows), now: new Date("2026-11-03T21:01:00Z") });
    assert.equal(fin.wwv?.inProgress, false);
    const pre = computeWwvReading({ daily: wwvBars(rows, "2026-11-02"), now: new Date("2026-11-03T13:00:00Z") });
    assert.equal(pre.status, "ok");
    assert.equal(pre.wwv?.barDate, "2026-11-02");
    assert.equal(pre.wwv?.inProgress, false);
    const preStale = computeWwvReading({ daily: wwvBars(rows, "2026-10-30"), now: new Date("2026-11-03T13:00:00Z") });
    assert.equal(preStale.status, "unavailable");
  });
  it("is pure: the input is not changed and the same input gives the same answer", () => {
    const bars = wwvBars([...history, [98, 150], [97, 250], [99, 400], [101, 300]]);
    const copy = JSON.stringify(bars);
    const a = computeWwvReading({ daily: bars, now: AFTER_CLOSE });
    const b = computeWwvReading({ daily: bars, now: AFTER_CLOSE });
    assert.equal(JSON.stringify(bars), copy);
    assert.deepEqual(a, b);
  });
  it("the history covers real calendar spans: 200 calendar days hold well over 100 sessions", () => {
    assert.ok(tradingDaysBetween("2026-04-17", "2026-11-03").length > 100);
  });
});

describe("desk readings (one key per desk)", () => {
  const daily = wwvBars([...Array.from({ length: 20 }, () => [100, 100] as Row), [98, 150], [99, 400], [101, 300]]);
  it("the WWV desk has exactly one reading, keyed D; the monthly desk keeps its four", () => {
    assert.deepEqual(readingKeys("D"), ["D"]);
    assert.deepEqual(readingKeys("M"), ["M", "Q", "H", "Y"]);
    const d = computeDeskReadings(daily, AFTER_CLOSE, "D");
    assert.deepEqual(Object.keys(d), ["D"]);
    assert.equal(d.D?.timeframe, "D");
    assert.deepEqual(Object.keys(computeDeskReadings(daily, AFTER_CLOSE, "M")).sort(), ["H", "M", "Q", "Y"]);
  });
  it("names and type guard", () => {
    assert.equal(TIMEFRAME_NAMES.D, "Daily, WWV");
    assert.equal(isDeskTimeframe("D"), true);
    assert.equal(isDeskTimeframe("W"), false);
    assert.equal(isDeskTimeframe(undefined), false);
  });
});
