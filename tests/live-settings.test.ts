import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveSettings } from "../src/lib/liveSettings";

const WATCH = "AAPL,MSFT,NVDA,AMZN,AVGO,GOOGL,GOOG,TSLA,JPM,WMT";

describe("liveSettings", () => {
  it("needs the live-only watchlist and ignores the paper one", () => {
    assert.equal(liveSettings({}).ok, false);
    assert.equal(liveSettings({ POLARITO_PAPER_WATCHLIST: WATCH }).ok, false);
  });

  it("parses Henry's ten names and applies the decided defaults", () => {
    const r = liveSettings({ POLARITO_LIVE_WATCHLIST: WATCH });
    assert.ok(r.ok);
    assert.deepEqual(r.settings.watchlist, WATCH.split(","));
    assert.equal(r.settings.quantity, 1);
    assert.equal(r.settings.maxPositionPct, 33);
    assert.equal(r.settings.maxPositions, 3);
    assert.equal(r.settings.dailyLossPct, 1);
    assert.equal("maxEntries" in r.settings, false, "there is no daily entry cap");
    assert.equal(r.settings.pickStartMinutes, 600);
    assert.equal(r.settings.flattenAtMinutes, 15 * 60 + 55);
    assert.equal(r.settings.longOnlyFallback, "aside");
  });

  it("rejects an eleventh name and a bad ticker", () => {
    assert.equal(liveSettings({ POLARITO_LIVE_WATCHLIST: `${WATCH},META` }).ok, false);
    assert.equal(liveSettings({ POLARITO_LIVE_WATCHLIST: "AAPL,12$" }).ok, false);
  });

  it("a bad stop value falls back to 1% instead of loosening it", () => {
    for (const bad of ["abc", "0", "11", "-1", ""]) {
      const r = liveSettings({ POLARITO_LIVE_WATCHLIST: "WMT", POLARITO_LIVE_DAILY_LOSS_PCT: bad });
      assert.ok(r.ok);
      assert.equal(r.settings.dailyLossPct, 1, bad);
    }
    const r = liveSettings({ POLARITO_LIVE_WATCHLIST: "WMT", POLARITO_LIVE_DAILY_LOSS_PCT: "0.5" });
    assert.ok(r.ok && r.settings.dailyLossPct === 0.5);
  });

  it("validates the other knobs and allows holding overnight", () => {
    const base = { POLARITO_LIVE_WATCHLIST: "WMT" };
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_QTY: "0" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_MAX_POSITION_PCT: "150" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_MAX_POSITION_PCT: "50" }).ok, false, "the 33% limit can only be lowered");
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_MAX_ENTRIES: "1" }).ok, true, "the old cap variable is ignored");
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_PICK_START: "9:00" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_PICK_START: "ten" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_FLATTEN_AT: "17:00" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_LONG_ONLY_FALLBACK: "maybe" }).ok, false);
    const hold = liveSettings({ ...base, POLARITO_LIVE_FLATTEN_AT: "off", POLARITO_LIVE_LONG_ONLY_FALLBACK: "next" });
    assert.ok(hold.ok);
    assert.equal(hold.settings.flattenAtMinutes, null);
    assert.equal(hold.settings.longOnlyFallback, "next");
  });
});
