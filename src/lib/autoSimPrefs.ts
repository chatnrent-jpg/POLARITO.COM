/**
 * Preferences for simulated auto enter/close. Browser-local only.
 * Default: automation ON. Missing or unreadable storage uses that default.
 *
 * useSyncExternalStore contract: getAutoSimPrefs must return the SAME object
 * while the stored value is unchanged, or React loops forever.
 */
export const AUTO_SIM_STORAGE_KEY = "polarito.auto.v1";

export const SIZING_MODES = ["fixed", "risk"] as const;
export type SizingMode = (typeof SIZING_MODES)[number];

export const FILL_MODES = ["next-open", "signal-close"] as const;
export type FillMode = (typeof FILL_MODES)[number];

export type AutoSimPrefs = {
  /** When false, the simulator never auto-enters or auto-closes. */
  enabled: boolean;
  /** Whole shares per entry in "fixed" sizing. */
  quantity: number;
  /** "fixed" = quantity above; "risk" = size from riskPct of equity. */
  sizingMode: SizingMode;
  /** Percent of equity risked per trade in "risk" sizing (0.5 = 0.5%). */
  riskPct: number;
  /**
   * "next-open": act on the last COMPLETED bar's signal, fill at the next bar's open.
   * "signal-close": act on the latest bar's signal, fill at its close (legacy).
   */
  fillMode: FillMode;
};

export const DEFAULT_AUTO_SIM_PREFS: AutoSimPrefs = {
  enabled: true,
  quantity: 10,
  sizingMode: "fixed",
  riskPct: 0.5,
  fillMode: "next-open",
};

export const MIN_QTY = 1;
export const MAX_QTY = 100_000;
export const MIN_RISK_PCT = 0.05;
export const MAX_RISK_PCT = 2;

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

const isMode = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

function parsePrefs(raw: string | null): AutoSimPrefs {
  if (raw === null) return { ...DEFAULT_AUTO_SIM_PREFS };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_AUTO_SIM_PREFS };
    const o = parsed as Record<string, unknown>;
    const d = DEFAULT_AUTO_SIM_PREFS;
    return {
      enabled: o.enabled === true,
      quantity:
        typeof o.quantity === "number" &&
        Number.isSafeInteger(o.quantity) &&
        o.quantity >= MIN_QTY &&
        o.quantity <= MAX_QTY
          ? o.quantity
          : d.quantity,
      sizingMode: isMode(SIZING_MODES, o.sizingMode) ? o.sizingMode : d.sizingMode,
      riskPct:
        typeof o.riskPct === "number" &&
        Number.isFinite(o.riskPct) &&
        o.riskPct >= MIN_RISK_PCT &&
        o.riskPct <= MAX_RISK_PCT
          ? o.riskPct
          : d.riskPct,
      fillMode: isMode(FILL_MODES, o.fillMode) ? o.fillMode : d.fillMode,
    };
  } catch {
    return { ...DEFAULT_AUTO_SIM_PREFS };
  }
}

const sameAs = (a: AutoSimPrefs, b: AutoSimPrefs) =>
  a.enabled === b.enabled &&
  a.quantity === b.quantity &&
  a.sizingMode === b.sizingMode &&
  a.riskPct === b.riskPct &&
  a.fillMode === b.fillMode;

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
    if (!sameAs(next, cachedPrefs)) cachedPrefs = Object.freeze(next);
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
  return writePrefs({ ...getAutoSimPrefs(), enabled: enabled === true });
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
  return writePrefs({ ...getAutoSimPrefs(), quantity });
}

export function setAutoSimSizingMode(mode: string): AutoSimPrefsResult {
  if (!isMode(SIZING_MODES, mode)) return { ok: false, error: "Unknown sizing mode." };
  return writePrefs({ ...getAutoSimPrefs(), sizingMode: mode });
}

export function setAutoSimRiskPct(raw: string): AutoSimPrefsResult {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return { ok: false, error: "Risk percent must be a number, e.g. 0.5." };
  }
  const riskPct = Number(s);
  if (!Number.isFinite(riskPct) || riskPct < MIN_RISK_PCT || riskPct > MAX_RISK_PCT) {
    return {
      ok: false,
      error: `Risk percent must be between ${MIN_RISK_PCT} and ${MAX_RISK_PCT}.`,
    };
  }
  return writePrefs({ ...getAutoSimPrefs(), riskPct });
}

export function setAutoSimFillMode(mode: string): AutoSimPrefsResult {
  if (!isMode(FILL_MODES, mode)) return { ok: false, error: "Unknown fill model." };
  return writePrefs({ ...getAutoSimPrefs(), fillMode: mode });
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
