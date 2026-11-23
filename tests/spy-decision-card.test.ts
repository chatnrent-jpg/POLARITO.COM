import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { tradingDaysBetween } from "../src/lib/marketCalendar";
import type { Bar } from "../src/lib/polarity";
import { NO_ANALYSIS } from "../src/lib/spyAnalyzer";
import { buildDeskSnapshot, type DeskConfig, type DeskSnapshot } from "../src/lib/spyDesk";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { netVolumeWord, readingWhy } from "../src/lib/spyDeskFormat";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { WWV_PROFILE } from "../src/lib/spyProfile";
import { DRIVE, NEUTRAL, REVERSE, makeDeps, type Scenario } from "./helpers/spyDeskFixtures";
import { WWV_DRIVE, WWV_NEUTRAL, WWV_REVERSE } from "./helpers/wwvFixtures";

const noop = () => undefined;
const M: DeskConfig = { timeframe: "M", liveBudget: 1000 };
const D: DeskConfig = { timeframe: "D", liveBudget: 1000 };
const props = (snapshot: DeskSnapshot, over: Partial<DeskViewProps> = {}): DeskViewProps => ({ load: { status: "ready", snapshot }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-03T21:30:05.000Z", chainAt: "2026-11-03T21:30:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z0-9]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
/** The markup of the section with this data-testid, from its tag to its closing </section>. */
const section = (out: string, id: string): string => {
  const start = out.indexOf(`data-testid="${id}"`);
  return start < 0 ? "" : out.slice(start, out.indexOf("</section>", start));
};
const monthly = async (sc: Scenario, over: Partial<DeskViewProps> = {}) => html(props(await buildDeskSnapshot(makeDeps(sc), M, createMemoryDeskStore()), over));
const wwv = async (sc: Scenario, over: Partial<DeskViewProps> = {}) => html(props(await buildDeskSnapshot(makeDeps(sc), D, createMemoryDeskStore()), { profile: WWV_PROFILE, ...over }));

function history(end: string): Bar[] {
  const dates = tradingDaysBetween("2025-10-01", end);
  return dates.map((date, i) => {
    const close = 100 + (i % 5);
    const open = close - 0.5;
    return { date, open, high: close + 1, low: open - 1, close, volume: 1000 + i };
  });
}

describe("decision card (shared by both desks)", () => {
  it("CALL on Drive: a huge green CALL badge, the gear Drive in green with the words, the plain why and the as-of time", async () => {
    const out = await monthly(DRIVE);
    const card = section(out, "decision-card");
    assert.match(tag(out, "decision-card"), /data-action="CALL"/);
    assert.match(tag(out, "decision-card"), /border-emerald-400/);
    assert.match(tag(out, "decision-badge"), /text-5xl[^"]*sm:text-7xl/);
    assert.match(tag(out, "decision-badge"), /emerald/);
    assert.match(card, /data-testid="decision-badge">CALL</);
    assert.match(card, /data-testid="decision-headline">CALL \(Drive\)</);
    assert.match(section(out, "decision-card"), /data-testid="gear-badge" data-gear="Drive"/);
    assert.match(text(card), /Gear: DRIVE|Gear: Drive/i);
    assert.match(text(card), /Calls only\./);
    const why = text(card.match(/data-testid="decision-why">([\s\S]*?)<\/p>/)?.[1] ?? "");
    assert.match(why, /^The Monthly candle is green \(\d+\.\d\d to \d+\.\d\d\) and its net volume is \+[\d,]+ \(positive\): they agree, so the reading is Drive\.$/);
    assert.match(text(card), /as of 2026-11-03 21:30 UTC/);
  });
  it("PUT on Reverse: a huge red PUT badge, gear Reverse in red, negative net volume said in words and with a minus sign", async () => {
    const out = await monthly(REVERSE);
    const card = section(out, "decision-card");
    assert.match(tag(out, "decision-card"), /data-action="PUT"/);
    assert.match(tag(out, "decision-card"), /border-red-400/);
    assert.match(card, /data-testid="decision-badge">PUT</);
    assert.match(tag(out, "decision-badge"), /red/);
    assert.match(card, /data-gear="Reverse"/);
    assert.match(text(card), /Puts only\./);
    assert.match(text(card), /net volume is -[\d,]+ \(negative\): they agree, so the reading is Reverse\./);
  });
  it("NEUTRAL: a huge cognac NEUTRAL badge, gear Neutral, 'no new position', and why they do not agree", async () => {
    const out = await monthly(NEUTRAL);
    const card = section(out, "decision-card");
    assert.match(tag(out, "decision-card"), /data-action="STAND_ASIDE"/);
    assert.match(tag(out, "decision-card"), /border-\[#9A4E2C\]/);
    assert.doesNotMatch(tag(out, "decision-card"), /border-zinc-400/);
    assert.match(card, /bg-\[#9A4E2C\] text-white/);
    assert.match(card, /data-testid="decision-badge">NEUTRAL</);
    assert.doesNotMatch(tag(out, "decision-badge"), /emerald|red-|rose|amber/);
    assert.match(card, /data-gear="Neutral"/);
    assert.match(text(card), /No new position on Neutral; Close still works\./);
    assert.match(text(card), /they do not agree, so the reading is Neutral\./);
    assert.doesNotMatch(card, /data-testid="engine-pick"/);
    assert.match(text(card), /NEUTRAL: TRADER DECIDES\. The engine picks nothing/);
  });
  it("no usable data: NO DATA in rose, no gear, no number is invented", async () => {
    const snapshot = await buildDeskSnapshot(makeDeps({ daily: DRIVE.daily.slice(0, -1) }), M, createMemoryDeskStore());
    const out = html(props(snapshot));
    const card = section(out, "decision-card");
    assert.match(tag(out, "decision-card"), /data-action="DATA_UNAVAILABLE"/);
    assert.match(card, /data-testid="decision-badge">NO DATA</);
    assert.match(tag(out, "decision-card"), /border-rose-400/);
    assert.match(text(card), /Gear: unavailable\./);
    assert.match(text(card), /No trustworthy Monthly reading/);
    assert.doesNotMatch(card, /data-testid="engine-pick"/);
    assert.match(out, /data-testid="data-unavailable"/);
  });
  it("sits directly under the open-position card, or first on the page when no position is held; the old separate decision and pick sections are gone", async () => {
    const none = await monthly(DRIVE);
    const at = (out: string, needle: string) => out.indexOf(needle);
    const body = at(none, 'data-testid="desk-body"');
    assert.ok(at(none, 'data-testid="decision-card"') > body);
    assert.ok(at(none, 'id="auto-h"') > body && at(none, 'id="auto-h"') < at(none, 'data-testid="decision-card"'), "the Auto card now sits directly above the decision card");
    for (const later of ['id="readings-h"', 'id="ticket-h"', 'id="journal-h"', 'id="pos-h"']) {
      assert.ok(at(none, later) > at(none, 'data-testid="decision-card"'), `${later} after the decision card`);
    }
    assert.equal(none.match(/id="decision-h"/g)?.length, 1);
    assert.doesNotMatch(none, /id="pick-h"/);

    const state = { version: 1 as const, journal: [], position: { type: "call" as const, symbol: "SPY271217C00700000", expiration: "2027-12-17", strike: 700, quantity: 1 as const, entryAt: "2026-11-03T20:00:00.000Z", entryAsk: 89.95, entryMid: 89.9, entryDelta: 0.671, deltaTier: "fallback" as const, fallbackReason: "chosen by hand", decisionTimeframe: "M" as const, maxLossUsd: 8995, source: "manual" as const } };
    const snapshot = await buildDeskSnapshot(makeDeps(DRIVE), M, createMemoryDeskStore(state));
    const withPos = html(props(snapshot));
    const pos = at(withPos, 'data-testid="position-held"');
    const dec = at(withPos, 'data-testid="decision-card"');
    assert.ok(pos > body && dec > pos, "position first, decision right under it");
    for (const between of ['data-testid="neutral-banner"', 'data-testid="data-unavailable"', 'id="readings-h"']) {
      const i = at(withPos, between);
      assert.ok(i < 0 || i > dec, `${between} comes after the decision card`);
    }
  });
  it("the contract the engine would pick is a compact block inside the card, with the fallback note kept", async () => {
    const out = await monthly(DRIVE);
    const card = section(out, "decision-card");
    assert.match(card, /data-testid="engine-pick"/);
    assert.match(text(card), /Contract the engine would pick \(preview, nothing is saved\)/);
    assert.match(text(card), /Cost per contract \(ask x 100\)/);
    assert.match(card, /break-all font-mono/);
  });
  it("labels a session in progress (monthly and WWV), and the label is gone after the close", async () => {
    const live = makeDeps({ daily: history("2026-11-23") }, { now: new Date("2026-11-23T14:45:00Z") });
    const m = html(props(await buildDeskSnapshot(live, M, createMemoryDeskStore())));
    assert.match(section(m, "decision-card"), /data-testid="decision-in-progress"/);
    assert.match(text(section(m, "decision-card")), /session in progress: can change until the close/);
    const w = html(props(await buildDeskSnapshot(makeDeps({ daily: history("2026-11-23") }, { now: new Date("2026-11-23T14:45:00Z") }), D, createMemoryDeskStore()), { profile: WWV_PROFILE }));
    assert.match(section(w, "decision-card"), /data-testid="decision-in-progress"/);
    const closed = html(props(await buildDeskSnapshot(makeDeps({ daily: history("2026-11-23") }, { now: new Date("2026-11-23T21:30:00Z") }), M, createMemoryDeskStore())));
    assert.doesNotMatch(closed, /decision-in-progress/);
  });
  it("accessible: labelled section, the meaning is in words and signs, never in colour alone", async () => {
    for (const sc of [DRIVE, REVERSE, NEUTRAL]) {
      const out = await monthly(sc);
      const card = section(out, "decision-card");
      assert.match(tag(out, "decision-card"), /^<section[^>]*aria-labelledby="decision-h"/);
      assert.match(text(card), /Decision \(Monthly timeframe\)/);
      assert.match(text(card), /CALL|PUT|NEUTRAL/);
      assert.match(text(card), /Drive|Reverse|Neutral/);
    }
  });
  it("WWV desk: same card, the daily wave in the why line, 'Daily, WWV' timeframe", async () => {
    for (const [sc, action, gear] of [[WWV_DRIVE, "CALL", "Drive"], [WWV_REVERSE, "PUT", "Reverse"], [WWV_NEUTRAL, "STAND_ASIDE", "Neutral"]] as const) {
      const out = await wwv(sc);
      const card = section(out, "decision-card");
      assert.match(tag(out, "decision-card"), new RegExp(`data-action="${action}"`));
      assert.match(card, new RegExp(`data-gear="${gear}"`));
      assert.match(text(card), /Decision \(Daily, WWV timeframe\)/);
      assert.match(text(card), /The latest daily candle is (green|red) \([\d.]+ to [\d.]+\) and the current wave is (UP|DOWN) \([\d,]+ shares so far\): they (do not )?agree, so the reading is /);
    }
    assert.match(text(section(await wwv(WWV_DRIVE), "decision-card")), /so the reading is Drive\./);
  });
  it("the same card markup on both desks (shared view)", async () => {
    const a = section(await monthly(DRIVE), "decision-card");
    const b = section(await wwv(WWV_DRIVE), "decision-card");
    const shape = (s: string) => [...s.matchAll(/data-testid="([a-z-]+)"/g)].map((m) => m[1]).filter((t) => !["engine-pick", "fallback-why"].includes(t));
    assert.deepEqual(shape(a), shape(b));
  });
});

describe("four readings as stacked cards (no table, no sideways scroll)", () => {
  it("one card per timeframe in a list; no table, no minimum width, no horizontal scroller", async () => {
    const out = await monthly(DRIVE);
    assert.match(tag(out, "readings-list"), /^<ul[^>]*grid-cols-1/);
    assert.doesNotMatch(out, /<table|min-w-\[|overflow-x-auto/);
    for (const tf of ["M", "Q", "H", "Y"]) assert.match(out, new RegExp(`<li[^>]*data-testid="reading-${tf}"`));
    assert.match(out, /Four readings \(period to date, SPY\)/);
  });
  it("every card has the timeframe name, candle colour with open to close, previous close, signed net volume in words, match and the gear badge", async () => {
    const out = await monthly(DRIVE);
    for (const name of ["Monthly", "Quarterly", "6-month", "Yearly"]) assert.match(text(out), new RegExp(`${name}`));
    const q = out.match(/<li[^>]*data-testid="reading-Q"[\s\S]*?<\/li>/)?.[0] ?? "";
    assert.match(text(q), /Candle \(open to close\) (green|red) \([\d.]+ to [\d.]+\)/);
    assert.match(text(q), /Previous period close [\d.]+/);
    assert.match(text(q), /Raw net volume [+-][\d,]+ \((positive|negative)\)/);
    assert.match(text(q), /Match (agree|disagree)/);
    assert.match(q, /data-testid="gear-badge" data-gear="(Drive|Reverse|Neutral)"/);
    assert.match(text(q), /since 20\d\d-\d\d-\d\d, as of 2026-11-03 21:30 UTC/);
  });
  it("positive net volume is green with '+' and 'positive'; negative is red with '-' and 'negative'", async () => {
    const up = await monthly(DRIVE);
    assert.match(tag(up, "net-M"), /text-emerald-300/);
    assert.match(text(up.match(/data-testid="net-M"[^>]*>([\s\S]*?)<\/dd>/)?.[1] ?? ""), /^ ?\+[\d,]+ \(positive\) ?$/);
    const down = await monthly(REVERSE);
    assert.match(tag(down, "net-M"), /text-red-300/);
    assert.match(text(down.match(/data-testid="net-M"[^>]*>([\s\S]*?)<\/dd>/)?.[1] ?? ""), /^ ?-[\d,]+ \(negative\) ?$/);
  });
  it("only the deciding timeframe is highlighted (sky border, 'decides' tag); the others are plain and muted but still readable", async () => {
    const out = await monthly(DRIVE);
    assert.match(tag(out, "reading-M"), /data-decides="true"/);
    assert.match(tag(out, "reading-M"), /border-sky-400/);
    assert.match(out, /data-testid="decides-M">decides</);
    for (const tf of ["Q", "H", "Y"]) {
      assert.match(tag(out, `reading-${tf}`), /data-decides="false"/);
      assert.doesNotMatch(tag(out, `reading-${tf}`), /sky/);
      assert.doesNotMatch(out, new RegExp(`decides-${tf}`));
    }
    assert.equal(out.match(/>decides</g)?.length, 1);
    assert.doesNotMatch(out.match(/<ul[^>]*data-testid="readings-list"[\s\S]*?<\/ul>/)?.[0] ?? "", /opacity-/);
  });
  it("a disagreeing timeframe says 'disagree' in words (amber is only a hint), and Neutral is cognac", async () => {
    const out = await monthly(NEUTRAL);
    const m = out.match(/<li[^>]*data-testid="reading-M"[\s\S]*?<\/li>/)?.[0] ?? "";
    assert.match(text(m), /Match disagree/);
    assert.match(m, /text-amber-300">disagree/);
    assert.match(m, /data-gear="Neutral"/);
    assert.match(m, /bg-\[#9A4E2C\]\/40/);
    assert.doesNotMatch(m, /bg-zinc-600\/30/);
  });
  it("in-progress and unavailable readings keep their notes", async () => {
    const live = makeDeps({ daily: history("2026-11-23") }, { now: new Date("2026-11-23T14:45:00Z") });
    const out = html(props(await buildDeskSnapshot(live, M, createMemoryDeskStore())));
    for (const tf of ["M", "Q", "H", "Y"]) assert.match(out, new RegExp(`data-testid="in-progress-${tf}"`));
    const bad = html(props(await buildDeskSnapshot(makeDeps({ daily: [] }), M, createMemoryDeskStore())));
    assert.match(bad, /Data unavailable/);
  });
  it("mobile: two-column facts with the candle on its own row, long values wrap; desktop: four columns", async () => {
    const out = await monthly(DRIVE);
    const q = out.match(/<li[^>]*data-testid="reading-Q"[\s\S]*?<\/li>/)?.[0] ?? "";
    assert.match(q, /<dl class="[^"]*grid-cols-2[^"]*sm:grid-cols-4"/);
    assert.match(q, /col-span-2 min-w-0 sm:col-span-1/);
    assert.match(q, /break-words/);
    assert.match(q, /flex-wrap/);
  });
  it("WWV: one highlighted Daily card with the wave facts, as stacked fields (no table)", async () => {
    const out = await wwv(WWV_DRIVE);
    assert.doesNotMatch(out, /<table|min-w-\[|overflow-x-auto/);
    assert.match(tag(out, "wwv-table"), /border-sky-400/);
    assert.match(out, /data-testid="decides-D">decides</);
    assert.match(tag(out, "reading-D"), /data-decides="true"/);
    for (const label of ["Current wave", "Wave volume so far", "Previous wave volume", "Latest daily candle", "Match"]) assert.match(text(out), new RegExp(label));
    assert.match(out, /data-testid="wwv-volume"[^>]*>700</);
    assert.match(out, /data-testid="wwv-asof"/);
    assert.match(out, /data-gear="Drive"/);
  });
});

describe("plain-English why helpers", () => {
  const base = { name: "Monthly", status: "ok" as const, label: "Drive", candle: "green" as const, open: 95, close: 99, netVolume: 4200, match: "agree" as const, reason: null, wwv: null };
  it("netVolumeWord", () => {
    assert.equal(netVolumeWord(5), "positive");
    assert.equal(netVolumeWord(-5), "negative");
    assert.equal(netVolumeWord(0), "zero");
    assert.equal(netVolumeWord(null), "missing");
  });
  it("agree, disagree, zero, missing, unavailable and WWV sentences", () => {
    assert.equal(readingWhy(base), "The Monthly candle is green (95.00 to 99.00) and its net volume is +4,200 (positive): they agree, so the reading is Drive.");
    assert.equal(readingWhy({ ...base, label: "Neutral", netVolume: -400, match: "disagree" }), "The Monthly candle is green (95.00 to 99.00) and its net volume is -400 (negative): they do not agree, so the reading is Neutral.");
    assert.match(readingWhy({ ...base, label: "Neutral", netVolume: 0, match: "disagree" }), /net volume is 0 \(zero\)/);
    assert.match(readingWhy({ ...base, label: "Neutral", netVolume: null, match: "disagree" }), /net volume is missing:/);
    assert.equal(readingWhy({ ...base, status: "unavailable", reason: "stale data" }), "No trustworthy Monthly reading: stale data. Nothing is assumed.");
    assert.equal(readingWhy({ ...base, name: "Daily, WWV", netVolume: null, wwv: { direction: "up", waveVolume: 700 } }), "The latest daily candle is green (95.00 to 99.00) and the current wave is UP (700 shares so far): they agree, so the reading is Drive.");
  });
});
