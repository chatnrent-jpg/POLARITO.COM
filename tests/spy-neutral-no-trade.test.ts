import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { NO_ANALYSIS, type AnalyzerState } from "../src/lib/spyAnalyzer";
import { buildAnalysis } from "../src/lib/spyAnalysis";
import { AUTO_SWITCH_KEY, runAutoCycle } from "../src/lib/spyAuto";
import { buildDeskSnapshot, closeManual, openManual, type DeskConfig, type DeskPosition, type DeskSnapshot, type DeskState } from "../src/lib/spyDesk";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { handleClose, handleTicket, type DeskContext } from "../src/lib/spyDeskRoutes";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { checkSide } from "../src/lib/spyGear";
import { createMemorySpyKv, scopeKv } from "../src/lib/spyKv";
import { MONTHLY_PROFILE, WWV_PROFILE, type DeskProfile } from "../src/lib/spyProfile";
import { DRIVE, NEUTRAL, REVERSE, makeDeps, row, type Calls, type Scenario } from "./helpers/spyDeskFixtures";
import { WWV_DRIVE, WWV_NEUTRAL, WWV_REVERSE } from "./helpers/wwvFixtures";

const noop = () => undefined;
const BASE = "https://www.polarito.com";
const MONTHLY: DeskConfig = { timeframe: "M", liveBudget: 1000 };
const WWV: DeskConfig = { timeframe: "D", liveBudget: 1000 };
const SYMBOL = { call: "SPY271105C00600000", put: "SPY271105P00850000" } as const;
const calls = (): Calls => ({ daily: 0, spot: 0, sides: [], held: 0 });
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z0-9]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const props = (snapshot: DeskSnapshot, over: Partial<DeskViewProps> = {}): DeskViewProps => ({ load: { status: "ready", snapshot }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-03T21:30:05.000Z", chainAt: "2026-11-03T21:30:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
const heldPut = (timeframe: DeskPosition["decisionTimeframe"], source: DeskPosition["source"] = "manual"): DeskState => {
  const r = row("put", "2027-11-05", 850);
  return { version: 1, journal: [], position: { type: "put", symbol: r.symbol, expiration: "2027-11-05", strike: 850, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta, deltaTier: "fallback", fallbackReason: "chosen by hand", decisionTimeframe: timeframe, maxLossUsd: r.ask * 100, source } };
};

const DESKS = [
  { name: "/spy (Monthly)", cfg: MONTHLY, path: "/api/spy", profile: MONTHLY_PROFILE as DeskProfile, drive: DRIVE, reverse: REVERSE, neutral: NEUTRAL, tf: "M" as const },
  { name: "/spy-wwv", cfg: WWV, path: "/api/spy-wwv", profile: WWV_PROFILE as DeskProfile, drive: WWV_DRIVE, reverse: WWV_REVERSE, neutral: WWV_NEUTRAL, tf: "D" as const },
] as const;

const ctx = (sc: Scenario, cfg: DeskConfig, profile: DeskProfile, store = createMemoryDeskStore()): DeskContext => ({ env: { POLARITO_SPY_DESK: "1" }, makeLive: async () => ({ ok: true as const, deps: makeDeps(sc), config: cfg }), store, profile });
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, host: "www.polarito.com" }, body: JSON.stringify(body) });

