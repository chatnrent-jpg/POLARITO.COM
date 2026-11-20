import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bucketsFor, periodBucketsFor } from "../src/lib/chartBuckets";
import { computePolaritySeries, windowFor, type Bar } from "../src/lib/polarity";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const NO_NEW_FETCH = /loadHistoryBars|bars\/history|HISTORY_LOOKBACK|lookbackDays|historyEndpoint/;

describe("Daily and the default load path are unchanged", () => {
  it("the default load still asks for the same ~450 days, with no history route anywhere", () => {
    const api = read("src/lib/marketApi.ts");
    assert.match(api, /const LOOKBACK_CALENDAR_DAYS = 450;/);
    assert.match(api, /end\.getTime\(\) - LOOKBACK_CALENDAR_DAYS \* 86_400_000/);
    const offenders = walk(join(root, "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => NO_NEW_FETCH.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders, []);
  });

  it("the chart makes no network calls of its own", () => {
    const src = read("src/components/PolarityChart.tsx");
    assert.doesNotMatch(src, /fetch\(|useEffect|loadBars|NO_NEW_FETCH/);
  });

  it("the ~450 loaded days always cover the whole current week, month, quarter and year", () => {
    // Every possible 'newest bar' date across two years, with the 450-calendar-day window the app loads.
    const all = (() => {
      const out: Bar[] = [];
      const d = new Date("2024-06-03T00:00:00Z");
      while (d < new Date("2027-01-15T00:00:00Z")) {
        if (d.getUTCDay() % 6 !== 0) {
          out.push({ date: d.toISOString().slice(0, 10), open: 100, high: 102, low: 99, close: 101, volume: 1e6 });
        }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      return out;
    })();
    for (let i = 0; i < all.length; i++) {
      const newest = new Date(`${all[i].date}T00:00:00Z`).getTime();
      if (newest < new Date("2025-08-01T00:00:00Z").getTime()) continue;
      const loaded = all.slice(0, i + 1).filter((b) => new Date(`${b.date}T00:00:00Z`).getTime() >= newest - 450 * 86_400_000);
      const series = computePolaritySeries(loaded);
      for (const tf of ["1W", "1M", "3M", "1Y"] as const) {
        const out = periodBucketsFor(loaded, series, tf);
        assert.equal(out.length, 1, `${tf} on ${all[i].date}`);
        assert.notEqual(out[0].noiseFloor, null, `${tf} floor ready on ${all[i].date}`);
      }
    }
  });

  it("the page load / 5s refresh path never touches a history loader", () => {
    for (const f of ["src/components/PolarityDashboard.tsx", "src/components/PageRefresher.tsx", "src/lib/mirrorRunner.ts", "src/lib/barsClient.ts"]) {
      assert.doesNotMatch(read(f), NO_NEW_FETCH, f);
    }
  });

  it("the Daily bar is exactly the engine's latest day", () => {
    const bars: Bar[] = [];
    const d = new Date("2026-01-05T00:00:00Z");
    while (bars.length < 80) {
      if (d.getUTCDay() % 6 !== 0) {
        const i = bars.length;
        const open = 100 + (i % 11);
        const close = open + ((i * 3) % 5) - 2;
        bars.push({ date: d.toISOString().slice(0, 10), open, high: open + 3, low: open - 3, close, volume: 1e6 + i * 1000 });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const results = computePolaritySeries(bars);
    const last = results[results.length - 1];
    assert.deepEqual(bucketsFor(windowFor(results, "1D")), [
      {
        mode: "day",
        key: last.date,
        label: bucketsFor(windowFor(results, "1D"))[0].label,
        dates: [last.date],
        netVolume: last.netVolume,
        noiseFloor: last.noiseFloor,
        polarity: last.polarity,
      },
    ]);
  });
});
