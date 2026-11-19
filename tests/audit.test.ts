import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { auditLine, buildAuditRecord, parseAuditRecord } from "../src/lib/audit";
import {
  clearAudit,
  getAuditSnapshot,
  getServerAuditSnapshot,
  isRepeat,
  MAX_AUDIT_RECORDS,
  recordDrafts,
} from "../src/lib/auditStore";

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

type FakeWindow = {
  localStorage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void };
  addEventListener: () => void;
  removeEventListener: () => void;
};
const g = globalThis as unknown as { window?: FakeWindow };

describe("auditStore", () => {
  let store: Map<string, string>;
  let failWrites = false;
  beforeEach(() => {
    store = new Map();
    failWrites = false;
    g.window = {
      localStorage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => {
          if (failWrites) throw new Error("quota");
          store.set(k, v);
        },
        removeItem: (k) => void store.delete(k),
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    clearAudit();
  });

  it("snapshots are referentially stable while storage is unchanged", () => {
    assert.equal(getAuditSnapshot(), getAuditSnapshot());
    assert.equal(getServerAuditSnapshot(), getServerAuditSnapshot());
    recordDrafts([draft()], NOW);
    const a = getAuditSnapshot();
    assert.equal(a.length, 1);
    assert.equal(getAuditSnapshot(), a);
  });

  it("does not log the same decision again on every refresh", () => {
    recordDrafts([draft()], NOW);
    recordDrafts([draft()], new Date(NOW.getTime() + 5000));
    assert.equal(getAuditSnapshot().length, 1);
    recordDrafts([draft({ outcome: "closed", reason: "Neutral: closing to stand aside." })], NOW);
    recordDrafts([draft({ outcome: "closed", reason: "Neutral: closing to stand aside." })], NOW);
    assert.equal(getAuditSnapshot().length, 2);
  });

  it("repeat detection is per ticker and source", () => {
    const a = buildAuditRecord(draft(), NOW);
    const b = buildAuditRecord(draft({ ticker: "TSLA", outcome: "held" }), NOW);
    assert.equal(isRepeat([a, b], a), true);
    assert.equal(isRepeat([a, b], buildAuditRecord(draft({ outcome: "held" }), NOW)), false);
  });

  it("keeps only the newest MAX_AUDIT_RECORDS", () => {
    for (let i = 0; i < MAX_AUDIT_RECORDS + 20; i++) {
      recordDrafts([draft({ reason: `r${i}` })], NOW);
    }
    const all = getAuditSnapshot();
    assert.equal(all.length, MAX_AUDIT_RECORDS);
    assert.equal(all[all.length - 1].reason, `r${MAX_AUDIT_RECORDS + 19}`);
  });

  it("reports a failed write instead of pretending it was saved", () => {
    failWrites = true;
    const r = recordDrafts([draft()], NOW);
    assert.equal(r.ok, false);
    assert.equal(getAuditSnapshot().length, 0);
  });

  it("ignores corrupt storage", () => {
    store.set("polarito.audit.v1", "{not json");
    assert.equal(getAuditSnapshot().length, 0);
    store.set("polarito.audit.v1", JSON.stringify([{ junk: 1 }, "x"]));
    assert.equal(getAuditSnapshot().length, 0);
  });
});
