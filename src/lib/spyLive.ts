/**
 * The SPY desk's LIGHT view: what changes second to second, cheap enough to ask for every 5 seconds.
 *
 * Alpaca cost of one light read: the SPY last trade (1 request), the held contract's snapshot (1 request, only when a
 * position is held) and the daily bars (1 request, which the route serves from a 15 s cache). It NEVER reads the option
 * chain (125+ quotes); that is the heavy view in spyDesk.ts (buildDeskSnapshot), asked for far less often.
 *
 * DRY RUN ONLY: GET-style reads and a read of the saved record. Writes nothing. No broker, no order client.
 *
 * Unidirectional flow:  light payload (server) -> parseLiveSnapshot (shape check) -> mergeLive over the last heavy
 *                       snapshot -> one DeskSnapshot for the view. User choices (Call/Put, contract row, ticks, dialogs)
 *                       are held by the container, never by these snapshots, so a refresh cannot reset them.
 */
import { computeContextReadings, contextReadingKeys, deskReadingKeys, isDeskTimeframe, type DeskReading, type DeskTimeframe } from "@/lib/deskReadings";
import { etClock } from "@/lib/marketCalendar";
import { AUTO_UNAVAILABLE, isAutoView, type AutoView } from "@/lib/spyAutoTypes";
import {
  JOURNAL_SHOWN,
  deskDecision,
  heldPositionView,
  isDecisionView,
  isPositionView,
  isReadingView,
  isStr,
  neutralBanner,
  parseJournalEntry,
  readStateForView,
  readingView,
  type DeskConfig,
  type DeskDeps,
  type DeskSnapshot,
  type DeskStore,
  type JournalEntry,
  type PositionView,
  type ReadingView,
} from "@/lib/spyDesk";
import { describeDecision } from "@/lib/spyEngine";
import type { Spot } from "@/lib/spyChain";

export type LiveSnapshot = {
  ok: true;
  dryRun: true;
  kind: "live";
  generatedAt: string;
  timeframe: DeskTimeframe;
  spot: Spot | null;
  readings: ReadingView[];
  /** WWV desk only: the four period readings (M, Q, H, Y) shown as CONTEXT. Never the decision source (none is a decision reading). Absent or empty elsewhere. */
  contextReadings?: ReadingView[];
  decision: DeskSnapshot["decision"];
  position: PositionView;
  store: DeskSnapshot["store"];
  journal: JournalEntry[];
  auto: AutoView;
  notes: string[];
};

/** Reads market data and the saved record; writes nothing. Never throws: every failure becomes visible text. */
export async function buildLiveSnapshot(deps: DeskDeps, config: DeskConfig, store: DeskStore | null, auto: AutoView = AUTO_UNAVAILABLE): Promise<LiveSnapshot> {
  const now = deps.now();
  const notes: string[] = [];
  const viewed = await readStateForView(store);
  const out: LiveSnapshot = {
    ok: true,
    dryRun: true,
    kind: "live",
    generatedAt: now.toISOString(),
    timeframe: config.timeframe,
    spot: null,
    readings: [],
    decision: { action: "UNKNOWN", reason: "not evaluated", traderDecides: false },
    position: viewed.position,
    store: viewed.storeView,
    journal: viewed.state ? viewed.state.journal.slice(-JOURNAL_SHOWN).reverse() : [],
    auto: { ...auto, banner: null },
    notes,
  };

  try {
    const spotRes = await deps.readSpot();
    if (spotRes.ok) out.spot = spotRes.value;
    else notes.push(`The SPY price could not be read (${spotRes.error}).`);

    const dailyRes = await deps.loadDaily();
    if (!dailyRes.ok) {
      out.decision = { action: "DATA_UNAVAILABLE", reason: `daily bars could not be read (${dailyRes.error})`, traderDecides: false };
    } else {
      const decision = deskDecision(dailyRes.value, now, config.timeframe);
      const readings = decision.readings;
      out.readings = deskReadingKeys(config.timeframe).flatMap((tf) => (readings[tf] ? [readingView(readings[tf] as DeskReading, tf === config.timeframe)] : []));
      const ctxKeys = contextReadingKeys(config.timeframe);
      if (ctxKeys.length > 0) {
        const ctx = computeContextReadings(dailyRes.value, now, config.timeframe);
        out.contextReadings = ctxKeys.flatMap((tf) => (ctx[tf] ? [readingView(ctx[tf] as DeskReading, false)] : []));
      }
      out.decision =
        decision.status === "ok"
          ? { action: decision.action, reason: describeDecision(decision.reading, config.timeframe), traderDecides: decision.action === "STAND_ASIDE" }
          : { action: "DATA_UNAVAILABLE", reason: decision.reason, traderDecides: false };
    }

    if (viewed.state?.position) {
      out.position = await heldPositionView(viewed.state.position, async () => out.spot, deps, etClock(now).date, now, notes);
    }
    out.auto = { ...out.auto, banner: neutralBanner(out.position, out.decision.action) };
  } catch {
    notes.push("Unexpected error while building the live data. Nothing is assumed.");
  }
  return out;
}

