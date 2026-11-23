/**
 * "Analyze" for the SPY desk ticket: loads the daily bars and the monthly gear for the ticker (SPY only) and returns the
 * gear, which side it allows, the monthly net volume and the as-of time. Read-only: it reads market data and writes nothing.
 *
 * The same reading the engine and the ticket route use (deskDecision), so the three can never disagree about the gear.
 * Justice: missing, stale or malformed data is an error, never a guess; the browser checks the shape again before using it.
 */
import { TIMEFRAME_NAMES, isDeskTimeframe, type DeskTimeframe } from "@/lib/deskReadings";
import { deskDecision, isReadingView, readingView, type DeskConfig, type DeskDeps, type ReadingView } from "@/lib/spyDesk";
import { GEARS, TICKER, allowedSides, gearFromAction, isGear, type Gear } from "@/lib/spyGear";

export type Analysis = {
  ok: true;
  dryRun: true;
  kind: "analysis";
  ticker: typeof TICKER;
  generatedAt: string;
  timeframe: DeskTimeframe;
  timeframeName: string;
  gear: Gear;
  allowed: { call: boolean; put: boolean };
  /** The monthly reading behind the gear: raw net volume, as-of time, candle. */
  reading: ReadingView;
  bars: number;
};
export type AnalysisFailure = { ok: false; code: "DATA_UNAVAILABLE" | "INVALID"; error: string; status: number };

/** Null when the ticker may be analysed (SPY, any case, or none given), else why not. */
export function checkTicker(raw: string | null): string | null {
  if (raw === null || raw.trim().toUpperCase() === TICKER) return null;
  return `Only ${TICKER} can be analysed here.`;
}

/** Never throws. */
export async function buildAnalysis(deps: DeskDeps, config: DeskConfig): Promise<Analysis | AnalysisFailure> {
  try {
    const now = deps.now();
    const dailyRes = await deps.loadDaily();
    if (!dailyRes.ok) return { ok: false, code: "DATA_UNAVAILABLE", error: `Data unavailable: daily bars could not be read (${dailyRes.error}). No gear is shown.`, status: 503 };
    const decision = deskDecision(dailyRes.value, now, config.timeframe);
    if (decision.status === "unavailable") {
      return { ok: false, code: "DATA_UNAVAILABLE", error: `Data unavailable for the ${TIMEFRAME_NAMES[config.timeframe]} reading: ${decision.reason}. No gear is shown.`, status: 503 };
    }
    const gear = gearFromAction(decision.action);
    if (gear === null) return { ok: false, code: "DATA_UNAVAILABLE", error: "Data unavailable: the reading gave no gear. No gear is shown.", status: 503 };
    return {
      ok: true,
      dryRun: true,
      kind: "analysis",
      ticker: TICKER,
      generatedAt: now.toISOString(),
      timeframe: config.timeframe,
      timeframeName: TIMEFRAME_NAMES[config.timeframe],
      gear,
      allowed: allowedSides(gear),
      reading: readingView(decision.reading, true),
      bars: dailyRes.value.length,
    };
  } catch {
    return { ok: false, code: "DATA_UNAVAILABLE", error: "Data unavailable: unexpected error while loading the gear. No gear is shown.", status: 500 };
  }
}

/** Strict shape check run in the browser before the gear is used or drawn. */
export function parseAnalysis(raw: unknown): { ok: true; analysis: Analysis } | { ok: false; error: string } {
  const bad = (what: string) => ({ ok: false as const, error: `The gear came in an unexpected shape (${what}). It was not used.` });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not an object");
  const r = raw as Record<string, unknown>;
  if (r.ok !== true || r.dryRun !== true || r.kind !== "analysis") return bad("header");
  if (r.ticker !== TICKER) return bad("ticker");
  if (typeof r.generatedAt !== "string" || Number.isNaN(Date.parse(r.generatedAt))) return bad("time");
  if (!isDeskTimeframe(r.timeframe) || typeof r.timeframeName !== "string") return bad("timeframe");
  if (!isGear(r.gear) || !GEARS.includes(r.gear)) return bad("gear");
  const allowed = r.allowed as { call?: unknown; put?: unknown } | null;
  const expected = allowedSides(r.gear);
  if (typeof allowed !== "object" || allowed === null || allowed.call !== expected.call || allowed.put !== expected.put) return bad("allowed sides do not match the gear");
  if (!isReadingView(r.reading)) return bad("reading");
  const reading = r.reading as ReadingView;
  if (reading.status !== "ok" || reading.timeframe !== r.timeframe) return bad("reading does not match");
  if (typeof r.bars !== "number" || !Number.isFinite(r.bars) || r.bars <= 0) return bad("bars");
  return { ok: true, analysis: r as unknown as Analysis };
}
