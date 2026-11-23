import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type CloseUi, type DeskViewProps, type TicketUi } from "../src/components/spy/SpyDeskView";
import { NO_ANALYSIS, type AnalyzerState } from "../src/lib/spyAnalyzer";
import { buildAnalysis } from "../src/lib/spyAnalysis";
import { LOADING_FRESHNESS, type Freshness } from "../src/lib/spyDeskData";
import { buildDeskSnapshot, type DeskPosition, type DeskState } from "../src/lib/spyDesk";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { AUTO_SWITCH_KEY, buildAutoView, runAutoCycle } from "../src/lib/spyAuto";
import { createMemorySpyKv } from "../src/lib/spyKv";
import { DRIVE, NEUTRAL, REVERSE, makeDeps, row } from "./helpers/spyDeskFixtures";

const CFG = { timeframe: "M" as const, liveBudget: 1000 };
const noop = () => undefined;
const LIVE_FRESH: Freshness = { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-03T21:30:05.000Z", chainAt: "2026-11-03T21:30:00.000Z" };
const IDLE: CloseUi = { stage: "idle", ack: false, offerUnpriced: false };
const TICKET: TicketUi = { type: "put", symbol: null, ack: false };

function props(over: Partial<DeskViewProps>): DeskViewProps {
  return { load: { status: "loading" }, busy: false, notice: null, ticket: TICKET, close: IDLE, autoUi: { ack: false }, fresh: LIVE_FRESH, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over };
}
const gearOf = async (sc: Parameters<typeof makeDeps>[0]): Promise<AnalyzerState> => {
  const a = await buildAnalysis(makeDeps(sc), CFG);
  assert.ok(a.ok);
  return { status: "ok", analysis: a, error: null, gearChange: null };
};
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const isDisabled = (t: string): boolean => /\sdisabled=""/.test(t);
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p));
const snap = async (sc: Parameters<typeof makeDeps>[0], o: Parameters<typeof makeDeps>[1] = {}, store: ReturnType<typeof createMemoryDeskStore> | null = createMemoryDeskStore()) => buildDeskSnapshot(makeDeps(sc, o), CFG, store);

function held(): DeskState {
  const r = row("put", "2027-11-05", 850);
  const position: DeskPosition = { type: "put", symbol: r.symbol, expiration: "2027-11-05", strike: 850, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta, deltaTier: "fallback", fallbackReason: "chosen by hand", decisionTimeframe: "M", maxLossUsd: r.ask * 100, source: "manual" };
  return { version: 1, position, journal: [] };
}

