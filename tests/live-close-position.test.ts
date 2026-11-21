import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AUDIT_SOURCES } from "../src/lib/audit";
import { closeLivePosition } from "../src/lib/liveClose";
import { runPickTick } from "../src/lib/pickRunner";
import { LIVE_ON, pickSetup, type BarSpec } from "./helpers/liveFake";

const SPECS = (): Record<string, BarSpec> => ({ NVDA: { kind: "drive", mult: 12, price: 130 }, WMT: { kind: "drive", mult: 8, price: 100 } });
const held = (t: ReturnType<typeof pickSetup>, quantity: number) => {
  t.broker.positions.push({ ticker: "NVDA", side: "long", quantity, avgEntryPrice: 130 });
  t.broker.orders.push({ id: "e1", clientOrderId: "pol-20261119-e01-NVDA", status: "filled", ticker: "NVDA", side: "buy", quantity });
};
const deps = (t: ReturnType<typeof pickSetup>) => ({ broker: t.broker, config: t.deps.config, audit: t.deps.audit, now: t.deps.now, sleep: t.deps.sleep });

describe("manual Close position (server)", () => {
  it("sells the broker's whole held quantity as c01-a1 and audits it as live-manual-close", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false });
    held(t, 7);
    const r = await closeLivePosition(deps(t), "NVDA");
    assert.ok(r.ok && r.status === "submitted" && r.flat === true);
    assert.deepEqual(t.broker.submitted.map((o) => [o.side, o.quantity, o.clientOrderId]), [["sell", 7, "pol-20261119-c01-a1-NVDA"]]);
    assert.ok(t.audit.length > 0 && t.audit.every((a) => a.source === "live-manual-close"));
    assert.ok((AUDIT_SOURCES as readonly string[]).includes("live-manual-close"));
  });

  it("a second click is a no-op (same deterministic id), nothing is cancelled", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false });
    held(t, 2);
    t.broker.fill = false;
    await closeLivePosition(deps(t), "NVDA");
    const again = await closeLivePosition(deps(t), "NVDA");
    assert.ok(again.ok && again.status === "noop");
    assert.equal(t.broker.submitted.length, 1);
  });

  it("sends nothing when live trading is not enabled, and says so", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false, config: { enabled: false, killed: false, configured: true } });
    held(t, 1);
    const r = await closeLivePosition(deps(t), "NVDA");
    assert.ok(r.ok && r.status === "observed" && r.flat === null);
    assert.equal(t.broker.submitted.length, 0);
  });

  it("the kill switch refuses and sends nothing", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false, config: { ...LIVE_ON, killed: true } });
    held(t, 1);
    const r = await closeLivePosition(deps(t), "NVDA");
    assert.equal(r.ok, false);
    assert.equal(t.broker.submitted.length, 0);
  });

  it("fails closed when positions cannot be read", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false });
    held(t, 1);
    t.broker.getPositions = async () => ({ ok: false, code: "HTTP", error: "down" });
    const r = await closeLivePosition(deps(t), "NVDA");
    assert.ok(!r.ok && r.code === "BROKER");
    assert.equal(t.broker.submitted.length, 0);
  });

  it("with no position there is nothing to send", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false });
    const r = await closeLivePosition(deps(t), "NVDA");
    assert.ok(r.ok && r.status === "none");
    assert.equal(t.broker.submitted.length, 0);
  });
});

describe("Auto interaction after a manual close", () => {
  it("with Auto ON the existing re-entry rule applies: it may re-enter on the next tick, as the next entry number", async () => {
    const t = pickSetup({ specs: SPECS(), auto: true });
    await runPickTick(t.deps, t.settings, { dryRun: false });
    await closeLivePosition(deps(t), "NVDA");
    await runPickTick(t.deps, t.settings, { dryRun: false });
    assert.deepEqual(t.broker.submitted.map((o) => o.clientOrderId), ["pol-20261119-e01-NVDA", "pol-20261119-c01-a1-NVDA", "pol-20261119-e02-NVDA"]);
  });

  it("with Auto OFF (for example after Close + Auto OFF) nothing re-enters", async () => {
    const t = pickSetup({ specs: SPECS(), auto: true });
    await runPickTick(t.deps, t.settings, { dryRun: false });
    await closeLivePosition(deps(t), "NVDA");
    t.autoState.on = false;
    await runPickTick(t.deps, t.settings, { dryRun: false });
    assert.equal(t.broker.submitted.length, 2);
  });
});

describe("Close position control (source assertions)", () => {
  const panel = readFileSync(new URL("../src/components/LiveAccountPanel.tsx", import.meta.url), "utf8");

  it("is shown disabled with a reason when there is no position, not hidden", () => {
    assert.match(panel, /positions\.length === 0 \? \(/);
    assert.match(panel, /No open position to close\./);
    assert.match(panel, /Close position\s*<\/button>/);
    assert.match(panel, /disabled\s*\n\s*aria-label="Close position \(disabled: no open position to close\)"/);
  });

  it("per position: disabled with the reason when live orders are off, confirm step before sending", () => {
    assert.match(panel, /disabled=\{busy \|\| !mode\.ordersAllowed\}/);
    assert.match(panel, /Close is disabled: live orders are off/);
    assert.match(panel, /REAL ORDER: this sends a market/);
    assert.match(panel, /Confirm close/);
    assert.match(panel, /\/api\/broker\/live\/close/);
  });

  it("with Auto ON the confirm offers Auto OFF after the flat close, through the guarded Auto route only", () => {
    assert.match(panel, /Then turn Live Auto OFF once the position is flat/);
    assert.match(panel, /if \(thenAutoOff\) \{\s*const off = await requestAuto\(false\)/);
    assert.match(panel, /\/api\/broker\/live\/auto/);
  });
});
