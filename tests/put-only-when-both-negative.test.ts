import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tradingDaysBetween } from "../src/lib/marketCalendar";
import { alignedPolarity, chartNetVolume, computeDailyNetVolume } from "../src/lib/longPolarity";
import type { Bar, CandleKind, Polarity } from "../src/lib/polarity";
import { buildDeskSnapshot, deskDecision, openManual, type DeskConfig } from "../src/lib/spyDesk";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { computeWwvReading, wwvPolarity } from "../src/lib/wwv";
import { makeDeps } from "./helpers/spyDeskFixtures";

/**
 * Henry's rule, locked: a PUT (Reverse) only when BOTH the deciding candle is down (close below open) AND the net volume is
 * negative; a CALL (Drive) only when BOTH are up/positive; anything else is Neutral (no new trade). No third signal.
 * Net volume has the chart's definition: +total when the close is above the previous period's close, -total when below.
 */
const PUT = "SPY271217P00820000";
const CALL = "SPY271105C00600000";
const NOW = new Date("2026-11-24T15:29:00Z"); // Tuesday, 10:29 ET: the session is in progress
const DAILY: DeskConfig = { timeframe: "1D", liveBudget: 1000 };
const WWV: DeskConfig = { timeframe: "D", liveBudget: 1000 };

/** A calm year (close = prevClose, volume 100) to Monday 2026-11-23, then today's partial bar as given. */
function history(prevClose: number, today: { open: number; close: number; volume: number }, date = "2026-11-24"): Bar[] {
  const daily: Bar[] = tradingDaysBetween("2025-11-03", "2026-11-23").map((d) => ({ date: d, open: prevClose, high: prevClose + 1, low: prevClose - 1, close: prevClose, volume: 100 }));
  daily.push({ date, open: today.open, close: today.close, volume: today.volume, high: Math.max(today.open, today.close) + 0.1, low: Math.min(today.open, today.close) - 0.1 });
  return daily;
}

describe("the alignment rules (pure): put only when both are negative, call only when both are positive", () => {
  const KINDS: CandleKind[] = ["red", "green", "flat"];
  const NETS: Array<[string, number]> = [["negative", -15_687_345], ["tiny negative", -1], ["zero", 0], ["tiny positive", 1], ["positive", 15_687_345]];
  for (const kind of KINDS) {
    for (const [label, net] of NETS) {
      const want: Polarity = kind === "red" && net < 0 ? -1 : kind === "green" && net > 0 ? 1 : 0;
      it(`net volume: ${kind} candle x ${label} net volume = ${want === -1 ? "Reverse (put)" : want === 1 ? "Drive (call)" : "Neutral"}`, () => {
        assert.equal(alignedPolarity(kind, net), want);
      });
    }
  }
  for (const kind of KINDS) {
    for (const dir of ["up", "down"] as const) {
      const want: Polarity = kind === "red" && dir === "down" ? -1 : kind === "green" && dir === "up" ? 1 : 0;
      it(`WWV: ${kind} candle x ${dir} wave = ${want === -1 ? "Reverse (put)" : want === 1 ? "Drive (call)" : "Neutral"}`, () => {
        assert.equal(wwvPolarity(kind, dir), want);
      });
    }
  }
  it("a missing or non-finite net volume is Neutral and never gets a sign", () => {
    assert.deepEqual(chartNetVolume(Number.NaN, 714.26, 1000), { net: null, flag: "missing" });
    assert.deepEqual(chartNetVolume(716, 714.26, Number.POSITIVE_INFINITY), { net: null, flag: "missing" });
  });
});

