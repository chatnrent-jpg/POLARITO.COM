import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditLine, buildAuditRecord, parseAuditRecord } from "../src/lib/audit";

const NOW = new Date("2026-11-19T22:00:00Z");
const draft = (over: Record<string, unknown> = {}) => ({
  source: "paper-runner" as const,
  ticker: "nvda",
  signalDate: "2026-11-19",
  polarity: 1,
  ready: true,
  outcome: "entered" as const,
  reason: "Enter long on aligned gear.",
  ...over,
});

describe("buildAuditRecord", () => {
  it("normalizes and keeps only whitelisted fields", () => {
    const rec = buildAuditRecord(
      { ...draft({ side: "long", quantity: 10, price: 100.05 }), apiKey: "SECRET", headers: { a: 1 } } as never,
      NOW,
    );
    assert.equal(rec.ticker, "NVDA");
    assert.equal(rec.at, NOW.toISOString());
    assert.equal(rec.quantity, 10);
    assert.equal("apiKey" in rec, false);
    assert.equal("headers" in rec, false);
    assert.equal(auditLine(rec).includes("SECRET"), false);
  });

  it("caps text, notes and drops invalid numbers or dates", () => {
    const rec = buildAuditRecord(
      draft({
        reason: "x".repeat(5000),
        notes: Array.from({ length: 50 }, (_, i) => `n${i}`),
        signalDate: "yesterday",
        polarity: 7,
        quantity: Number.NaN,
        price: -1,
        side: "sideways",
      }),
      NOW,
    );
    assert.equal(rec.reason.length, 300);
    assert.equal(rec.notes.length, 10);
    assert.equal(rec.signalDate, null);
    assert.equal(rec.polarity, null);
    assert.equal("quantity" in rec, false);
    assert.equal("price" in rec, false);
    assert.equal("side" in rec, false);
  });

  it("refuses an unknown source or outcome", () => {
    assert.throws(() => buildAuditRecord(draft({ source: "nope" }), NOW), RangeError);
    assert.throws(() => buildAuditRecord(draft({ outcome: "winning" }), NOW), RangeError);
  });

  it("round-trips through parseAuditRecord and rejects garbage", () => {
    const rec = buildAuditRecord(draft({ side: "long", quantity: 3 }), NOW);
    assert.deepEqual(parseAuditRecord(JSON.parse(JSON.stringify(rec))), rec);
    assert.equal(parseAuditRecord(null), null);
    assert.equal(parseAuditRecord({ v: 2 }), null);
    assert.equal(parseAuditRecord({ ...rec, outcome: "winning" }), null);
    assert.equal(parseAuditRecord({ ...rec, at: "not a date" }), null);
  });
});