/** Strict shape check of the light payload, run in the browser before anything is drawn. */
export function parseLiveSnapshot(raw: unknown): { ok: true; snapshot: LiveSnapshot } | { ok: false; error: string } {
  const bad = (what: string) => ({ ok: false as const, error: `The live data came in an unexpected shape (${what}). It was not used.` });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not an object");
  const r = raw as Record<string, unknown>;
  if (r.ok !== true || r.dryRun !== true || r.kind !== "live") return bad("header");
  if (!isStr(r.generatedAt) || Number.isNaN(Date.parse(r.generatedAt)) || !isDeskTimeframe(r.timeframe)) return bad("meta");
  if (r.spot !== null && !(typeof r.spot === "object" && r.spot !== null && typeof (r.spot as { price?: unknown }).price === "number" && Number.isFinite((r.spot as { price: number }).price))) return bad("spot");
  if (!Array.isArray(r.readings) || !r.readings.every(isReadingView)) return bad("readings");
  if (r.contextReadings !== undefined && (!Array.isArray(r.contextReadings) || !r.contextReadings.every(isReadingView))) return bad("context readings");
  if (!isDecisionView(r.decision)) return bad("decision");
  if (!isPositionView(r.position)) return bad("position");
  if (typeof r.store !== "object" || r.store === null || typeof (r.store as { available?: unknown }).available !== "boolean") return bad("store");
  if (!Array.isArray(r.journal) || !r.journal.every((e) => parseJournalEntry(e) !== null)) return bad("journal");
  if (!isAutoView(r.auto)) return bad("auto");
  if (!Array.isArray(r.notes) || !r.notes.every(isStr)) return bad("notes");
  return { ok: true, snapshot: r as unknown as LiveSnapshot };
}

const positionKey = (p: PositionView): string => (p.status === "held" ? `held:${p.symbol}` : p.status);

/**
 * Lay the fresh light data over the last heavy snapshot. The chain-bound parts (the engine's contract preview and the ticket's
 * candidate lists) come from the heavy snapshot only. When the light data shows the reading, the position or the store
 * changed since the chain was read, those parts are marked "updating" (never shown as current) and `chainStale` tells the
 * caller to fetch the heavy view now.
 */
export function mergeLive(heavy: DeskSnapshot, live: LiveSnapshot): { snapshot: DeskSnapshot; chainStale: boolean } {
  const chainStale =
    heavy.decision.action !== live.decision.action || positionKey(heavy.position) !== positionKey(live.position) || heavy.store.available !== live.store.available;
  const reason = "The reading or the position changed since the option chain was last read. It is being refreshed.";
  const notes = [...live.notes];
  if (!chainStale) for (const n of heavy.notes) if (!notes.includes(n)) notes.push(n);
  const snapshot: DeskSnapshot = {
    ...heavy,
    generatedAt: live.generatedAt,
    spot: live.spot,
    readings: live.readings,
    contextReadings: live.contextReadings,
    decision: live.decision,
    position: live.position,
    store: live.store,
    journal: live.journal,
    auto: live.auto,
    notes,
    enginePick: chainStale ? { status: "not-applicable", reason } : heavy.enginePick,
    ticket: chainStale ? { open: false, reason, calls: null, puts: null } : heavy.ticket,
  };
  return { snapshot, chainStale };
}
