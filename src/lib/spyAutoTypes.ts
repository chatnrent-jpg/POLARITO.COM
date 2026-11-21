/**
 * Shared shapes for the SPY desk's AUTOMATIC practice trader: the audit-log entry, the on/off switch view and the
 * payload the /spy page receives. Leaf module (no imports from the rest of the desk) so the desk snapshot and the
 * auto runner can both use it. Pure data and strict validators; no IO, no clock.
 *
 * DRY RUN ONLY: nothing here can reach a broker.
 */

export const AUTO_LOG_MAX = 200;
export const AUTO_LOG_SHOWN = 30;

export const AUTO_SCHEDULE_TEXT =
  "Once per weekday after the close (cron at 21:30 UTC, with a 22:30 UTC retry if the first run could not decide). Monthly polarity moves slowly, so one look per day is enough.";

export type AutoOutcome =
  | "off"
  | "skipped"
  | "refused"
  | "hold"
  | "neutral"
  | "no-action"
  | "opened"
  | "closed"
  | "closed-and-opened"
  | "switch-on"
  | "switch-off"
  | "error";

const OUTCOMES: readonly AutoOutcome[] = ["off", "skipped", "refused", "hold", "neutral", "no-action", "opened", "closed", "closed-and-opened", "switch-on", "switch-off", "error"];
export const isAutoOutcome = (v: unknown): v is AutoOutcome => typeof v === "string" && (OUTCOMES as readonly string[]).includes(v);

/**
 * Outcomes that settle a session: once one is logged for an ET date, a second run on that date does nothing (and logs
 * nothing). "closed" (the opposite side could not be opened), "refused", "skipped", "off" and "error" do not settle it, so
 * the retry run may still act.
 */
export const SETTLED_OUTCOMES: readonly AutoOutcome[] = ["opened", "closed-and-opened", "hold", "neutral", "no-action"];

export type AutoLogEntry = {
  id: string;
  at: string;
  /** The ET trading date the run was for. */
  session: string;
  outcome: AutoOutcome;
  /** Plain-language what and why, including "no action" reasons. */
  message: string;
  /** Drive / Reverse / Neutral, or null when no reading could be trusted. */
  reading: string | null;
  symbol: string | null;
  bid: number | null;
  ask: number | null;
  pnlUsd: number | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isFinite(v));
const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";

export function parseAutoLogEntry(raw: unknown): AutoLogEntry | null {
  if (!isRecord(raw)) return null;
  const { id, at, session, outcome, message, reading, symbol, bid, ask, pnlUsd } = raw;
  if (
    typeof id !== "string" ||
    typeof at !== "string" ||
    typeof session !== "string" ||
    !isAutoOutcome(outcome) ||
    typeof message !== "string" ||
    !strOrNull(reading) ||
    !strOrNull(symbol) ||
    !numOrNull(bid) ||
    !numOrNull(ask) ||
    !numOrNull(pnlUsd)
  ) {
    return null;
  }
  return { id, at, session, outcome, message, reading: reading as string | null, symbol: symbol as string | null, bid: bid as number | null, ask: ask as number | null, pnlUsd: pnlUsd as number | null };
}

/** Strict parse of the saved log (a JSON array). A bad entry makes the whole log unreadable: nothing is repaired by guessing. */
export function parseAutoLog(raw: unknown): { ok: true; log: AutoLogEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "The saved Auto log has an unexpected shape." };
  const log: AutoLogEntry[] = [];
  for (const item of raw) {
    const e = parseAutoLogEntry(item);
    if (e === null) return { ok: false, error: "The saved Auto log has a malformed entry." };
    log.push(e);
  }
  return { ok: true, log: log.slice(-AUTO_LOG_MAX) };
}

/** What the /spy page shows about Auto. */
export type AutoView = {
  /** A KV store is configured, so the switch can be read and changed. */
  available: boolean;
  on: boolean;
  /** Why it is off, or a note when on. */
  reason: string;
  /** When the switch last changed (ISO), if known. */
  at: string | null;
  schedule: string;
  /** Newest first. */
  log: AutoLogEntry[];
  logError: string | null;
  /** Neutral reading while a position is held: Auto does nothing, the trader decides. Set by the desk snapshot. */
  banner: string | null;
};

export const AUTO_UNAVAILABLE: AutoView = Object.freeze({
  available: false,
  on: false,
  reason: "No Auto store is configured (KV_REST_API_URL / KV_REST_API_TOKEN), so Auto is OFF and cannot be switched on.",
  at: null,
  schedule: AUTO_SCHEDULE_TEXT,
  log: [],
  logError: null,
  banner: null,
}) as AutoView;

export function isAutoView(v: unknown): v is AutoView {
  return (
    isRecord(v) &&
    typeof v.available === "boolean" &&
    typeof v.on === "boolean" &&
    typeof v.reason === "string" &&
    strOrNull(v.at) &&
    typeof v.schedule === "string" &&
    Array.isArray(v.log) &&
    v.log.every((e) => parseAutoLogEntry(e) !== null) &&
    strOrNull(v.logError) &&
    strOrNull(v.banner)
  );
}
