import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type CloseUi, type DeskViewProps, type TicketUi } from "../src/components/spy/SpyDeskView";
import { buildDeskSnapshot, type DeskPosition, type DeskState } from "../src/lib/spyDesk";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { DRIVE, NEUTRAL, REVERSE, makeDeps, row } from "./helpers/spyDeskFixtures";

const CFG = { timeframe: "M" as const, liveBudget: 1000 };
const noop = () => undefined;
const IDLE: CloseUi = { stage: "idle", ack: false, offerUnpriced: false };
const TICKET: TicketUi = { type: "put", symbol: null, ack: false };

function props(over: Partial<DeskViewProps>): DeskViewProps {
  return { load: { status: "loading" }, busy: false, notice: null, ticket: TICKET, close: IDLE, onRefresh: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over };
}
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
  it("Neutral: four readings with raw net volume, match, reading; decision headline; ticket open with call/put and the chain", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snap(NEUTRAL) } }));
    for (const tf of ["M", "Q", "H", "Y"]) assert.match(out, new RegExp(`data-testid="reading-${tf}"`));
    assert.match(out, /Raw net volume/);
    assert.match(out, /-400/);
    assert.match(out, /disagree/);
    assert.match(out, /NEUTRAL: TRADER DECIDES/);
    assert.match(out, /data-testid="ticket-open"/);
    assert.match(out, /data-testid="ticket-type-call"/);
    assert.match(out, /data-testid="ticket-type-put"/);
    assert.match(out, /SPY271105P00850000|Choose SPY271105P00850000/);
    assert.match(out, /Pick a contract to continue/);
    assert.doesNotMatch(out, /data-testid="ticket-submit"/);
  });
  it("a chosen contract shows the dry-run summary, the below-0.80 marking, and the submit button only after the acknowledgement is ticked", async () => {
    const s = await snap(NEUTRAL);
    const sel = { ...TICKET, symbol: "SPY271105P00850000" };
    const off = html(props({ load: { status: "ready", snapshot: s }, ticket: sel }));
    assert.match(off, /DRY RUN: would buy 1 PUT SPY271105P00850000/);
    assert.match(off, /BELOW 0\.80 \(chosen by hand, floor 0\.60\)/);
    assert.ok(isDisabled(tag(off, "ticket-submit")));
    const on = html(props({ load: { status: "ready", snapshot: s }, ticket: { ...sel, ack: true } }));
    assert.ok(tag(on, "ticket-submit") !== "" && !isDisabled(tag(on, "ticket-submit")));
  });
  it("Drive or Reverse: the engine pick is drawn, the ticket is off with the reason", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snap(DRIVE) } }));
    assert.match(out, /CALL \(Drive\)/);
    assert.match(out, /data-testid="engine-pick"/);
    assert.match(out, /data-testid="ticket-closed"/);
    assert.match(out, /not Neutral/);
    assert.doesNotMatch(out, /data-testid="ticket-open"/);
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
    assert.match(idle, /MANUAL, DRY RUN/);
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
});
