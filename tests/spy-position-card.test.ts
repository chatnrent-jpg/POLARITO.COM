import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type CloseUi, type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { NO_ANALYSIS } from "../src/lib/spyAnalyzer";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { buildDeskSnapshot, type DeskSnapshot } from "../src/lib/spyDesk";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { signedMoney, signedPercent } from "../src/lib/spyDeskFormat";
import { WWV_PROFILE } from "../src/lib/spyProfile";
import { NEUTRAL, makeDeps } from "./helpers/spyDeskFixtures";
import { WWV_NEUTRAL } from "./helpers/wwvFixtures";

const noop = () => undefined;
const IDLE: CloseUi = { stage: "idle", ack: false, offerUnpriced: false };
const props = (snapshot: DeskSnapshot, over: Partial<DeskViewProps> = {}): DeskViewProps => ({ load: { status: "ready", snapshot }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: IDLE, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-23T14:53:05.000Z", chainAt: "2026-11-23T14:53:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const inner = (out: string, id: string): string => text(out.match(new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</(?:div|dd|span)>`))?.[1] ?? "");

/** Henry's position: SPY271217C00700000, 700 strike, entry ask 89.95, delta +0.671, manual, fallback; quote bid 86.90 / ask 87.60. */
async function held(over: { type?: "call" | "put"; source?: "manual" | "auto"; bid?: number | null; fallback?: boolean; wwv?: boolean } = {}): Promise<DeskSnapshot> {
  const type = over.type ?? "call";
  const state = {
    version: 1 as const,
    journal: [],
    position: { type, symbol: type === "call" ? "SPY271217C00700000" : "SPY271217P00700000", expiration: "2027-12-17", strike: 700, quantity: 1 as const, entryAt: "2026-11-23T14:30:00.000Z", entryAsk: 89.95, entryMid: 89.9, entryDelta: type === "call" ? 0.671 : -0.671, deltaTier: over.fallback === false ? ("primary" as const) : ("fallback" as const), fallbackReason: "chosen by hand", decisionTimeframe: over.wwv ? ("D" as const) : ("M" as const), maxLossUsd: 8995, source: over.source ?? ("manual" as const) },
  };
  const cfg = { timeframe: over.wwv ? ("D" as const) : ("M" as const), liveBudget: 1000 };
  const s = await buildDeskSnapshot(makeDeps(over.wwv ? WWV_NEUTRAL : NEUTRAL), cfg, createMemoryDeskStore(state));
  assert.equal(s.position.status, "held");
  if (s.position.status === "held") {
    s.position.quote = over.bid === null ? null : { bid: over.bid ?? 86.9, ask: (over.bid ?? 86.9) + 0.7, pnlUsd: ((over.bid ?? 86.9) - 89.95) * 100, quoteAt: "2026-11-23T14:53:00.000Z" };
  }
  return s;
}

describe("signed number text", () => {
  it("always shows the sign", () => {
    assert.equal(signedMoney(-305), "-$305.00");
    assert.equal(signedMoney(1234.5), "+$1,234.50");
    assert.equal(signedMoney(0), "$0.00");
    assert.equal(signedPercent(-3.3907), "-3.39%");
    assert.equal(signedPercent(2), "+2.00%");
    assert.equal(signedPercent(0), "0.00%");
  });
});

describe("open position card (shared by both desks)", () => {
  it("is the very first thing on the page, above the neutral banner, readings, decision and the ticket", async () => {
    const out = html(props(await held()));
    const at = (needle: string) => out.indexOf(needle);
    const hero = at('data-testid="position-held"');
    assert.ok(hero > 0);
    for (const later of ['data-testid="neutral-banner"', 'id="readings-h"', 'id="decision-h"', 'id="pick-h"', 'id="auto-h"', 'id="ticket-h"', 'id="journal-h"']) {
      assert.ok(at(later) > hero, `${later} comes after the position card`);
    }
    assert.ok(at('data-testid="desk-body"') < hero, "inside the page body");
    assert.ok(at('data-testid="freshness"') < hero && at('data-testid="desk-body"') > 0);
    assert.equal(out.match(/data-testid="position-held"/g)?.length, 1);
    assert.doesNotMatch(out, /data-testid="position-none"/);
    assert.match(out, /<h2 id="pos-h">Open dry-run position<\/h2>/);
    assert.doesNotMatch(out, />Dry-run position</, "no second, buried copy");
  });
  it("big CALL badge with MANUAL, DRY RUN and the delta-fallback note as separate badges", async () => {
    const out = html(props(await held()));
    assert.match(tag(out, "position-side"), /text-2xl/);
    assert.equal(inner(out, "position-side").trim(), "CALL");
    assert.match(tag(out, "position-side"), /emerald/);
    assert.match(out, />MANUAL<\/span>/);
    assert.match(out, />DRY RUN<\/span>/);
    assert.match(out, />BELOW 0\.80 \(chosen by hand, floor 0\.60\)<\/span>/);
    assert.doesNotMatch(out, /MANUAL, DRY RUN/);
  });
  it("a PUT is red and an AUTO position says AUTO; a primary-delta position has no fallback note", async () => {
    const out = html(props(await held({ type: "put", source: "auto", fallback: false })));
    assert.equal(inner(out, "position-side").trim(), "PUT");
    assert.match(tag(out, "position-side"), /red/);
    assert.match(out, /data-testid="position-held"[\s\S]*?>AUTO<\/span>[\s\S]*?>DRY RUN<\/span>/);
    assert.doesNotMatch(out, /BELOW 0\.80/);
  });
  it("a loss: -$305.00, -3.39%, the word loss, red, labelled 'if closed at the bid', and the largest text on the card", async () => {
    const out = html(props(await held()));
    const pnl = tag(out, "position-pnl");
    assert.match(pnl, /data-state="loss"/);
    assert.equal(inner(out, "pnl-usd").trim(), "-$305.00");
    assert.equal(inner(out, "pnl-pct").trim(), "-3.39%");
    assert.equal(inner(out, "pnl-word").trim(), "loss");
    assert.match(out, /if closed at the bid \(86\.90\), as % of the \$8,995\.00 entry cost/);
    assert.match(out, /text-red-300/);
    assert.match(tag(out, "pnl-usd"), /sm:text-6xl/);
    const card = out.slice(out.indexOf('data-testid="position-held"'), out.indexOf('id="readings-h"'));
    for (const m of card.matchAll(/class="([^"]*)"/g)) {
      const sizes = [...m[1].matchAll(/(?:^|\s)(?:sm:)?text-(5xl|6xl|7xl)/g)];
      if (sizes.length > 0) assert.match(m[1], /sm:text-6xl|text-4xl sm:text-5xl/, "only the result (and its unknown state) is that big");
    }
  });
  it("a gain: +$ and +%, the word gain, green; break-even has no colour meaning at all", async () => {
    const gain = html(props(await held({ bid: 92.95 })));
    assert.match(tag(gain, "position-pnl"), /data-state="gain"/);
    assert.equal(inner(gain, "pnl-usd").trim(), "+$300.00");
    assert.equal(inner(gain, "pnl-pct").trim(), "+3.34%");
    assert.equal(inner(gain, "pnl-word").trim(), "gain");
    assert.match(gain, /text-emerald-300/);
    const even = html(props(await held({ bid: 89.95 })));
    assert.match(tag(even, "position-pnl"), /data-state="even"/);
    assert.equal(inner(even, "pnl-word").trim(), "break-even");
    assert.equal(inner(even, "pnl-usd").trim(), "$0.00");
  });
  it("no usable quote: 'Result unknown' with the reason, never a made-up number", async () => {
    const out = html(props(await held({ bid: null })));
    assert.match(tag(out, "position-pnl"), /data-state="unknown"/);
    assert.match(out, /Result unknown/);
    assert.match(out, /no usable quote right now/);
    assert.doesNotMatch(out, /data-testid="pnl-usd"/);
  });
  it("a clean labelled grid: contract, strike / expiry, entry ask / delta, entry cost / max loss, now bid / ask, quote time", async () => {
    const out = html(props(await held()));
    const grid = out.slice(out.indexOf('data-testid="position-grid"'), out.indexOf('data-testid="position-close"'));
    for (const label of ["Contract", "Strike / expiry", "Entry (ask) / delta", "Entry cost / max loss", "Now (bid / ask)", "Quote time"]) assert.match(grid, new RegExp(`<dt[^>]*>${label.replace(/[()/]/g, "\\$&")}</dt>`), label);
    const t = text(grid);
    assert.match(t, /SPY271217C00700000/);
    assert.match(t, /700 \/ 2027-12-17/);
    assert.match(t, /89\.95 \/ \+0\.671/);
    assert.match(t, /\$8,995\.00/);
    assert.match(t, /86\.90 \/ 87\.60/);
    assert.match(inner(out, "quote-time"), /quote made 2026-11-23 14:53 UTC/);
    assert.equal([...grid.matchAll(/<dt class="[^"]*text-zinc-400/g)].length, 6, "muted labels");
    assert.equal([...grid.matchAll(/<dd class="[^"]*font-semibold/g)].length, 6, "bold values");
  });
  it("Close (dry run) is a prominent button directly under the card's grid, before anything else on the page", async () => {
    const out = html(props(await held()));
    const grid = out.indexOf('data-testid="position-grid"');
    const close = out.indexOf('data-testid="close-start"');
    assert.ok(grid > 0 && close > grid);
    assert.ok(close < out.indexOf('id="readings-h"'));
    assert.match(tag(out, "close-start"), /py-3/);
    assert.match(tag(out, "close-start"), /w-full/);
    assert.match(out, /Close \(dry run\)/);
  });
  it("the same confirm flow: acknowledgement first, then the submit button; an open box shows inside the card", async () => {
    const s = await held();
    const idle = html(props(s));
    assert.doesNotMatch(idle, /data-testid="close-submit"/);
    const confirm = html(props(s, { close: { stage: "confirm", ack: false, offerUnpriced: true } }));
    assert.match(confirm, /data-testid="position-held"[\s\S]*data-testid="close-confirm"[\s\S]*id="readings-h"/);
    assert.match(tag(confirm, "close-submit"), /disabled=""/);
    assert.match(confirm, /data-testid="close-unpriced"/);
    assert.match(confirm, /No order is sent to any broker/);
    assert.doesNotMatch(confirm, /data-testid="close-start"/);
    const armed = html(props(s, { close: { stage: "confirm", ack: true, offerUnpriced: false } }));
    assert.doesNotMatch(tag(armed, "close-submit"), /disabled=""/);
    const busy = html(props(s, { busy: true }));
    assert.match(tag(busy, "close-start"), /disabled=""/);
  });
  it("accessible: meaning never rests on colour alone, and the card is a labelled region", async () => {
    const out = html(props(await held()));
    assert.match(out, /<section[^>]*aria-labelledby="pos-h"[^>]*data-testid="position-held"/);
    const t = text(out.slice(out.indexOf('data-testid="position-held"'), out.indexOf('id="readings-h"')));
    assert.match(t, /CALL/);
    assert.match(t, /-\$305\.00/);
    assert.match(t, /-3\.39%/);
    assert.match(t, /loss/);
  });
  it("mobile: two-column grid that becomes three from sm, the contract spans the first row, long symbols wrap", async () => {
    const out = html(props(await held()));
    assert.match(tag(out, "position-grid"), /grid-cols-2 [^"]*sm:grid-cols-3/);
    assert.match(out, /col-span-2 sm:col-span-1/);
    assert.match(out, /break-all font-mono/);
    assert.match(tag(out, "pnl-usd"), /text-4xl/);
  });
  it("no position: the compact card stays where it was; unknown stays a quiet warning", async () => {
    const none = html(props(await buildDeskSnapshot(makeDeps(NEUTRAL), { timeframe: "M", liveBudget: 1000 }, createMemoryDeskStore())));
    assert.match(none, /data-testid="position-none"/);
    assert.match(none, />Dry-run position</);
    assert.doesNotMatch(none, /data-testid="position-held"|Open dry-run position/);
    assert.ok(none.indexOf('id="pos-h"') > none.indexOf('id="decision-h"'), "the empty state keeps its place below the decision");
    const unknown = html(props(await buildDeskSnapshot(makeDeps(NEUTRAL), { timeframe: "M", liveBudget: 1000 }, null)));
    assert.match(unknown, /data-testid="position-unknown"/);
    assert.doesNotMatch(unknown, /data-testid="position-held"/);
  });
  it("the same card on both desks (shared view): identical markup apart from the desk's own title", async () => {
    const monthly = html(props(await held()));
    const wwv = html(props(await held({ wwv: true }), { profile: WWV_PROFILE }));
    const card = (o: string) => o.slice(o.indexOf('<section class="rounded-xl border-2'), o.indexOf("</section>", o.indexOf('data-testid="position-close"')));
    assert.ok(card(monthly).length > 500);
    assert.equal(card(wwv), card(monthly));
    assert.match(wwv, /SPY DESK WWV/);
    assert.ok(wwv.indexOf('data-testid="position-held"') < wwv.indexOf('id="readings-h"'));
  });
});
