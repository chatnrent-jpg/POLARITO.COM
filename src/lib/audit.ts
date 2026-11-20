/**
 * Decision audit trail: one structured record for every automated decision,
 * including the decision to do nothing.
 *
 * Pure and server-safe (no storage, no network, no `window`).
 *
 * Justice: a record is only ever built from a decision that has already
 * happened and a result that is already known. Only whitelisted fields are
 * copied and every string is length-capped, so a record can never carry
 * credentials, headers, raw broker payloads or an unbounded error body.
 */
export const AUDIT_VERSION = 1;

export const AUDIT_SOURCES = ["browser-sim", "paper-runner", "options-runner", "mirror-runner", "pick-runner", "live-close", "live-auto"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_OUTCOMES = [
  "entered", // order placed (browser: ledger entry written)
  "closed", // close placed
  "held", // already aligned with the signal
  "aside", // neutral / not enough history, nothing open
  "blocked", // risk guard or safety gate refused the action
  "skipped", // stale / malformed data, nothing done
  "dry-run", // decision computed, nothing sent
  "error", // something failed; the state is NOT assumed to have changed
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export type AuditRecord = {
  v: typeof AUDIT_VERSION;
  /** ISO timestamp the record was created. */
  at: string;
  source: AuditSource;
  ticker: string;
  signalDate: string | null;
  polarity: -1 | 0 | 1 | null;
  ready: boolean | null;
  outcome: AuditOutcome;
  reason: string;
  notes: string[];
  side?: "long" | "short";
  quantity?: number;
  price?: number;
  orderId?: string;
  clientOrderId?: string;
};

export type AuditDraft = {
  source: AuditSource;
  ticker: string;
  signalDate?: string | null;
  polarity?: number | null;
  ready?: boolean | null;
  outcome: AuditOutcome;
  reason: string;
  notes?: readonly string[];
  side?: string;
  quantity?: number;
  price?: number;
  orderId?: string;
  clientOrderId?: string;
};

export const MAX_TEXT = 300;
export const MAX_NOTES = 10;
export const MAX_TICKER = 12;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const clip = (s: unknown, max = MAX_TEXT): string =>
  (typeof s === "string" ? s : String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, max);

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Build a sanitized record. Throws only for programmer errors (unknown source / outcome). */
export function buildAuditRecord(draft: AuditDraft, now: Date = new Date()): AuditRecord {
  if (!(AUDIT_SOURCES as readonly string[]).includes(draft.source)) {
    throw new RangeError("Unknown audit source.");
  }
  if (!(AUDIT_OUTCOMES as readonly string[]).includes(draft.outcome)) {
    throw new RangeError("Unknown audit outcome.");
  }
  const at = Number.isFinite(now.getTime()) ? now.toISOString() : new Date(0).toISOString();
  const record: AuditRecord = {
    v: AUDIT_VERSION,
    at,
    source: draft.source,
    ticker: clip(draft.ticker, MAX_TICKER).toUpperCase() || "?",
    signalDate:
      typeof draft.signalDate === "string" && ISO_DATE.test(draft.signalDate)
        ? draft.signalDate
        : null,
    polarity: draft.polarity === 1 || draft.polarity === -1 || draft.polarity === 0 ? draft.polarity : null,
    ready: typeof draft.ready === "boolean" ? draft.ready : null,
    outcome: draft.outcome,
    reason: clip(draft.reason),
    notes: (draft.notes ?? []).slice(0, MAX_NOTES).map((n) => clip(n)),
  };
  if (draft.side === "long" || draft.side === "short") record.side = draft.side;
  if (finite(draft.quantity) && draft.quantity >= 0) record.quantity = draft.quantity;
  if (finite(draft.price) && draft.price > 0) record.price = draft.price;
  if (typeof draft.orderId === "string" && draft.orderId) record.orderId = clip(draft.orderId, 80);
  if (typeof draft.clientOrderId === "string" && draft.clientOrderId) {
    record.clientOrderId = clip(draft.clientOrderId, 80);
  }
  return record;
}

/** Validate a record read back from storage. Returns null when it is not a valid record. */
export function parseAuditRecord(x: unknown): AuditRecord | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (o.v !== AUDIT_VERSION || typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at))) return null;
  if (typeof o.source !== "string" || typeof o.outcome !== "string") return null;
  if (!Array.isArray(o.notes)) return null;
  try {
    const rebuilt = buildAuditRecord(
      {
        source: o.source as AuditSource,
        ticker: typeof o.ticker === "string" ? o.ticker : "?",
        signalDate: typeof o.signalDate === "string" ? o.signalDate : null,
        polarity: typeof o.polarity === "number" ? o.polarity : null,
        ready: typeof o.ready === "boolean" ? o.ready : null,
        outcome: o.outcome as AuditOutcome,
        reason: typeof o.reason === "string" ? o.reason : "",
        notes: o.notes.filter((n): n is string => typeof n === "string"),
        side: typeof o.side === "string" ? o.side : undefined,
        quantity: typeof o.quantity === "number" ? o.quantity : undefined,
        price: typeof o.price === "number" ? o.price : undefined,
        orderId: typeof o.orderId === "string" ? o.orderId : undefined,
        clientOrderId: typeof o.clientOrderId === "string" ? o.clientOrderId : undefined,
      },
      new Date(o.at),
    );
    return rebuilt;
  } catch {
    return null;
  }
}

/** One JSON line, greppable in server logs (`{"audit":{...}}`). */
export function auditLine(record: AuditRecord): string {
  return JSON.stringify({ audit: record });
}

/** Server sink: structured stdout line. A logging failure never affects trading. */
export function logAudit(record: AuditRecord): void {
  try {
    console.log(auditLine(record));
  } catch {
    /* logging must never break the caller */
  }
}
