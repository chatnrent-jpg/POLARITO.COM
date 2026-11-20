import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bucketsFor } from "../src/lib/chartBuckets";
import { HISTORY_LOOKBACK_CALENDAR_DAYS, resolveLookbackDays } from "../src/lib/marketApi";
import { computePolaritySeries, windowFor, type Bar } from "../src/lib/polarity";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("Daily and the default load path are unchanged", () => {
  it("default lookback stays 450 days for every existing caller; only an explicit request widens it", () => {
    assert.equal(resolveLookbackDays(), 450);
    assert.equal(resolveLookbackDays(undefined), 450);
    assert.equal(resolveLookbackDays(30), 450);
    assert.equal(resolveLookbackDays(1000), 1000);
    assert.equal(resolveLookbackDays(1_000_000), HISTORY_LOOKBACK_CALENDAR_DAYS);
  });

  it("only the chart-only history route asks for a longer lookback", () => {
    const users = walk(join(root, "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /lookbackDays|HISTORY_LOOKBACK_CALENDAR_DAYS/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1).replaceAll("\\", "/"))
      .sort();
    assert.deepEqual(users, ["src/app/api/bars/history/route.node.ts", "src/lib/marketApi.ts"]);
  });

  it("the page load / 5s refresh path never touches the history loader", () => {
    for (const f of ["src/components/PolarityDashboard.tsx", "src/components/PageRefresher.tsx", "src/lib/mirrorRunner.ts"]) {
      assert.doesNotMatch(read(f), /loadHistoryBars|bars\/history|HISTORY_LOOKBACK/, f);
    }
  });

  it("the chart fetches history only when 3M or 1Y is selected", () => {
    const src = read("src/components/PolarityChart.tsx");
    assert.match(src, /const needsHistory = barUnit === "quarter" \|\| barUnit === "year"/);
    assert.match(src, /if \(!needsHistory \|\| !ticker\) return;\s*\n\s*let cancelled/);
    assert.equal((src.match(/loadHistory\(/g) ?? []).length, 1);
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
