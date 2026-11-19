/**
 * Browser-local audit trail: a bounded ring buffer in localStorage.
 *
 * useSyncExternalStore contract: getAuditSnapshot returns the SAME array while
 * the stored value is unchanged, or React loops forever (see autoSimPrefs.ts).
 */
import { buildAuditRecord, parseAuditRecord, type AuditDraft, type AuditRecord } from "@/lib/audit";

export const AUDIT_STORAGE_KEY = "polarito.audit.v1";
export const MAX_AUDIT_RECORDS = 500;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function subscribeAudit(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === AUDIT_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function parseAuditStorage(raw: string | null): readonly AuditRecord[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: AuditRecord[] = [];
    for (const item of parsed) {
      const r = parseAuditRecord(item);
      if (r) out.push(r);
    }
    return out.slice(-MAX_AUDIT_RECORDS);
  } catch {
    return [];
  }
}

const EMPTY: readonly AuditRecord[] = Object.freeze([]);
let cachedRaw: string | null | undefined;
let cached: readonly AuditRecord[] = EMPTY;

export function getAuditSnapshot(): readonly AuditRecord[] {
  if (typeof window === "undefined") return EMPTY;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(AUDIT_STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    const next = parseAuditStorage(raw);
    cached = next.length === 0 ? EMPTY : Object.freeze(next);
  }
  return cached;
}

export function getServerAuditSnapshot(): readonly AuditRecord[] {
  return EMPTY;
}

export type AuditWriteResult = { ok: true } | { ok: false; error: string };

/**
 * The dashboard re-evaluates on every refresh; the same decision about the same
 * signal must not be logged over and over.
 */
export function isRepeat(history: readonly AuditRecord[], next: AuditRecord): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.source !== next.source || r.ticker !== next.ticker) continue;
    return (
      r.signalDate === next.signalDate &&
      r.polarity === next.polarity &&
      r.outcome === next.outcome &&
      r.reason === next.reason &&
      r.side === next.side &&
      r.quantity === next.quantity
    );
  }
  return false;
}

/** Append one record, dropping the oldest beyond the cap. A failed write is reported, not hidden. */
export function appendAudit(record: AuditRecord): AuditWriteResult {
  try {
    const current = parseAuditStorage(window.localStorage.getItem(AUDIT_STORAGE_KEY));
    if (isRepeat(current, record)) return { ok: true };
    const next = [...current, record].slice(-MAX_AUDIT_RECORDS);
    window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return { ok: false, error: "Could not save the audit trail to this browser's storage." };
  }
  notify();
  return { ok: true };
}

export function clearAudit(): AuditWriteResult {
  try {
    window.localStorage.removeItem(AUDIT_STORAGE_KEY);
  } catch {
    return { ok: false, error: "Could not clear the audit trail." };
  }
  notify();
  return { ok: true };
}

export function auditToJson(records: readonly AuditRecord[]): string {
  return JSON.stringify(records, null, 2);
}

/** Sanitize and append drafts. Never throws; a failure is returned for the UI to show. */
export function recordDrafts(drafts: readonly AuditDraft[], now: Date = new Date()): AuditWriteResult {
  let failure: AuditWriteResult = { ok: true };
  for (const draft of drafts) {
    try {
      const result = appendAudit(buildAuditRecord(draft, now));
      if (!result.ok) failure = result;
    } catch {
      failure = { ok: false, error: "Could not build an audit record." };
    }
  }
  return failure;
}
