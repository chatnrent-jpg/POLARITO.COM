/**
 * Multiple simulated accounts. SIMULATED: nothing here touches a broker.
 *
 * Three isolated profiles, each with its own starting balance and its own
 * localStorage entry (positions, trade history, derived cash and P&L live in
 * that entry; see ledger.ts). An account's data is only ever read or written
 * under its own key, so nothing can bleed between accounts.
 *
 * This module owns only: the account definitions, which one is ACTIVE, and the
 * change notifications. Ledger mutations take the account id they were
 * prepared for and are refused if it is no longer the active one.
 *
 * Unidirectional flow: AccountSelector -> setActiveAccountId -> notify ->
 *   useSyncExternalStore consumers (OrderModule, LedgerPanel, AccountSelector)
 *   re-read the active account's ledger.
 */

export const ACCOUNT_IDS = [
  "conservative-swing",
  "aggressive-leverage",
  "tactical-capital",
] as const;

export type AccountId = (typeof ACCOUNT_IDS)[number];

export type AccountDef = {
  id: AccountId;
  name: string;
  initialBalance: number;
};

export const ACCOUNTS: readonly AccountDef[] = Object.freeze([
  Object.freeze({ id: "conservative-swing", name: "Conservative Swing", initialBalance: 100_000 }),
  Object.freeze({ id: "aggressive-leverage", name: "Aggressive Leverage", initialBalance: 250_000 }),
  Object.freeze({ id: "tactical-capital", name: "Tactical Capital", initialBalance: 50_000 }),
]);

export const DEFAULT_ACCOUNT_ID: AccountId = "conservative-swing";

export function isAccountId(v: unknown): v is AccountId {
  return typeof v === "string" && (ACCOUNT_IDS as readonly string[]).includes(v);
}

export function getAccountDef(id: AccountId): AccountDef {
  return ACCOUNTS.find((a) => a.id === id) ?? ACCOUNTS[0];
}

/* -------------------------------------------------------------------------- */
/* Storage keys                                                               */
/* -------------------------------------------------------------------------- */

const ACTIVE_KEY = "polarito.accounts.active.v1";
const LEDGER_PREFIX = "polarito.ledger.v3.";

/** The one storage key an account's profile lives under. */
export function ledgerStorageKey(id: AccountId): string {
  return `${LEDGER_PREFIX}${id}`;
}

/* -------------------------------------------------------------------------- */
/* Active account (external store)                                            */
/* -------------------------------------------------------------------------- */

const listeners = new Set<() => void>();

/** Tell every subscriber (active account or any ledger) to re-read. */
export function notifyAccountsChanged(): void {
  listeners.forEach((l) => l());
}

export function subscribeAccounts(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === ACTIVE_KEY || e.key.startsWith(LEDGER_PREFIX)) listener();
    // legacy single-account keys only ever feed Conservative Swing
    else if (e.key.startsWith("polarito.ledger.")) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Selected account; anything missing or unrecognized falls back to the default. */
export function getActiveAccountId(): AccountId {
  if (typeof window === "undefined") return DEFAULT_ACCOUNT_ID;
  try {
    const raw = window.localStorage.getItem(ACTIVE_KEY);
    return isAccountId(raw) ? raw : DEFAULT_ACCOUNT_ID;
  } catch {
    return DEFAULT_ACCOUNT_ID;
  }
}

export function getServerActiveAccountId(): AccountId {
  return DEFAULT_ACCOUNT_ID;
}

/**
 * Select the account every order and close will execute against.
 * Fails (and changes nothing) if the choice cannot be saved, so the screen
 * never shows one account while the next order lands in another.
 */
export function setActiveAccountId(id: unknown): { ok: true } | { ok: false; error: string } {
  if (!isAccountId(id)) return { ok: false, error: "Unknown account." };
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    return { ok: false, error: "Could not save the account choice to this browser's storage." };
  }
  notifyAccountsChanged();
  return { ok: true };
}
