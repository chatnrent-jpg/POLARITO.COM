/**
 * Preferences for simulated auto enter/close. Browser-local only.
 * Default: automation ON. Missing or unreadable storage uses that default.
 */
export const AUTO_SIM_STORAGE_KEY = "polarito.auto.v1";

export type AutoSimPrefs = {
  /** When false, the simulator never auto-enters or auto-closes. */
  enabled: boolean;
  /** Whole shares used for each auto entry (Temperance: sized before entry). */
  quantity: number;
};

export const DEFAULT_AUTO_SIM_PREFS: AutoSimPrefs = {
  enabled: true,
  quantity: 10,
};

const MIN_QTY = 1;
const MAX_QTY = 100_000;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export function subscribeAutoSimPrefs(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === AUTO_SIM_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function parsePrefs(raw: string | null): AutoSimPrefs {
  if (raw === null) return { ...DEFAULT_AUTO_SIM_PREFS };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_AUTO_SIM_PREFS };
    const o = parsed as Record<string, unknown>;
    const enabled = o.enabled === true;
    const quantity =
      typeof o.quantity === "number" &&
      Number.isSafeInteger(o.quantity) &&
      o.quantity >= MIN_QTY &&
      o.quantity <= MAX_QTY
        ? o.quantity
        : DEFAULT_AUTO_SIM_PREFS.quantity;
    return { enabled, quantity };
  } catch {
    return { ...DEFAULT_AUTO_SIM_PREFS };
  }
}

/*
 * useSyncExternalStore requires getSnapshot to return the SAME object while the
 * stored value is unchanged; a fresh object per call loops React forever
 * ("This page couldn't load"). Cache by the raw stored string.
 */
const SERVER_SNAPSHOT: AutoSimPrefs = Object.freeze({ ...DEFAULT_AUTO_SIM_PREFS });
let cachedRaw: string | null | undefined;
let cachedPrefs: AutoSimPrefs = SERVER_SNAPSHOT;

export function getAutoSimPrefs(): AutoSimPrefs {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(AUTO_SIM_STORAGE_KEY);
  } catch {
    return SERVER_SNAPSHOT;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    const next = parsePrefs(raw);
    if (next.enabled !== cachedPrefs.enabled || next.quantity !== cachedPrefs.quantity) {
      cachedPrefs = Object.freeze(next);
    }
  }
  return cachedPrefs;
}

export function getServerAutoSimPrefs(): AutoSimPrefs {
  return SERVER_SNAPSHOT;
}

export type AutoSimPrefsResult =
  | { ok: true; prefs: AutoSimPrefs }
  | { ok: false; error: string };

export function setAutoSimEnabled(enabled: boolean): AutoSimPrefsResult {
  const current = getAutoSimPrefs();
  return writePrefs({ ...current, enabled: enabled === true });
}

export function setAutoSimQuantity(raw: string): AutoSimPrefsResult {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) {
    return { ok: false, error: "Auto quantity must be a whole number of shares (1 or more)." };
  }
  const quantity = Number(s);
  if (!Number.isSafeInteger(quantity) || quantity < MIN_QTY) {
    return { ok: false, error: "Auto quantity must be at least 1 share." };
  }
  if (quantity > MAX_QTY) {
    return {
      ok: false,
      error: `Auto quantity cannot exceed ${MAX_QTY.toLocaleString("en-US")} shares.`,
    };
  }
  const current = getAutoSimPrefs();
  return writePrefs({ ...current, quantity });
}

function writePrefs(prefs: AutoSimPrefs): AutoSimPrefsResult {
  try {
    window.localStorage.setItem(AUTO_SIM_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    return {
      ok: false,
      error: "Could not save auto-sim settings to this browser's storage.",
    };
  }
  notify();
  return { ok: true, prefs };
}
