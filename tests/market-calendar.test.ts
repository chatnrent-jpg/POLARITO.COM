import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectedLatestSession, isTradingDay, nyseHolidays, previousTradingDay, tradingDaysBetween } from "../src/lib/marketCalendar";

const sorted = (y: number) => [...nyseHolidays(y)].sort();

describe("NYSE full-day closures", () => {
  it("2026", () => {
    assert.deepEqual(sorted(2026), ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]);
  });
  it("2027 weekend observance (Juneteenth and Christmas on Saturday, July 4 on Sunday)", () => {
    assert.deepEqual(sorted(2027), ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"]);
  });
  it("New Year's Day on a Saturday is not moved to Friday", () => {
    assert.ok(!nyseHolidays(2022).has("2021-12-31"));
    assert.ok(isTradingDay("2021-12-31"));
    assert.ok(!isTradingDay("2022-01-01"));
  });
  it("weekends and holidays are not trading days, ordinary days are", () => {
    assert.equal(isTradingDay("2026-11-21"), false);
    assert.equal(isTradingDay("2026-11-26"), false);
    assert.equal(isTradingDay("2026-11-27"), true);
    assert.equal(previousTradingDay("2026-11-27"), "2026-11-25");
    assert.equal(tradingDaysBetween("2026-11-23", "2026-11-27").length, 4);
  });
});

describe("which daily bar must be the newest right now", () => {
  const at = (iso: string) => new Date(iso);
  it("Friday after 9:50 ET needs Friday's bar", () => {
    assert.equal(expectedLatestSession(at("2026-11-20T15:00:00Z")), "2026-11-20"); // 10:00 ET
    assert.equal(expectedLatestSession(at("2026-11-20T22:00:00Z")), "2026-11-20"); // after the close
  });
  it("Friday before 9:50 ET still needs Thursday's bar", () => {
    assert.equal(expectedLatestSession(at("2026-11-20T14:40:00Z")), "2026-11-19"); // 9:40 ET
  });
  it("weekend and Monday morning need Friday's bar", () => {
    assert.equal(expectedLatestSession(at("2026-11-21T17:00:00Z")), "2026-11-20");
    assert.equal(expectedLatestSession(at("2026-11-23T13:00:00Z")), "2026-11-20"); // 8:00 ET
  });
  it("Thanksgiving and the day after", () => {
    assert.equal(expectedLatestSession(at("2026-11-26T17:00:00Z")), "2026-11-25");
    assert.equal(expectedLatestSession(at("2026-11-27T15:00:00Z")), "2026-11-27");
  });
});