describe("SPY desk view (rendering only)", () => {
  it("always says dry run, and that no order can be sent", () => {
    const out = html(props({}));
    assert.match(out, /DRY RUN: no orders can be sent/);
    assert.match(out, /data-testid="loading"/);
  });
  it("an error is shown as Data unavailable, with nothing else drawn", () => {
    const out = html(props({ load: { status: "error", error: "Data unavailable: No Alpaca keys." } }));
    assert.match(out, /data-testid="load-error"/);
    assert.doesNotMatch(out, /data-testid="ticket-open"/);
    assert.doesNotMatch(out, /Four readings/);
  });
  it("Neutral: four readings with raw net volume, match, reading; decision headline; the ticket refuses both sides (no new position) and offers no chain", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL) }, analyzer: await gearOf(NEUTRAL), ticket: { ...TICKET, type: "call" } }));
    for (const tf of ["M", "Q", "H", "Y"]) assert.match(out, new RegExp(`data-testid="reading-${tf}"`));
    assert.match(out, /Raw net volume/);
    assert.match(out, /-400/);
    assert.match(out, /disagree/);
    assert.match(out, /NEUTRAL: TRADER DECIDES/);
    assert.match(out, /data-testid="ticket-open"/);
    assert.match(out, /data-testid="ticket-type-call"/);
    assert.match(out, /data-testid="ticket-type-put"/);
    assert.match(out, /data-testid="side-blocked"/);
    assert.doesNotMatch(out, /data-testid="side-ok"/);
    assert.match(out, /Call is blocked: the gear is Neutral, so no new position can be opened/);
    const put = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL) }, analyzer: await gearOf(NEUTRAL), ticket: { ...TICKET, type: "put" } }));
    assert.match(put, /Put is blocked: the gear is Neutral, so no new position can be opened/);
    assert.doesNotMatch(put, /SPY271105P00850000/);
    assert.doesNotMatch(put, /data-testid="ticket-submit"/);
  });
  it("a chosen contract shows the dry-run summary, the below-0.80 marking, and the submit button only after the acknowledgement is ticked", async () => {
    const s = await snap(REVERSE);
    const sel = { ...TICKET, symbol: "SPY271105P00850000" };
    const analyzer = await gearOf(REVERSE);
    const off = html(props({ load: { status: "ready", snapshot: s }, ticket: sel, analyzer }));
    assert.match(off, /DRY RUN: would buy 1 PUT SPY271105P00850000/);
    assert.match(off, /BELOW 0\.80 \(chosen by hand, floor 0\.60\)/);
    assert.ok(isDisabled(tag(off, "ticket-submit")));
    const on = html(props({ load: { status: "ready", snapshot: s }, ticket: { ...sel, ack: true }, analyzer }));
    assert.ok(tag(on, "ticket-submit") !== "" && !isDisabled(tag(on, "ticket-submit")));
    const neutral = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL) }, ticket: { ...sel, ack: true }, analyzer: await gearOf(NEUTRAL) }));
    assert.doesNotMatch(neutral, /data-testid="ticket-summary"/, "on Neutral a chosen contract is never summarised or submittable");
    assert.doesNotMatch(neutral, /data-testid="ticket-submit"/);
  });
  it("Drive: the engine pick is drawn, and the manual ticket card is open once Analyze has run", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snap(DRIVE) }, analyzer: await gearOf(DRIVE) }));
    assert.match(out, /CALL \(Drive\)/);
    assert.match(out, /data-testid="engine-pick"/);
    assert.match(out, /data-testid="ticket-open"/);
    assert.match(out, /Select Call or Put\. It will be checked against the active gear immediately\./);
    assert.doesNotMatch(out, /data-testid="ticket-closed"/);
  });
  it("fallback pick carries the FALLBACK DELTA (below 0.80) marking, the actual delta and why", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snap(REVERSE, { putStrikes: [690, 800, 850, 900] }) } }));
    assert.match(out, /FALLBACK DELTA \(below 0\.80\)/);
    assert.match(out, /data-testid="fallback-why"/);
    assert.match(out, /the actual delta is -0\.\d{3}, below the 0\.80 target/);
    assert.match(out, /CHEAPEST usable contract at or above the 0\.6 floor/);
    assert.match(out, /Not affordable on the \$1,000\.00 live account/);
  });
  it("data unavailable: a visible alert, no pick, no ticket", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL, { dailyFails: true }) } }));
    assert.match(out, /data-testid="data-unavailable"/);
    assert.match(out, /DATA UNAVAILABLE: no decision/);
    assert.match(out, /Data unavailable: no reading could be computed/);
    assert.match(out, /data-testid="ticket-closed"/);
    assert.doesNotMatch(out, /data-testid="engine-pick"/);
  });
  it("stale data: each reading says Data unavailable with its reason", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL, { now: new Date("2026-11-12T21:30:00Z") }) } }));
    assert.match(out, /Data unavailable/);
    assert.doesNotMatch(out, />Neutral</);
  });
  it("no store: the warning and 'position unknown' are shown, never 'no position held'", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL, {}, null) } }));
    assert.match(out, /data-testid="store-warning"/);
    assert.match(out, /data-testid="position-unknown"/);
    assert.doesNotMatch(out, /data-testid="position-none"/);
    assert.doesNotMatch(out, /data-testid="ticket-open"/);
  });
  it("a held position shows its details, the manual/dry-run badges and the Close button; the confirm step needs the acknowledgement", async () => {
    const s = await snap(NEUTRAL, {}, createMemoryDeskStore(held()));
    const idle = html(props({ load: { status: "ready", snapshot: s } }));
    assert.match(idle, /data-testid="position-held"/);
    assert.match(idle, />MANUAL<\/span>/);
    assert.match(idle, />DRY RUN<\/span>/);
    assert.match(idle, /data-testid="close-start"/);
    assert.doesNotMatch(idle, /data-testid="close-submit"/);
    const confirm = html(props({ load: { status: "ready", snapshot: s }, close: { stage: "confirm", ack: false, offerUnpriced: true } }));
    assert.ok(isDisabled(tag(confirm, "close-submit")));
    assert.match(confirm, /data-testid="close-unpriced"/);
    assert.match(confirm, /No order is sent to any broker/);
    const ready = html(props({ load: { status: "ready", snapshot: s }, close: { stage: "confirm", ack: true, offerUnpriced: false } }));
    assert.ok(tag(ready, "close-submit") !== "" && !isDisabled(tag(ready, "close-submit")));
    assert.doesNotMatch(ready, /data-testid="close-unpriced"/);
  });
  it("a zero or missing net volume flag is shown on the row", async () => {
    const s = await snap(NEUTRAL);
    s.readings[0] = { ...s.readings[0], netVolume: null, netFlag: "missing" };
    const out = html(props({ load: { status: "ready", snapshot: s } }));
    assert.match(out, /MISSING NET VOLUME: Neutral, no sign guessed/);
  });
  it("notices render, and buttons are disabled while busy", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL) }, busy: true, notice: { kind: "error", text: "Refused: nothing recorded." } }));
    assert.match(out, /Refused: nothing recorded\./);
    assert.ok(isDisabled(tag(out, "refresh")));
  });
  it("Auto card: OFF by default with the acknowledgement gate on Turn ON; ON shows Turn OFF; no store says why", async () => {
    const kv = createMemorySpyKv();
    const view = await buildAutoView(kv);
    const s = await buildDeskSnapshot(makeDeps(DRIVE), CFG, createMemoryDeskStore(), view);
    const off = html(props({ load: { status: "ready", snapshot: s } }));
    assert.match(off, /data-testid="auto-card"/);
    assert.match(off, /AUTO OFF/);
    assert.ok(isDisabled(tag(off, "auto-on")));
    assert.match(off, /data-testid="auto-log-empty"/);
    const acked = html(props({ load: { status: "ready", snapshot: s }, autoUi: { ack: true } }));
    assert.ok(!isDisabled(tag(acked, "auto-on")));
    const on = html(props({ load: { status: "ready", snapshot: { ...s, auto: { ...s.auto, on: true } } } }));
    assert.match(on, /AUTO ON/);
    assert.match(on, /data-testid="auto-off"/);
    assert.doesNotMatch(on, /data-testid="auto-on"/);
    const none = html(props({ load: { status: "ready", snapshot: await snap(DRIVE) } }));
    assert.match(none, /data-testid="auto-unavailable"/);
  });
  it("AUTO and MANUAL labels on the position and each journal entry; the audit log lists every decision", async () => {
    const r = createMemorySpyKv();
    r.data.set(AUTO_SWITCH_KEY, { value: JSON.stringify({ auto: true, at: "2026-11-01T00:00:00.000Z" }), expiresAt: null });
    const desk = createMemoryDeskStore();
    await runAutoCycle(makeDeps(DRIVE), CFG, { desk, kv: r }, {});
    const s = await buildDeskSnapshot(makeDeps(DRIVE), CFG, desk, await buildAutoView(r));
    const out = html(props({ load: { status: "ready", snapshot: s } }));
    assert.match(out, /data-testid="position-held"[\s\S]*?>AUTO<\/span>[\s\S]*?>DRY RUN<\/span>/);
    assert.match(out, /data-testid="journal"[\s\S]*>AUTO</);
    assert.match(out, /data-testid="auto-log"/);
    assert.match(out, /OPENED/);
    const manual = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL, {}, createMemoryDeskStore(held())) } }));
    assert.match(manual, /data-testid="position-held"[\s\S]*?>MANUAL<\/span>[\s\S]*?>DRY RUN<\/span>/);
  });
  it("Neutral while holding shows the banner for the trader", async () => {
    const s = await snap(NEUTRAL, {}, createMemoryDeskStore(held()));
    const out = html(props({ load: { status: "ready", snapshot: s } }));
    assert.match(out, /data-testid="neutral-banner"/);
    assert.match(out, /Auto leaves it alone/);
    const flat = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL) } }));
    assert.doesNotMatch(flat, /data-testid="neutral-banner"/);
  });
});

