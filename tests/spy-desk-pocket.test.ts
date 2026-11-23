import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { NO_ANALYSIS } from "../src/lib/spyAnalyzer";
import type { AutoLogEntry } from "../src/lib/spyAutoTypes";
import { buildDeskSnapshot, type DeskConfig, type DeskPosition, type DeskSnapshot, type DeskState } from "../src/lib/spyDesk";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { MONTHLY_PROFILE, WWV_PROFILE } from "../src/lib/spyProfile";
import { DRIVE, makeDeps, row, type Scenario } from "./helpers/spyDeskFixtures";
import { WWV_DRIVE } from "./helpers/wwvFixtures";

const noop = () => undefined;
const DAILY: DeskConfig = { timeframe: "1D", liveBudget: 1000 };
const WWV: DeskConfig = { timeframe: "D", liveBudget: 1000 };
const props = (snapshot: DeskSnapshot, over: Partial<DeskViewProps> = {}): DeskViewProps => ({ load: { status: "ready", snapshot }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-03T21:30:05.000Z", chainAt: "2026-11-03T21:30:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z0-9]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

const heldState = (): DeskState => {
  const r = row("put", "2027-11-05", 850);
  const position: DeskPosition = { type: "put", symbol: r.symbol, expiration: "2027-11-05", strike: 850, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta, deltaTier: "fallback", fallbackReason: "chosen by hand", decisionTimeframe: "M", maxLossUsd: r.ask * 100, source: "manual" };
  return { version: 1, position, journal: [] };
};
const logEntry = (i: number): AutoLogEntry => ({ id: `log-${i}`, at: "2026-11-03T21:30:00.000Z", session: "2026-11-03", outcome: "no-action", message: `entry ${i}`, reading: "Drive", symbol: null, bid: null, ask: null, pnlUsd: null });

async function snap(sc: Scenario, cfg: DeskConfig, state?: DeskState): Promise<DeskSnapshot> {
  return buildDeskSnapshot(makeDeps(sc), cfg, createMemoryDeskStore(state));
}
/** The pocket's markup: from its <details> tag to the last </details> (the pocket is the outermost, last details on the page). */
const pocketOf = (out: string): string => {
  const start = out.lastIndexOf("<details", out.indexOf('data-testid="desk-pocket"'));
  return out.slice(start, out.lastIndexOf("</details>") + "</details>".length);
};
const DESKS = [
  { name: "/spy", sc: DRIVE, cfg: DAILY, profile: MONTHLY_PROFILE },
  { name: "/spy-wwv", sc: WWV_DRIVE, cfg: WWV, profile: WWV_PROFILE },
] as const;

describe("one collapsible pocket on both desks", () => {
  for (const d of DESKS) {
    describe(d.name, () => {
      it("is closed by default, and follows the container's state (open only when told)", async () => {
        const s = await snap(d.sc, d.cfg);
        const unset = html(props(s, { profile: d.profile }));
        assert.equal(unset.split('data-testid="desk-pocket"').length - 1, 1, "exactly one pocket");
        assert.doesNotMatch(tag(unset, "desk-pocket"), /\sopen(=|\s|>)/);
        const closed = html(props(s, { profile: d.profile, pocket: { open: false } }));
        assert.doesNotMatch(tag(closed, "desk-pocket"), /\sopen(=|\s|>)/);
        assert.match(tag(closed, "desk-pocket"), /data-open="false"/);
        const open = html(props(s, { profile: d.profile, pocket: { open: true } }));
        assert.match(tag(open, "desk-pocket"), /\sopen(=""|\s|>)/);
        assert.match(tag(open, "desk-pocket"), /data-open="true"/);
      });
      it("holds the audit log, manual ticket, journal, engine log and the rules footer, with all their ids, test ids and text", async () => {
        const out = html(props(await snap(d.sc, d.cfg), { profile: d.profile }));
        const pocket = pocketOf(out);
        assert.match(text(pocket), /Auto audit log \(every decision, newest first\)/);
        assert.match(pocket, /data-testid="auto-log-empty"/);
        assert.match(pocket, /id="ticket-h"[^>]*>Manual SPY option ticket \(dry run\)</);
        assert.match(pocket, /data-testid="analyze-card"/);
        assert.match(pocket, /id="journal-h"[^>]*>Trade journal \(AUTO and MANUAL\)</);
        assert.match(text(pocket), /No dry-run trades recorded yet\./);
        assert.match(text(pocket), /Engine log \(this preview\)/);
        assert.match(pocket, /data-testid="rules-footer"/);
        assert.match(text(pocket), /Rules: nearest listed expiry of at least 365 days; \|delta\| at least 0\.80/);
        assert.match(text(pocket), /Dry run: this page can never send an order\./);
        for (const t of ["Auto audit log", "Manual SPY option ticket (dry run)", "Trade journal (AUTO and MANUAL)", "Engine log (this preview)"]) assert.equal(text(out).split(t).length - 1, 1, `${t} appears once on the page`);
      });
      it("keeps the decision card, readings, position card and the Close button OUTSIDE the pocket, and the Auto switch too", async () => {
        const out = html(props(await snap(d.sc, d.cfg, heldState()), { profile: d.profile }));
        const pocket = pocketOf(out);
        const outside = out.replace(pocket, "");
        assert.match(outside, /data-testid="decision-card"/);
        assert.match(outside, /id="readings-h"/);
        assert.match(outside, /Close \(dry run\)/);
        assert.match(outside, /data-testid="auto-card"/);
        assert.match(outside, /id="auto-h"[^>]*>Auto \(practice trader\)</);
        for (const t of ["decision-card", "readings-h", "Close (dry run)"]) assert.doesNotMatch(pocket, new RegExp(t.replace(/[()]/g, "\\$&")));
        assert.doesNotMatch(pocket, /data-testid="auto-card"/);
        assert.doesNotMatch(outside, /data-testid="auto-log|id="ticket-h"|id="journal-h"|rules-footer/);
      });
      it("the Close box (confirm stage) still draws outside the pocket, whatever the pocket does", async () => {
        const s = await snap(d.sc, d.cfg, heldState());
        for (const open of [false, true]) {
          const out = html(props(s, { profile: d.profile, pocket: { open }, close: { stage: "confirm", ack: false, offerUnpriced: false } }));
          assert.match(out.replace(pocketOf(out), ""), /data-testid="close-confirm"/);
        }
      });
      it("has a summary row: native summary first in the pocket, a chevron, the title, a Show/Hide word, a large tap target and a hint", async () => {
        const out = html(props(await snap(d.sc, d.cfg), { profile: d.profile }));
        const pocket = pocketOf(out);
        assert.match(pocket, /^<details[^>]*data-testid="desk-pocket"[^>]*><summary[^>]*data-testid="desk-pocket-summary"/);
        assert.match(tag(out, "desk-pocket-summary"), /min-h-16/);
        assert.match(tag(out, "desk-pocket-summary"), /focus-visible:outline/);
        assert.doesNotMatch(tag(out, "desk-pocket-summary"), /tabindex/i);
        assert.match(pocket, /<svg[^>]*aria-hidden="true"[^>]*data-testid="desk-pocket-chevron"/);
        assert.match(pocket, /group-open:rotate-90/);
        const summary = pocket.slice(0, pocket.indexOf("</summary>"));
        assert.match(text(summary), /Audit log, manual ticket, journal and engine log/);
        assert.match(text(summary), /Show/);
        assert.match(text(summary), /Hide/);
      });
      it("the hint says the audit and journal counts and whether a dry-run position is held", async () => {
        const none = html(props(await snap(d.sc, d.cfg), { profile: d.profile }));
        assert.match(text(pocketOf(none).match(/data-testid="desk-pocket-hint">([\s\S]*?)<\/span>/)?.[1] ?? ""), /^0 audit entries, 0 journal entries, no dry-run position held$/);
        const s = await snap(d.sc, d.cfg, heldState());
        const withData: DeskSnapshot = { ...s, auto: { ...s.auto, log: [logEntry(1), logEntry(2), logEntry(3)] } };
        const held = html(props(withData, { profile: d.profile }));
        assert.match(text(held.match(/data-testid="desk-pocket-hint">([\s\S]*?)<\/span>/)?.[1] ?? ""), /^3 audit entries, 0 journal entries, dry-run position HELD \(PUT 850\)$/);
        const one: DeskSnapshot = { ...s, auto: { ...s.auto, log: [logEntry(1)] }, position: { status: "unknown", reason: "x" } };
        assert.match(text(html(props(one, { profile: d.profile })).match(/data-testid="desk-pocket-hint">([\s\S]*?)<\/span>/)?.[1] ?? ""), /^1 audit entry, 0 journal entries, dry-run position unknown$/);
      });
      it("never closes by itself: a notice, a ticket symbol, an acknowledgement, busy, a stale refresh and an Analyze error leave it as the container says", async () => {
        const s = await snap(d.sc, d.cfg);
        const busyStates: Array<Partial<DeskViewProps>> = [
          { notice: { kind: "error", text: "The ticket was refused." } },
          { ticket: { type: "put", symbol: "SPY271105P00850000", ack: true } },
          { busy: true },
          { fresh: { ...LOADING_FRESHNESS, state: "stale", updatedAt: "2026-11-03T21:00:00.000Z", chainAt: null, lightError: "boom", retryInMs: 5000 } },
          { analyzer: { ...NO_ANALYSIS, status: "error", error: "Analyze failed" } as DeskViewProps["analyzer"] },
        ];
        for (const over of busyStates) {
          const out = html(props(s, { profile: d.profile, pocket: { open: true }, ...over }));
          assert.match(tag(out, "desk-pocket"), /\sopen(=""|\s|>)/, JSON.stringify(Object.keys(over)));
          assert.match(pocketOf(out), /data-testid="analyze-card"/);
        }
      });
    });
  }
  it("the notice (outcome of a ticket or Close) stays above the pocket, visible while it is closed", async () => {
    const out = html(props(await snap(DRIVE, DAILY), { notice: { kind: "error", text: "The ticket was refused." }, pocket: { open: false } }));
    assert.ok(out.indexOf('data-testid="notice"') < out.indexOf('data-testid="desk-pocket"'));
    assert.match(out.replace(pocketOf(out), ""), /The ticket was refused\./);
  });
  it("notes from the data (warnings) stay visible outside the pocket", async () => {
    const s = await snap(DRIVE, DAILY);
    const out = html(props({ ...s, notes: ["A warning that must stay visible."] }));
    assert.match(out.replace(pocketOf(out), ""), /A warning that must stay visible\./);
  });
});

describe("the open/closed state lives in the container", () => {
  const container = fs.readFileSync("src/components/spy/SpyDesk.tsx", "utf8");
  const view = fs.readFileSync("src/components/spy/SpyDeskView.tsx", "utf8");
  it("SpyDesk owns it with useState (like the ticket and Close state, which no refresh touches), defaults to closed, and hands it down", () => {
    assert.match(container, /const \[pocketOpen, setPocketOpen\] = useState\(false\);/);
    assert.match(container, /pocket=\{\{ open: pocketOpen \}\}/);
    assert.match(container, /onPocketChange=\{setPocketOpen\}/);
  });
  it("nothing resets it: the container never sets it from data, refresh, action or position changes", () => {
    const uses = container.split("\n").filter((l) => /setPocketOpen/.test(l));
    assert.equal(uses.length, 2, "declared once and passed once; no other writer");
  });
  it("the view only reports the browser's own toggle (the event's open flag) and has no other way to change it", () => {
    assert.match(view, /onToggle=\{\(e\) => props\.onPocketChange\?\.\(e\.currentTarget\.open\)\}/);
    assert.equal(view.split("onPocketChange").length - 1, 2, "the prop type and the one toggle handler");
  });
  it("only the secondary parts are inside it: the same Pocket wraps them in one place in the shared view", () => {
    const body = view.slice(view.indexOf("<Pocket props={props} snap={snap}>"), view.indexOf("</Pocket>"));
    for (const t of ["<AutoLog", "<TicketCard", "<Journal", "Engine log (this preview)", "rules-footer"]) assert.ok(body.includes(t), t);
    for (const t of ["<DecisionHero", "<PositionCard", "<ReadingsTable", "<WwvTable", "<AutoCard", "CloseControls"]) assert.ok(!body.includes(t), t);
  });
});