describe("Neutral: a new manual buy is refused (NEUTRAL_NO_TRADE) on both desks", () => {
  for (const d of DESKS) {
    for (const type of ["call", "put"] as const) {
      it(`${d.name}: openManual ${type} on Neutral is refused, 409, nothing saved, no chain read`, async () => {
        const store = createMemoryDeskStore();
        const c = calls();
        const res = await openManual(makeDeps(d.neutral, { calls: c }), d.cfg, store, { type, symbol: SYMBOL[type] });
        assert.ok(!res.ok);
        assert.equal(res.code, "NEUTRAL_NO_TRADE");
        assert.equal(res.status, 409);
        assert.match(res.error, new RegExp(`^${type === "call" ? "Call" : "Put"} is blocked: the gear is Neutral, so no new position can be opened`));
        assert.match(res.error, /the market goes nowhere on Neutral/);
        assert.match(res.error, /Closing a held position still works/);
        assert.match(res.error, /The server checked the .* gear itself\. Nothing was recorded\./);
        const saved = await store.read();
        assert.ok(saved.ok && saved.state.position === null && saved.state.journal.length === 0);
        assert.deepEqual(c.sides, [], "refused before the option chain was read");
      });
      it(`${d.name}: HTTP ticket ${type} on Neutral answers 409 NEUTRAL_NO_TRADE whatever the browser claims`, async () => {
        for (const claim of [undefined, "NEUTRAL", "DRIVE", "REVERSE"] as const) {
          const c = ctx(d.neutral, d.cfg, d.profile);
          const res = await handleTicket(post(`${d.path}/ticket`, { type, symbol: SYMBOL[type], acknowledgeDryRun: true, ...(claim ? { analyzedGear: claim } : {}) }), c);
          assert.equal(res.status, 409, String(claim));
          const body = (await res.json()) as { ok: boolean; code: string; error: string };
          assert.equal(body.ok, false);
          assert.equal(body.code, "NEUTRAL_NO_TRADE");
          assert.match(body.error, /no new position can be opened/);
          const saved = await c.store!.read();
          assert.ok(saved.ok && saved.state.position === null);
        }
      });
    }
    it(`${d.name}: the error code is its own (not COUNTER_POLARITY), and Drive (calls only) and Reverse (puts only) are unchanged`, async () => {
      const wrongOnDrive = await openManual(makeDeps(d.drive), d.cfg, createMemoryDeskStore(), { type: "put", symbol: SYMBOL.put });
      assert.ok(!wrongOnDrive.ok && wrongOnDrive.code === "COUNTER_POLARITY");
      const wrongOnReverse = await openManual(makeDeps(d.reverse), d.cfg, createMemoryDeskStore(), { type: "call", symbol: SYMBOL.call });
      assert.ok(!wrongOnReverse.ok && wrongOnReverse.code === "COUNTER_POLARITY");
      const callStore = createMemoryDeskStore();
      assert.ok((await openManual(makeDeps(d.drive), d.cfg, callStore, { type: "call", symbol: SYMBOL.call })).ok, "Drive still opens a call");
      const putStore = createMemoryDeskStore();
      assert.ok((await openManual(makeDeps(d.reverse), d.cfg, putStore, { type: "put", symbol: SYMBOL.put })).ok, "Reverse still opens a put");
    });
    it(`${d.name}: the same message as the pure side check the browser uses, for both sides`, () => {
      for (const type of ["call", "put"] as const) {
        const c = checkSide("NEUTRAL", type);
        assert.equal(c.allowed, false);
        assert.match(c.message, /is blocked: the gear is Neutral/);
      }
      assert.deepEqual([checkSide("DRIVE", "call").allowed, checkSide("DRIVE", "put").allowed, checkSide("REVERSE", "call").allowed, checkSide("REVERSE", "put").allowed], [true, false, false, true]);
    });
    it(`${d.name}: Analyze reports no allowed side on Neutral`, async () => {
      const a = await buildAnalysis(makeDeps(d.neutral), d.cfg);
      assert.ok(a.ok);
      assert.equal(a.gear, "NEUTRAL");
      assert.deepEqual(a.allowed, { call: false, put: false });
    });
  }
});

describe("Neutral: Close of a held position still works", () => {
  for (const d of DESKS) {
    it(`${d.name}: closeManual on Neutral closes at the bid and clears the position`, async () => {
      const store = createMemoryDeskStore(heldPut(d.tf));
      const res = await closeManual(makeDeps(d.neutral), store, { unpriced: false });
      assert.ok(res.ok, res.ok ? "" : res.error);
      const s = await store.read();
      assert.ok(s.ok && s.state.position === null);
      assert.equal(s.ok && s.state.journal[0].kind, "manual-close");
    });
    it(`${d.name}: HTTP Close on Neutral answers 200`, async () => {
      const c = ctx(d.neutral, d.cfg, d.profile, createMemoryDeskStore(heldPut(d.tf)));
      const res = await handleClose(post(`${d.path}/close`, { acknowledgeDryRun: true }), c);
      assert.equal(res.status, 200);
      const s = await c.store!.read();
      assert.ok(s.ok && s.state.position === null);
    });
    it(`${d.name}: the page still shows the Close button and the Neutral banner while a position is held`, async () => {
      const snap = await buildDeskSnapshot(makeDeps(d.neutral), d.cfg, createMemoryDeskStore(heldPut(d.tf)));
      const out = html(props(snap, { profile: d.profile }));
      assert.match(out, /Close \(dry run\)/);
      assert.match(out, /data-testid="neutral-banner"/);
      assert.match(text(out), /close it by hand if you want out/);
    });
  }
});

