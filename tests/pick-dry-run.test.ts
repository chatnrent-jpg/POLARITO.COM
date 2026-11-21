import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPickTick } from "../src/lib/pickRunner";
import { pickSetup, type BarSpec } from "./helpers/liveFake";

const SPECS = (): Record<string, BarSpec> => ({
  NVDA: { kind: "drive", mult: 12, price: 130 },
  AAPL: { kind: "drive", mult: 8, price: 100 },
  WMT: { kind: "drive", mult: 10, price: 90 },
});
const notesOf = (r: Awaited<ReturnType<typeof runPickTick>>) => r.results.flatMap((x) => x.notes ?? []);

describe("dry-run results carry the ranked list and per-stock skip reasons", () => {
  it("a dry tick returns the Ranked line and why a stock was skipped", async () => {
    const t = pickSetup({ specs: SPECS() });
    t.broker.assets.set("NVDA", { symbol: "NVDA", status: "active", tradable: false, shortable: false, borrowStatus: null });
    const r = await runPickTick(t.deps, t.settings, { dryRun: true });
    assert.ok(r.ok);
    assert.equal(t.broker.submitted.length, 0, "a dry run sends nothing");
    const notes = notesOf(r);
    assert.ok(notes.some((n) => /^Ranked: /.test(n) && n.includes("WMT")), notes.join(" | "));
    assert.ok(notes.some((n) => /NVDA: .*not tradable/i.test(n)), notes.join(" | "));
    const pick = r.results.find((x) => /Would enter long \d+ WMT/.test(x.reason));
    assert.ok(pick && (pick.notes ?? []).length > 0);
  });

  it("a tick that is only observing (live trading not enabled) also carries them, and still sends nothing", async () => {
    const t = pickSetup({ specs: SPECS(), config: { enabled: false, killed: false, configured: true } });
    const r = await runPickTick(t.deps, t.settings, { dryRun: false });
    assert.ok(r.ok && r.dryRun);
    assert.equal(t.broker.submitted.length, 0);
    assert.ok(notesOf(r).some((n) => /^Ranked: /.test(n)));
  });

  it("a real tick keeps the notes in the audit log only", async () => {
    const t = pickSetup({ specs: SPECS() });
    const r = await runPickTick(t.deps, t.settings, { dryRun: false });
    assert.ok(r.ok && !r.dryRun);
    assert.ok(r.results.every((x) => x.notes === undefined));
    assert.ok(t.audit.some((a) => a.notes.some((n) => /^Ranked: /.test(n))));
  });

  it("notes are bounded and hold no credentials", async () => {
    const t = pickSetup({ specs: SPECS() });
    const r = await runPickTick(t.deps, t.settings, { dryRun: true });
    const notes = notesOf(r);
    assert.ok(notes.length <= 25 && notes.every((n) => n.length <= 220));
    assert.ok(!JSON.stringify(r).match(/secret|key|token|authorization/i));
  });

  it("a freshly funded account (last_equity 0) fails closed with the expected message, dry or not", async () => {
    const t = pickSetup({ specs: SPECS(), account: { equity: 1000, lastEquity: 0 } });
    const r = await runPickTick(t.deps, t.settings, { dryRun: true });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /Broker equity is not usable\. No trading\./.test(r.error));
    assert.equal(t.broker.submitted.length, 0);
  });
});
