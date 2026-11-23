import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { NO_ANALYSIS } from "../src/lib/spyAnalyzer";
import { AUTO_SWITCH_KEY, buildAutoView } from "../src/lib/spyAuto";
import { buildDeskSnapshot, type DeskConfig, type DeskPosition, type DeskSnapshot, type DeskState } from "../src/lib/spyDesk";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { createMemorySpyKv } from "../src/lib/spyKv";
import { MONTHLY_PROFILE, WWV_PROFILE } from "../src/lib/spyProfile";
import { DRIVE, NEUTRAL, makeDeps, row, type Scenario } from "./helpers/spyDeskFixtures";
import { WWV_DRIVE, WWV_NEUTRAL } from "./helpers/wwvFixtures";

const noop = () => undefined;
const DAILY: DeskConfig = { timeframe: "1D", liveBudget: 1000 };
const WWV: DeskConfig = { timeframe: "D", liveBudget: 1000 };
const props = (snapshot: DeskSnapshot, over: Partial<DeskViewProps> = {}): DeskViewProps => ({ load: { status: "ready", snapshot }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-03T21:30:05.000Z", chainAt: "2026-11-03T21:30:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z0-9]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const at = (out: string, needle: string): number => out.indexOf(needle);

const heldState = (): DeskState => {
  const r = row("put", "2027-11-05", 850);
  const position: DeskPosition = { type: "put", symbol: r.symbol, expiration: "2027-11-05", strike: 850, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta, deltaTier: "fallback", fallbackReason: "chosen by hand", decisionTimeframe: "M", maxLossUsd: r.ask * 100, source: "manual" };
  return { version: 1, position, journal: [] };
};
async function snap(sc: Scenario, cfg: DeskConfig, o: { on?: boolean; kv?: boolean; state?: DeskState } = {}): Promise<DeskSnapshot> {
  const kv = createMemorySpyKv();
  if (o.on) kv.data.set(AUTO_SWITCH_KEY, { value: JSON.stringify({ auto: true, at: "2026-11-01T00:00:00.000Z" }), expiresAt: null });
  const auto = await buildAutoView(o.kv === false ? null : kv);
  return buildDeskSnapshot(makeDeps(sc), cfg, createMemoryDeskStore(o.state), auto);
}
const DESKS = [
  { name: "/spy", sc: DRIVE, neutral: NEUTRAL, cfg: DAILY, profile: MONTHLY_PROFILE },
  { name: "/spy-wwv", sc: WWV_DRIVE, neutral: WWV_NEUTRAL, cfg: WWV, profile: WWV_PROFILE },
] as const;

describe("the Auto card sits above the decision card, on both desks", () => {
  for (const d of DESKS) {
    it(`${d.name}: order is Auto, then decision, readings, pocket (no position)`, async () => {
      for (const sc of [d.sc, d.neutral]) {
        const out = html(props(await snap(sc, d.cfg, { kv: true }), { profile: d.profile }));
        const order = ['data-testid="desk-body"', 'id="auto-h"', 'data-testid="decision-card"', 'id="readings-h"', 'data-testid="desk-pocket"'].map((n) => at(out, n));
        assert.ok(order.every((v) => v > 0), JSON.stringify(order));
        assert.deepEqual([...order].sort((a, b) => a - b), order, "Auto, decision, readings, pocket in that order");
        assert.equal(out.match(/id="auto-h"/g)?.length, 1);
        assert.equal(out.match(/data-testid="auto-card"/g)?.length, 1);
      }
    });
    it(`${d.name}: with a position held the order is position card, Auto, decision, readings, pocket (position card and Close stay on top)`, async () => {
      const out = html(props(await snap(d.sc, d.cfg, { kv: true, state: heldState() }), { profile: d.profile }));
      const order = ['data-testid="position-held"', 'id="auto-h"', 'data-testid="decision-card"', 'id="readings-h"', 'data-testid="desk-pocket"'].map((n) => at(out, n));
      assert.ok(order.every((v) => v > 0), JSON.stringify(order));
      assert.deepEqual([...order].sort((a, b) => a - b), order);
      assert.ok(at(out, "Close (dry run)") > order[0] && at(out, "Close (dry run)") < order[1], "Close stays in the position card");
    });
    it(`${d.name}: the audit log stays in the pocket and is not duplicated on the Auto card`, async () => {
      const out = html(props(await snap(d.sc, d.cfg, { kv: true }), { profile: d.profile }));
      const card = out.slice(at(out, 'data-testid="auto-card"'), at(out, 'data-testid="decision-card"'));
      assert.doesNotMatch(card, /Auto audit log|auto-log/);
      const pocket = out.slice(at(out, 'data-testid="desk-pocket"'));
      assert.match(pocket, /Auto audit log \(every decision, newest first\)/);
      assert.equal(text(out).split("Auto audit log (every decision, newest first)").length - 1, 1);
    });
    it(`${d.name}: the Auto card is a whole: heading, state, explanation and controls are all above the decision card`, async () => {
      const out = html(props(await snap(d.sc, d.cfg, { kv: true }), { profile: d.profile }));
      const card = out.slice(at(out, 'id="auto-h"'), at(out, 'data-testid="decision-card"'));
      assert.match(text(card), /Auto \(practice trader\)/);
      assert.match(text(card), /When ON, a scheduled run \(/);
      assert.match(text(card), /Practice record only; no order is ever sent\./);
      assert.match(card, /data-testid="auto-ack"/);
      assert.match(card, /data-testid="auto-on"/);
    });
  }
});

describe("the Auto switch is a clear, labelled control", () => {
  for (const d of DESKS) {
    describe(d.name, () => {
      it("OFF: 'Auto is OFF' in plain words, the OFF side filled quietly, both ON and OFF readable, grouped and labelled", async () => {
        const out = html(props(await snap(d.sc, d.cfg, { kv: true }), { profile: d.profile }));
        assert.match(tag(out, "auto-card"), /data-auto="off"/);
        const group = tag(out, "auto-switch");
        assert.match(group, /role="group"/);
        const labelledby = group.match(/aria-labelledby="([^"]+)"/)?.[1] ?? "";
        const labelEl = out.match(new RegExp(`<[a-z]+[^>]*id="${labelledby}"[^>]*>([^<]*)<`));
        assert.equal(labelEl?.[1], "Auto is OFF", "the group is labelled by the state in plain words");
        assert.match(tag(out, "auto-state"), /role="status"/);
        assert.match(group, /border-zinc-700/);
        assert.doesNotMatch(group, /emerald/);
        const graphic = out.match(/<span[^>]*data-testid="auto-switch-graphic"[\s\S]*?<\/span><\/span>/)?.[0] ?? "";
        assert.match(graphic, /role="img"[^>]*aria-label="Auto switch: OFF"|aria-label="Auto switch: OFF"[^>]*role="img"/);
        assert.match(text(graphic), /OFF\s+ON/);
        assert.match(graphic, /bg-zinc-600[^"]*">OFF</);
        assert.doesNotMatch(graphic, /bg-emerald-500/);
        assert.match(text(out), /AUTO OFF/);
      });
      it("ON: 'Auto is ON', strong green frame and ON side, and the Turn Auto OFF button", async () => {
        const out = html(props(await snap(d.sc, d.cfg, { kv: true, on: true }), { profile: d.profile }));
        assert.match(tag(out, "auto-card"), /data-auto="on"/);
        const group = tag(out, "auto-switch");
        assert.match(group, /border-emerald-400/);
        assert.equal(out.match(new RegExp(`id="${group.match(/aria-labelledby="([^"]+)"/)?.[1]}"[^>]*>([^<]*)<`))?.[1], "Auto is ON");
        assert.match(tag(out, "auto-state"), /text-emerald-300/);
        const graphic = out.match(/<span[^>]*data-testid="auto-switch-graphic"[\s\S]*?<\/span><\/span>/)?.[0] ?? "";
        assert.match(graphic, /aria-label="Auto switch: ON"/);
        assert.match(graphic, /bg-emerald-500[^"]*">ON</);
        assert.match(text(out), /AUTO ON/);
        assert.match(out, /data-testid="auto-off"/);
        assert.doesNotMatch(out, /data-testid="auto-on"/);
      });
      it("large tap targets and native, keyboard-reachable controls: real buttons and a labelled checkbox (no tabindex tricks, no div-buttons)", async () => {
        const off = html(props(await snap(d.sc, d.cfg, { kv: true }), { profile: d.profile }));
        for (const [out, id] of [[off, "auto-on"], [html(props(await snap(d.sc, d.cfg, { kv: true, on: true }), { profile: d.profile })), "auto-off"]] as const) {
          const b = tag(out, id);
          assert.match(b, /^<button type="button"/);
          assert.match(b, /min-h-12/);
          assert.match(b, /w-full/);
          assert.match(b, /focus-visible:outline/);
          assert.doesNotMatch(b, /tabindex/i);
        }
        assert.match(off, /<label[^>]*min-h-11[^>]*><input type="checkbox"[^>]*data-testid="auto-ack"[^>]*\/?><span>I understand Auto only records practice trades by itself\. No order is sent to any broker\.<\/span><\/label>/);
        assert.match(tag(off, "auto-ack"), /h-5 w-5/);
        assert.match(tag(off, "auto-on"), /bg-emerald-500/);
      });
      it("the confirm step is unchanged: Turn Auto ON stays disabled until the acknowledgement is ticked (and while busy); Turn Auto OFF is one button; no bypass", async () => {
        const s = await snap(d.sc, d.cfg, { kv: true });
        const disabled = (t: string) => /\sdisabled(=""|\s|>)/.test(t);
        assert.ok(disabled(tag(html(props(s, { profile: d.profile })), "auto-on")));
        assert.ok(!disabled(tag(html(props(s, { profile: d.profile, autoUi: { ack: true } })), "auto-on")));
        assert.ok(disabled(tag(html(props(s, { profile: d.profile, autoUi: { ack: true }, busy: true })), "auto-on")));
        const on = await snap(d.sc, d.cfg, { kv: true, on: true });
        assert.ok(!disabled(tag(html(props(on, { profile: d.profile })), "auto-off")));
        assert.ok(disabled(tag(html(props(on, { profile: d.profile, busy: true })), "auto-off")));
        const offCard = html(props(s, { profile: d.profile }));
        const card = offCard.slice(at(offCard, 'data-testid="auto-card"'), at(offCard, 'data-testid="decision-card"'));
        assert.equal(card.match(/<button/g)?.length, 1, "the only button on the Auto card (OFF) is Turn Auto ON");
        assert.equal(card.match(/<input/g)?.length, 1, "and the only input is the acknowledgement");
        const view = fs.readFileSync("src/components/spy/SpyDeskView.tsx", "utf8");
        assert.equal(view.split("props.onSubmitAuto(true)").length - 1, 1, "one way to switch ON");
        assert.match(view, /disabled=\{props\.busy \|\| !props\.autoUi\.ack\} onClick=\{\(\) => props\.onSubmitAuto\(true\)\}/, "guarded by the acknowledgement");
      });
      it("no store: the state is stated and the switch cannot be used, with the reason", async () => {
        const out = html(props(await snap(d.sc, d.cfg, { kv: false }), { profile: d.profile }));
        assert.match(tag(out, "auto-card"), /data-auto="off"/);
        assert.match(text(out), /Auto is OFF/);
        assert.match(out, /data-testid="auto-unavailable"/);
        assert.doesNotMatch(out, /data-testid="auto-on"|data-testid="auto-off"|data-testid="auto-ack"/);
      });
    });
  }
  it("the switch and confirm state still live in the container (no refresh touches them)", () => {
    const container = fs.readFileSync("src/components/spy/SpyDesk.tsx", "utf8");
    assert.match(container, /const \[autoUi, setAutoUi\] = useState<AutoUi>\(IDLE_AUTO\);/);
    assert.match(container, /onAutoChange=\{\(next\) => setAutoUi\(\(u\) => \(\{ \.\.\.u, \.\.\.next \}\)\)\}/);
    assert.match(container, /onSubmitAuto=\{\(on\) => void submitAuto\(on\)\}/);
  });
});
