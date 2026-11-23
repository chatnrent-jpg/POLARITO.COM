import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { NO_ANALYSIS } from "../src/lib/spyAnalyzer";
import { buildDeskSnapshot, type DeskConfig, type DeskSnapshot, type DeskState } from "../src/lib/spyDesk";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { MONTHLY_PROFILE, WWV_PROFILE } from "../src/lib/spyProfile";
import { DRIVE, NEUTRAL, makeDeps, row, type Scenario } from "./helpers/spyDeskFixtures";
import { WWV_DRIVE, WWV_NEUTRAL } from "./helpers/wwvFixtures";

const noop = () => undefined;
const DAILY: DeskConfig = { timeframe: "1D", liveBudget: 1000 };
const WWV: DeskConfig = { timeframe: "D", liveBudget: 1000 };
const props = (snapshot: DeskSnapshot, over: Partial<DeskViewProps> = {}): DeskViewProps => ({ load: { status: "ready", snapshot }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-03T21:30:05.000Z", chainAt: "2026-11-03T21:30:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z0-9]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const at = (out: string, needle: string): number => out.indexOf(needle);
const hintOf = (out: string): string => text(out.match(/data-testid="readings-pocket-hint">([\s\S]*?)<\/span>/)?.[1] ?? "");
/** The readings pocket's markup: its <details> to the first </details> after it (the audit pocket is a separate, later element). */
const pocketOf = (out: string): string => {
  const start = out.lastIndexOf("<details", out.indexOf('data-testid="readings-pocket"'));
  return out.slice(start, out.indexOf("</details>", start) + "</details>".length);
};
const heldState = (): DeskState => {
  const r = row("put", "2027-11-05", 850);
  return { version: 1, journal: [], position: { type: "put", symbol: r.symbol, expiration: "2027-11-05", strike: 850, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta, deltaTier: "fallback", fallbackReason: "chosen by hand", decisionTimeframe: "M", maxLossUsd: r.ask * 100, source: "manual" } };
};
const snap = (sc: Scenario, cfg: DeskConfig, state?: DeskState): Promise<DeskSnapshot> => buildDeskSnapshot(makeDeps(sc), cfg, createMemoryDeskStore(state));

const DESKS = [
  { name: "/spy", sc: DRIVE, neutral: NEUTRAL, cfg: DAILY, profile: MONTHLY_PROFILE, wwv: false },
  { name: "/spy-wwv", sc: WWV_DRIVE, neutral: WWV_NEUTRAL, cfg: WWV, profile: WWV_PROFILE, wwv: true },
] as const;
const four = (s: DeskSnapshot) => (s.timeframe === "D" ? (s.contextReadings ?? []) : s.readings.filter((r) => r.timeframe !== "1D"));

describe("the four readings live in one closed pocket on both desks", () => {
  for (const d of DESKS) {
    describe(d.name, () => {
      it("is closed by default, open only when the container says so, and there is exactly one", async () => {
        const s = await snap(d.sc, d.cfg);
        const unset = html(props(s, { profile: d.profile }));
        assert.equal(unset.split('data-testid="readings-pocket"').length - 1, 1);
        assert.doesNotMatch(tag(unset, "readings-pocket"), /\sopen(=""|\s|>)/);
        const closed = html(props(s, { profile: d.profile, readingsPocket: { open: false } }));
        assert.match(tag(closed, "readings-pocket"), /data-open="false"/);
        assert.doesNotMatch(tag(closed, "readings-pocket"), /\sopen(=""|\s|>)/);
        const open = html(props(s, { profile: d.profile, readingsPocket: { open: true } }));
        assert.match(tag(open, "readings-pocket"), /data-open="true"/);
        assert.match(tag(open, "readings-pocket"), /\sopen(=""|\s|>)/);
      });

      it("holds exactly Monthly, Quarterly, 6-month and Yearly, with the net-volume definition under them", async () => {
        const s = await snap(d.sc, d.cfg);
        const out = html(props(s, { profile: d.profile }));
        const pocket = pocketOf(out);
        for (const k of ["M", "Q", "H", "Y"]) assert.match(pocket, new RegExp(`data-testid="reading-${k}"`), k);
        assert.equal(pocket.match(/data-testid="reading-[A-Z0-9]+"/g)?.length, 4, "exactly four readings");
        assert.match(pocket, /id="(?:context-)?readings-h"[^>]*>Four readings \(period to date, SPY\)</);
        assert.match(text(pocket), /Net volume is the chart definition: the period's total daily volume, signed by the latest close versus the previous period's last close\. A reading counts only when candle colour and net volume match\./);
        assert.equal(text(out).split("Net volume is the chart definition").length - 1, 1, "the sentence appears once on the page");
        assert.ok(pocket.indexOf("readings-list") < pocket.indexOf("Net volume is the chart definition"), "definition sits under the readings");
        assert.doesNotMatch(pocket, /data-testid="reading-(1D|D)"/);
        assert.doesNotMatch(pocket, /data-testid="decision-card"/);
        assert.doesNotMatch(pocket, /data-testid="desk-pocket"/, "not nested inside the audit pocket");
      });

      it("the decision and the decider's own reading stay outside the pocket", async () => {
        for (const sc of [d.sc, d.neutral]) {
          const out = html(props(await snap(sc, d.cfg), { profile: d.profile }));
          const outside = out.replace(pocketOf(out), "");
          assert.match(outside, /data-testid="decision-card"/);
          if (d.wwv) {
            assert.match(outside, /data-testid="wwv-table"/);
            assert.match(outside, /Daily Weis Wave Volume \(WWV, setting 1, SPY\)/);
            assert.match(outside, /data-testid="reading-D"/);
          } else {
            assert.match(outside, /data-testid="daily-reading"/);
            assert.match(outside, /data-testid="reading-1D"/);
            assert.match(outside, /Daily reading \(today, SPY\)/);
          }
          assert.match(outside, /data-testid="auto-card"/);
          assert.match(outside, /data-testid="desk-pocket"/, "the audit pocket is untouched");
        }
      });

      it("sits where the four readings were: after the decision (and the Daily/WWV reading), before the position card and the audit pocket", async () => {
        const out = html(props(await snap(d.sc, d.cfg), { profile: d.profile }));
        const order = ['data-testid="decision-card"', d.wwv ? 'data-testid="wwv-table"' : 'data-testid="daily-reading"', 'data-testid="readings-pocket"', 'id="pos-h"', 'data-testid="desk-pocket"'].map((n) => at(out, n));
        assert.ok(order.every((v) => v > 0), JSON.stringify(order));
        assert.deepEqual([...order].sort((a, b) => a - b), order);
        const held = html(props(await snap(d.sc, d.cfg, heldState()), { profile: d.profile }));
        assert.ok(at(held, 'data-testid="position-held"') < at(held, 'data-testid="decision-card"'), "held position card still first");
        assert.ok(at(held, 'data-testid="readings-pocket"') > at(held, 'data-testid="decision-card"'));
        assert.match(held, /Close \(dry run\)/);
      });

      it("summary row: title, one-line gear hint, chevron, Show/Hide, large tap target, keyboard-native", async () => {
        const s = await snap(d.sc, d.cfg);
        const out = html(props(s, { profile: d.profile }));
        const pocket = pocketOf(out);
        assert.match(pocket, /^<details[^>]*data-testid="readings-pocket"[^>]*><summary[^>]*data-testid="readings-pocket-summary"/);
        assert.match(tag(out, "readings-pocket-summary"), /min-h-16/);
        assert.match(tag(out, "readings-pocket-summary"), /focus-visible:outline/);
        assert.match(tag(out, "readings-pocket-summary"), /cursor-pointer/);
        assert.doesNotMatch(tag(out, "readings-pocket-summary"), /tabindex|role=/, "native summary, no fake button");
        assert.match(pocket, /<svg[^>]*aria-hidden="true"[^>]*data-testid="readings-pocket-chevron"/);
        assert.match(pocket, /group-open:rotate-90/);
        const summary = pocket.slice(pocket.indexOf("<summary"), pocket.indexOf("</summary>"));
        assert.match(text(summary), /Four readings \(period to date\)/);
        assert.match(text(summary), /Show/);
        assert.match(text(summary), /Hide/);
        const expected = four(s).map((r) => `${r.name} ${r.label}`).join(", ");
        assert.equal(hintOf(out), expected);
        assert.match(hintOf(out), /^Monthly [\w ]+, Quarterly [\w ]+, 6-month [\w ]+, Yearly [\w ]+$/);
      });

      it("the hint tracks the readings (a Neutral market changes the words, not the layout)", async () => {
        const a = html(props(await snap(d.sc, d.cfg), { profile: d.profile }));
        const b = html(props(await snap(d.neutral, d.cfg), { profile: d.profile }));
        assert.equal(hintOf(b), four(await snap(d.neutral, d.cfg)).map((r) => `${r.name} ${r.label}`).join(", "));
        assert.equal(a.split("readings-pocket-summary").length, b.split("readings-pocket-summary").length);
      });

      it("does not touch the audit pocket: still one desk-pocket with its own title and none of the readings", async () => {
        const out = html(props(await snap(d.sc, d.cfg), { profile: d.profile, pocket: { open: true }, readingsPocket: { open: false } }));
        assert.equal(out.split('data-testid="desk-pocket"').length - 1, 1);
        const audit = out.slice(out.lastIndexOf("<details", out.indexOf('data-testid="desk-pocket"')));
        assert.match(text(audit), /Audit log, manual ticket, journal and engine log/);
        assert.doesNotMatch(audit, /data-testid="readings-pocket"|data-testid="readings-list"/);
        assert.match(tag(out, "desk-pocket"), /data-open="true"/);
        assert.match(tag(out, "readings-pocket"), /data-open="false"/);
      });
    });
  }

  it("/spy: the readings keep their ids, decision tags and the in-progress note inside the pocket", async () => {
    const s = await snap(DRIVE, DAILY);
    const pocket = pocketOf(html(props(s, { profile: MONTHLY_PROFILE })));
    for (const k of ["M", "Q", "H", "Y"]) assert.match(pocket, new RegExp(`data-testid="net-${k}"`));
    assert.match(pocket, /Raw net volume/);
    assert.match(pocket, /Previous period close/);
  });

  it("/spy-wwv: the pasted context section is complete, including the Context only sentence", async () => {
    const out = html(props(await snap(WWV_DRIVE, WWV), { profile: WWV_PROFILE }));
    const pocket = pocketOf(out);
    assert.match(pocket, /data-testid="context-readings"/);
    assert.match(text(pocket), /Context only: on this desk the decision is the daily Weis Wave Volume above; these readings do not decide, choose the contract, drive Auto or gate the ticket\./);
  });

  it("no context readings (a desk with none): no empty pocket is drawn on the WWV desk", async () => {
    const s = await snap(WWV_DRIVE, WWV);
    const none = { ...s, contextReadings: [] };
    assert.equal(html(props(none, { profile: WWV_PROFILE })).includes('data-testid="readings-pocket"'), false);
  });
});

describe("the pocket's state lives in the container, so refreshes never reset it", () => {
  const container = fs.readFileSync("src/components/spy/SpyDesk.tsx", "utf8");
  const view = fs.readFileSync("src/components/spy/SpyDeskView.tsx", "utf8");
  it("SpyDesk owns one boolean, passes it down, and nothing else writes it", () => {
    assert.match(container, /const \[readingsPocketOpen, setReadingsPocketOpen\] = useState\(false\);/);
    assert.match(container, /readingsPocket=\{\{ open: readingsPocketOpen \}\}/);
    assert.match(container, /onReadingsPocketChange=\{setReadingsPocketOpen\}/);
    assert.equal(container.split("\n").filter((l) => /setReadingsPocketOpen/.test(l)).length, 2, "declared once and passed once");
  });
  it("the view only reports the browser's toggle, never closes the pocket by itself", () => {
    assert.match(view, /onToggle=\{\(e\) => props\.onReadingsPocketChange\?\.\(e\.currentTarget\.open\)\}/);
    assert.equal(view.split("onReadingsPocketChange").length - 1, 2, "the prop type and the one toggle handler");
  });
  it("the view has no state, effect or timer of its own", () => {
    assert.doesNotMatch(view, /useState|useEffect|setInterval|setTimeout/);
  });
});