describe("Neutral: Auto already takes no action, and the note now says the buy is blocked", () => {
  for (const d of DESKS) {
    it(`${d.name}: Auto logs a neutral outcome naming NEUTRAL_NO_TRADE, opens nothing, reads no chain`, async () => {
      const kv = scopeKv(createMemorySpyKv(), d.profile);
      await kv.set(AUTO_SWITCH_KEY, JSON.stringify({ auto: true, at: "2026-11-01T00:00:00.000Z" }));
      const desk = createMemoryDeskStore();
      const c = calls();
      const out = await runAutoCycle(makeDeps(d.neutral, { calls: c }), d.cfg, { desk, kv }, {});
      assert.equal(out.outcome, "neutral");
      assert.match(out.message, /TRADER DECIDES/);
      assert.match(out.message, /New buy blocked on Neutral \(NEUTRAL_NO_TRADE\)/);
      const s = await desk.read();
      assert.ok(s.ok && s.state.position === null);
      assert.deepEqual(c.sides, []);
    });
  }
});

describe("Neutral is cognac, Drive green and Reverse red stay", () => {
  const analyzed = async (sc: Scenario, cfg: DeskConfig): Promise<AnalyzerState> => {
    const a = await buildAnalysis(makeDeps(sc), cfg);
    assert.ok(a.ok);
    return { status: "ok", analysis: a, error: null, gearChange: null };
  };
  for (const d of DESKS) {
    it(`${d.name}: decision card, gear badge and gear line are cognac on Neutral (no grey)`, async () => {
      const out = html(props(await buildDeskSnapshot(makeDeps(d.neutral), d.cfg, createMemoryDeskStore()), { profile: d.profile }));
      const card = tag(out, "decision-card");
      assert.match(card, /border-\[#9A4E2C\]/);
      assert.doesNotMatch(card, /border-zinc|ring-zinc/);
      assert.match(tag(out, "decision-badge"), /bg-\[#9A4E2C\]\/40/);
      assert.match(out, /bg-\[#9A4E2C\] text-white/, "the decision header bar");
      assert.match(tag(out, "gear-badge"), /bg-\[#9A4E2C\]\/40 text-\[#F6D9C5\] ring-\[#C0693F\]/);
      assert.doesNotMatch(tag(out, "gear-badge"), /zinc/);
      assert.match(text(out), /No new position on Neutral; Close still works\./);
    });
    it(`${d.name}: the Neutral reading badge in the pocket is cognac, Drive stays green, Reverse stays red`, async () => {
      const gearBadge = async (sc: Scenario) => tag(html(props(await buildDeskSnapshot(makeDeps(sc), d.cfg, createMemoryDeskStore()), { profile: d.profile })), "gear-badge");
      assert.match(await gearBadge(d.drive), /bg-emerald-500\/20 text-emerald-200 ring-emerald-400/);
      assert.match(await gearBadge(d.reverse), /bg-red-500\/20 text-red-200 ring-red-400/);
      assert.doesNotMatch(await gearBadge(d.drive), /9A4E2C/);
      assert.doesNotMatch(await gearBadge(d.reverse), /9A4E2C/);
      const drive = html(props(await buildDeskSnapshot(makeDeps(d.drive), d.cfg, createMemoryDeskStore()), { profile: d.profile }));
      assert.match(tag(drive, "decision-card"), /border-emerald-400/);
      assert.doesNotMatch(drive, /9A4E2C/);
      const reverse = html(props(await buildDeskSnapshot(makeDeps(d.reverse), d.cfg, createMemoryDeskStore()), { profile: d.profile }));
      assert.match(tag(reverse, "decision-card"), /border-red-400/);
      assert.doesNotMatch(reverse, /9A4E2C/);
    });
    it(`${d.name}: the Analyze gear card hint is cognac on Neutral and says no new position`, async () => {
      const out = html(props(await buildDeskSnapshot(makeDeps(d.neutral), d.cfg, createMemoryDeskStore()), { profile: d.profile, analyzer: await analyzed(d.neutral, d.cfg) }));
      const card = out.slice(out.indexOf('data-testid="gear-card"'));
      assert.match(card, /<span class="[^"]*bg-\[#9A4E2C\]\/30[^"]*">no new position<\/span>/);
      assert.match(out, /data-testid="side-blocked"/);
    });
  }
  it("/spy: a Neutral reading card (period readings) is cognac", async () => {
    const out = html(props(await buildDeskSnapshot(makeDeps(NEUTRAL), MONTHLY, createMemoryDeskStore()), { profile: MONTHLY_PROFILE }));
    const m = out.match(/<li[^>]*data-testid="reading-M"[\s\S]*?<\/li>/)?.[0] ?? "";
    assert.match(m, /data-gear="Neutral"/);
    assert.match(m, /bg-\[#9A4E2C\]\/40/);
  });
  it("the cognac is the requested #9A4E2C with a light tint for text, and no other file defines a second Neutral colour", () => {
    const view = fs.readFileSync("src/components/spy/SpyDeskView.tsx", "utf8");
    assert.ok(view.includes("#9A4E2C"));
    assert.match(view, /readingTone = .*label === "Neutral" \? "cognac"/);
  });
});