describe("Daily net volume (/spy): the live case Henry sent, and the cases next to it", () => {
  it("open 715.15, close 714.26 (a down candle) with net volume -15,687,345 (close below the previous close): Reverse, a put, in progress", () => {
    const r = computeDailyNetVolume({ daily: history(716.4, { open: 715.15, close: 714.26, volume: 15_687_345 }), now: NOW });
    assert.equal(r.status, "ok");
    assert.equal(r.kind, "red");
    assert.ok(r.open !== null && r.close !== null && r.close < r.open, "the candle is down: 714.26 is below 715.15");
    assert.equal(r.netVolume, -15_687_345);
    assert.equal(r.polarity, -1);
    assert.equal(r.label, "Reverse");
    assert.equal(r.agreement, "agree");
    assert.equal(r.inProgress, true, "an in-progress bar is used and labelled, it does not change the rule");
    const d = deskDecision(history(716.4, { open: 715.15, close: 714.26, volume: 15_687_345 }), NOW, "1D");
    assert.ok(d.status === "ok" && d.action === "PUT");
  });
  const cases: Array<[string, number, { open: number; close: number; volume: number }, "PUT" | "CALL" | "STAND_ASIDE"]> = [
    ["down candle, close below the previous close (net negative)", 716.4, { open: 715.15, close: 714.26, volume: 5_000_000 }, "PUT"],
    ["up candle, close above the previous close (net positive)", 710, { open: 712, close: 714.26, volume: 5_000_000 }, "CALL"],
    ["down candle but the close is ABOVE the previous close (net positive): mismatch", 710, { open: 715.15, close: 714.26, volume: 5_000_000 }, "STAND_ASIDE"],
    ["up candle but the close is BELOW the previous close (net negative): mismatch", 716.4, { open: 713, close: 714.26, volume: 5_000_000 }, "STAND_ASIDE"],
    ["flat candle with a negative net volume", 716.4, { open: 714.26, close: 714.26, volume: 5_000_000 }, "STAND_ASIDE"],
    ["down candle but the close equals the previous close (net volume exactly zero)", 714.26, { open: 715.15, close: 714.26, volume: 5_000_000 }, "STAND_ASIDE"],
  ];
  for (const [name, prev, today, action] of cases) {
    it(`${name} = ${action}`, () => {
      const d = deskDecision(history(prev, today), NOW, "1D");
      assert.ok(d.status === "ok");
      assert.equal(d.action, action);
      const r = computeDailyNetVolume({ daily: history(prev, today), now: NOW });
      const bothNegative = r.kind === "red" && (r.netVolume ?? 0) < 0;
      const bothPositive = r.kind === "green" && (r.netVolume ?? 0) > 0;
      assert.equal(d.action === "PUT", bothNegative, "PUT exactly when the candle is down AND the net volume is negative");
      assert.equal(d.action === "CALL", bothPositive, "CALL exactly when the candle is up AND the net volume is positive");
    });
  }
  it("a grid of closes around the open and the previous close: PUT only in the both-negative cell, CALL only in the both-positive cell", () => {
    const prev = 716;
    for (const open of [713, 715.15, 717]) {
      for (const close of [712, 714.26, 715.15, 716, 716.5, 718, 720]) {
        const d = deskDecision(history(prev, { open, close, volume: 1_000_000 }), NOW, "1D");
        assert.ok(d.status === "ok");
        const candleDown = close < open;
        const candleUp = close > open;
        const netNegative = close < prev;
        const netPositive = close > prev;
        assert.equal(d.action === "PUT", candleDown && netNegative, `open ${open} close ${close}`);
        assert.equal(d.action === "CALL", candleUp && netPositive, `open ${open} close ${close}`);
        assert.equal(d.action === "STAND_ASIDE", !(candleDown && netNegative) && !(candleUp && netPositive), `open ${open} close ${close}`);
      }
    }
  });
});

describe("WWV (/spy-wwv): a put only when the candle is down AND the wave is down; a call only when both are up", () => {
  it("red candle in a down wave: Reverse (put); the wave is down because the close is below the previous close", () => {
    const daily = history(716.4, { open: 715.15, close: 714.26, volume: 15_687_345 });
    const r = computeWwvReading({ daily, now: NOW });
    assert.equal(r.status, "ok");
    assert.equal(r.kind, "red");
    assert.equal(r.netSign, -1);
    assert.equal(r.polarity, -1);
    assert.equal(r.inProgress, true);
    const d = deskDecision(daily, NOW, "D");
    assert.ok(d.status === "ok" && d.action === "PUT");
  });
  it("grid: PUT only for red + down wave, CALL only for green + up wave, everything else Neutral", () => {
    const prev = 716;
    for (const open of [713, 715.15, 717]) {
      for (const close of [712, 714.26, 715.15, 716.5, 718, 720]) {
        const d = deskDecision(history(prev, { open, close, volume: 1_000_000 }), NOW, "D");
        assert.ok(d.status === "ok");
        const waveDown = close < prev;
        const waveUp = close > prev;
        assert.equal(d.action === "PUT", close < open && waveDown, `open ${open} close ${close}`);
        assert.equal(d.action === "CALL", close > open && waveUp, `open ${open} close ${close}`);
      }
    }
  });
  it("red candle but the close is above the previous close (an up wave): Neutral, not a put", () => {
    const d = deskDecision(history(710, { open: 715.15, close: 714.26, volume: 5_000_000 }), NOW, "D");
    assert.ok(d.status === "ok" && d.action === "STAND_ASIDE");
  });
});

describe("a mismatch never reaches a put: no new buy of either side while Neutral, on both desks", () => {
  for (const [name, cfg] of [["/spy (Daily)", DAILY], ["/spy-wwv", WWV]] as const) {
    it(`${name}: down candle with the close above the previous close: the snapshot is Neutral and the ticket refuses a put and a call`, async () => {
      const scenario = { daily: history(710, { open: 715.15, close: 714.26, volume: 5_000_000 }) };
      const deps = () => makeDeps(scenario, { now: NOW });
      const snap = await buildDeskSnapshot(deps(), cfg, createMemoryDeskStore());
      assert.equal(snap.decision.action, "STAND_ASIDE");
      assert.equal(snap.enginePick.status, "not-applicable");
      for (const [type, symbol] of [["put", PUT], ["call", CALL]] as const) {
        const store = createMemoryDeskStore();
        const res = await openManual(deps(), cfg, store, { type, symbol });
        assert.ok(!res.ok && res.code === "NEUTRAL_NO_TRADE", `${type}`);
        const saved = await store.read();
        assert.ok(saved.ok && saved.state.position === null);
      }
    });
    it(`${name}: both negative: the snapshot is PUT and a call is refused as counter-polarity`, async () => {
      const scenario = { daily: history(716.4, { open: 715.15, close: 714.26, volume: 15_687_345 }) };
      const snap = await buildDeskSnapshot(makeDeps(scenario, { now: NOW }), cfg, createMemoryDeskStore());
      assert.equal(snap.decision.action, "PUT");
      const res = await openManual(makeDeps(scenario, { now: NOW }), cfg, createMemoryDeskStore(), { type: "call", symbol: CALL });
      assert.ok(!res.ok && res.code === "COUNTER_POLARITY");
    });
  }
});
