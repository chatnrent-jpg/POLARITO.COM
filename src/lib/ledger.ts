/**
 * Mock, local-only trading ledger. SIMULATED: nothing here touches a broker.
 *
 * Model
 *   - An order fill (`LedgerEntry`) opens a position, or adds to the open
 *     position on the same ticker and side (quantity adds, entry price is the
 *     quantity-weighted average).
 *   - `closeActivePosition` realizes P&L, releases the reserved notional, and
 *     moves the closed quantity to the trade history.
 *   - Balances are DERIVED from the persisted positions + history, so they can
 *     never drift out of sync with them:
 *         cash available = starting cash + realized P&L - reserved notional
 *     A `balances` summary is also written alongside on every change.
 *   - A ticker cannot be long and short at once. Opposite-side orders are
 *     refused until the open position is closed.
 *
 * Storage: browser localStorage, exposed as an external store for
 * useSyncExternalStore. Every access is wrapped in try/catch; a failed write
 * is reported as a failure, never as success.
 */
import {
  ACCOUNTS,
  DEFAULT_ACCOUNT_ID,
  getAccountDef,
  getActiveAccountId,
  ledgerStorageKey,
  notifyAccountsChanged,
  subscribeAccounts,
  type AccountId,
} from "@/lib/multiAccount";
import { isOrderSide, type OrderSide } from "@/lib/orderGuard";
import type { Polarity } from "@/lib/polarity";
import { normalizeTicker } from "@/lib/ticker";

/**
 * Multi-account: every account has its own ledger under its own storage key
 * (see multiAccount.ts). Reads and writes below always name an account.
 * Mutations are executed against an `accountId` supplied by the caller and are
 * refused unless it is still the ACTIVE account, so an order or close prepared
 * on one account can never land on another.
 */

/** Pre-multi-account storage: a single $100,000 ledger. Feeds Conservative Swing only. */
const LEGACY_V2_KEY = "polarito.ledger.v2";
const LEGACY_KEY = "polarito.ledger.v1"; // flat list of fills, migrated on read
const LEGACY_ACCOUNT: AccountId = "conservative-swing";
const MAX_POSITIONS = 200;
const MAX_CLOSED = 1000;

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** One order fill (the payload OrderModule sends). */
export type LedgerEntry = {
  id: string;
  createdAt: string; // ISO timestamp
  simulated: true;
  ticker: string;
  side: OrderSide;
  quantity: number;
  /** Simulated fill = the engine's latest daily close. */
  price: number;
  priceBasis: "last daily close";
  /** Session date of that close, YYYY-MM-DD. */
  priceDate: string;
  polarityAtEntry: Polarity;
  notional: number;
};

/** An open position block (one per ticker and side). */
export type Position = {
  ticker: string;
  side: OrderSide;
  quantity: number;
  /** Quantity-weighted average entry price. */
  avgPrice: number;
  openedAt: string;
  updatedAt: string;
  /** Number of fills merged into this block. */
  fills: number;
  polarityAtEntry: Polarity;
};

export type ClosedTrade = {
  id: string;
  simulated: true;
  ticker: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  /** Session date of the exit close, YYYY-MM-DD. */
  exitDate: string;
  openedAt: string;
  closedAt: string;
  realizedPnl: number;
};

export type LedgerState = {
  positions: readonly Position[];
  closed: readonly ClosedTrade[];
};

export type LedgerResult = { ok: true } | { ok: false; error: string };
export type CloseResult =
  | { ok: true; trade: ClosedTrade; released: number }
  | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

const round2 = (n: number) => Math.round(n * 100) / 100;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isGear = (v: unknown): v is Polarity => v === 1 || v === -1 || v === 0;

export function positionNotional(p: Position): number {
  return p.quantity * p.avgPrice;
}

export function positionPnl(p: Position, mark: number): number {
  const diff = p.side === "long" ? mark - p.avgPrice : p.avgPrice - mark;
  return diff * p.quantity;
}

function isEntry(x: unknown): x is LedgerEntry {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.createdAt === "string" &&
    e.simulated === true &&
    typeof e.ticker === "string" &&
    isOrderSide(e.side) &&
    isNum(e.quantity) &&
    Number.isSafeInteger(e.quantity) &&
    e.quantity > 0 &&
    isNum(e.price) &&
    e.price > 0 &&
    e.priceBasis === "last daily close" &&
    isDate(e.priceDate) &&
    (e.polarityAtEntry === 1 || e.polarityAtEntry === -1) &&
    isNum(e.notional)
  );
}

function isPosition(x: unknown): x is Position {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.ticker === "string" &&
    isOrderSide(p.side) &&
    isNum(p.quantity) &&
    Number.isSafeInteger(p.quantity) &&
    p.quantity > 0 &&
    isNum(p.avgPrice) &&
    p.avgPrice > 0 &&
    typeof p.openedAt === "string" &&
    typeof p.updatedAt === "string" &&
    isNum(p.fills) &&
    isGear(p.polarityAtEntry)
  );
}

function isClosedTrade(x: unknown): x is ClosedTrade {
  if (typeof x !== "object" || x === null) return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    t.simulated === true &&
    typeof t.ticker === "string" &&
    isOrderSide(t.side) &&
    isNum(t.quantity) &&
    t.quantity > 0 &&
    isNum(t.entryPrice) &&
    isNum(t.exitPrice) &&
    isDate(t.exitDate) &&
    typeof t.openedAt === "string" &&
    typeof t.closedAt === "string" &&
    isNum(t.realizedPnl)
  );
}

/** Merge a fill into a copy of `positions` (add to same ticker+side, else new block). */
function applyFill(positions: readonly Position[], e: LedgerEntry): Position[] {
  const next = positions.map((p) => ({ ...p }));
  const existing = next.find((p) => p.ticker === e.ticker && p.side === e.side);
  if (existing) {
    const qty = existing.quantity + e.quantity;
    existing.avgPrice = (existing.quantity * existing.avgPrice + e.quantity * e.price) / qty;
    existing.quantity = qty;
    existing.updatedAt = e.createdAt;
    existing.fills += 1;
  } else {
    next.push({
      ticker: e.ticker,
      side: e.side,
      quantity: e.quantity,
      avgPrice: e.price,
      openedAt: e.createdAt,
      updatedAt: e.createdAt,
      fills: 1,
      polarityAtEntry: e.polarityAtEntry,
    });
  }
  return next;
}

/** Whether `side` may be opened on `ticker` (no simultaneous long and short). */
export function canOpen(
  state: LedgerState,
  ticker: string,
  side: OrderSide,
): { ok: true } | { ok: false; error: string } {
  const opposing = state.positions.find((p) => p.ticker === ticker && p.side !== side);
  if (opposing) {
    return {
      ok: false,
      error: `You already hold an open ${opposing.side.toUpperCase()} in ${ticker}. Close it before opening a ${side.toUpperCase()}.`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Account (derived)                                                          */
/* -------------------------------------------------------------------------- */

export type Account = {
  /** The account's own initial balance. */
  startingCash: number;
  /** Notional reserved by open positions (long and short alike). */
  reserved: number;
  cashAvailable: number;
  realizedPnl: number;
  /** Sum of P&L over open positions whose ticker has a known latest close. */
  unrealizedPnl: number;
  /** Open positions with no current close to mark against. */
  unmarked: number;
  /** startingCash + realized + unrealized. Excludes unmarked positions. */
  equity: number;
};

/** `marks` maps ticker -> latest daily close. */
export function computeAccount(
  state: LedgerState,
  marks: Readonly<Record<string, number>>,
  startingCash: number,
): Account {
  let reserved = 0;
  let unrealizedPnl = 0;
  let unmarked = 0;
  for (const p of state.positions) {
    reserved += positionNotional(p);
    const mark = marks[p.ticker];
    if (isNum(mark)) unrealizedPnl += positionPnl(p, mark);
    else unmarked += 1;
  }
  let realizedPnl = 0;
  for (const t of state.closed) realizedPnl += t.realizedPnl;

  return {
    startingCash,
    reserved,
    cashAvailable: startingCash + realizedPnl - reserved,
    realizedPnl,
    unrealizedPnl,
    unmarked,
    equity: startingCash + realizedPnl + unrealizedPnl,
  };
}

/* -------------------------------------------------------------------------- */
/* Storage + external store                                                   */
/* -------------------------------------------------------------------------- */
const EMPTY: LedgerState = Object.freeze({
  positions: Object.freeze([]) as readonly Position[],
  closed: Object.freeze([]) as readonly ClosedTrade[],
});

function getItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parseV2(raw: string): LedgerState {
  try {
    const data = JSON.parse(raw) as { positions?: unknown; closed?: unknown };
    return {
      positions: Array.isArray(data.positions) ? data.positions.filter(isPosition) : [],
      closed: Array.isArray(data.closed) ? data.closed.filter(isClosedTrade) : [],
    };
  } catch {
    return EMPTY;
  }
}

/** v1 stored a flat list of fills. Fold them into position blocks. */
function migrateV1(raw: string): LedgerState {
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return EMPTY;
    let positions: Position[] = [];
    for (const e of data) if (isEntry(e)) positions = applyFill(positions, e);
    return { positions, closed: [] };
  } catch {
    return EMPTY;
  }
}

/**
 * One account's state, read ONLY from that account's own key. The single
 * exception is the pre-multi-account ledger, which is read (never rewritten)
 * as Conservative Swing's data until that account saves for the first time.
 */
function readAccountState(id: AccountId): { state: LedgerState; sig: string } {
  const own = getItem(ledgerStorageKey(id));
  if (own !== null) return { state: parseV2(own), sig: `3:${own}` };
  if (id === LEGACY_ACCOUNT) {
    const v2 = getItem(LEGACY_V2_KEY);
    if (v2 !== null) return { state: parseV2(v2), sig: `2:${v2}` };
    const v1 = getItem(LEGACY_KEY);
    if (v1 !== null) return { state: migrateV1(v1), sig: `1:${v1}` };
  }
  return { state: EMPTY, sig: "0" };
}

/** The ACTIVE account's ledger, tagged with which account it is. */
export type LedgerSnapshot = LedgerState & { readonly accountId: AccountId };

const SERVER_SNAPSHOT: LedgerSnapshot = Object.freeze({
  ...EMPTY,
  accountId: DEFAULT_ACCOUNT_ID,
});

let cachedSig: string | undefined;
let cachedSnapshot: LedgerSnapshot = SERVER_SNAPSHOT;

export function getLedgerSnapshot(): LedgerSnapshot {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  const accountId = getActiveAccountId();
  const { state, sig } = readAccountState(accountId);
  const full = `${accountId}|${sig}`;
  if (full !== cachedSig) {
    cachedSig = full;
    cachedSnapshot = { positions: state.positions, closed: state.closed, accountId };
  }
  return cachedSnapshot;
}

export function getServerLedgerSnapshot(): LedgerSnapshot {
  return SERVER_SNAPSHOT;
}

/** Every account's ledger, for the selector's equity read-outs. */
export type AccountsOverview = Readonly<Record<AccountId, LedgerState>>;

const SERVER_OVERVIEW = Object.freeze(
  Object.fromEntries(ACCOUNTS.map((a) => [a.id, EMPTY])),
) as AccountsOverview;

let overviewSig: string | undefined;
let overviewCache: AccountsOverview = SERVER_OVERVIEW;

export function getAccountsOverviewSnapshot(): AccountsOverview {
  if (typeof window === "undefined") return SERVER_OVERVIEW;
  const reads = ACCOUNTS.map((a) => ({ id: a.id, ...readAccountState(a.id) }));
  const sig = reads.map((r) => `${r.id}=${r.sig}`).join("\u0000");
  if (sig !== overviewSig) {
    overviewSig = sig;
    overviewCache = Object.fromEntries(reads.map((r) => [r.id, r.state])) as AccountsOverview;
  }
  return overviewCache;
}

export function getServerAccountsOverview(): AccountsOverview {
  return SERVER_OVERVIEW;
}

/** Re-render subscribers when the active account or any account's ledger changes. */
export const subscribeLedger = subscribeAccounts;

const emit = notifyAccountsChanged;

/** Persist one account's state + a balances summary. Throws if storage is unavailable. */
function persist(id: AccountId, state: LedgerState): void {
  const def = getAccountDef(id);
  const acct = computeAccount(state, {}, def.initialBalance);
  window.localStorage.setItem(
    ledgerStorageKey(id),
    JSON.stringify({
      version: 3,
      accountId: id,
      positions: state.positions,
      closed: state.closed,
      balances: {
        startingCash: acct.startingCash,
        cashAvailable: acct.cashAvailable,
        reserved: acct.reserved,
        realizedPnl: acct.realizedPnl,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

/** The account a caller prepared work for must still be the active one. */
function checkActive(accountId: AccountId): LedgerResult {
  if (accountId !== getActiveAccountId()) {
    return {
      ok: false,
      error: "The active account changed. Nothing was recorded. Review and try again.",
    };
  }
  return { ok: true };
}

const STORAGE_FAIL =
  "Could not save to this browser's storage, so the change was NOT recorded.";

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Open a position, or add to the open one on the same ticker and side, in
 * `accountId` only. Refused unless that is still the active account.
 */
export function addLedgerEntry(entry: LedgerEntry, accountId: AccountId): LedgerResult {
  if (!isEntry(entry)) return { ok: false, error: "Order payload failed validation." };
  const active = checkActive(accountId);
  if (!active.ok) return active;
  try {
    const { state } = readAccountState(accountId); // fresh read: other tabs may have written
    const allowed = canOpen(state, entry.ticker, entry.side);
    if (!allowed.ok) return allowed;
    if (
      state.positions.length >= MAX_POSITIONS &&
      !state.positions.some((p) => p.ticker === entry.ticker && p.side === entry.side)
    ) {
      return { ok: false, error: "Too many open positions." };
    }
    // Funds are checked against THIS account's own balance, not whichever the UI last showed.
    const funds = computeAccount(state, {}, getAccountDef(accountId).initialBalance);
    if (entry.quantity * entry.price > funds.cashAvailable) {
      return {
        ok: false,
        error: `Order exceeds ${getAccountDef(accountId).name} cash available (${funds.cashAvailable.toLocaleString("en-US", { style: "currency", currency: "USD" })}).`,
      };
    }
    persist(accountId, { positions: applyFill(state.positions, entry), closed: state.closed });
  } catch {
    return { ok: false, error: STORAGE_FAIL };
  }
  emit();
  return { ok: true };
}

/**
 * Close (all or part of) an open position and realize P&L.
 *
 *   Long : realized = (exitPrice - entryPrice) * quantity
 *   Short: realized = (entryPrice - exitPrice) * quantity
 *
 * Reserved notional (quantity * entryPrice) is released and cash changes by
 * that notional plus the realized P&L (see `computeAccount`).
 *
 * A ticker holds at most one open position when orders go through
 * OrderModule. `opts.side` disambiguates legacy data that has both.
 */
export function closeActivePosition(
  ticker: string,
  quantity: number,
  exitPrice: number,
  opts: { accountId: AccountId; side?: OrderSide; exitDate?: string },
): CloseResult {
  // Executes against opts.accountId only, and only while it is the active account.
  const active = checkActive(opts.accountId);
  if (!active.ok) return active;
  const sym = normalizeTicker(ticker);
  if (!sym) return { ok: false, error: "Invalid ticker." };
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return { ok: false, error: "Close quantity must be a whole number of shares, 1 or more." };
  }
  if (!isNum(exitPrice) || exitPrice <= 0) {
    return { ok: false, error: "Exit price must be a positive number." };
  }
  const exitDate = opts.exitDate ?? new Date().toISOString().slice(0, 10);
  if (!isDate(exitDate)) return { ok: false, error: "Exit date must be YYYY-MM-DD." };

  let trade: ClosedTrade;
  let released: number;
  try {
    const { state } = readAccountState(opts.accountId);
    const matches = state.positions.filter(
      (p) => p.ticker === sym && (opts.side === undefined || p.side === opts.side),
    );
    if (matches.length === 0) return { ok: false, error: `No open position in ${sym}.` };
    if (matches.length > 1) {
      return { ok: false, error: `${sym} has more than one open position; specify the side.` };
    }
    const pos = matches[0];
    if (quantity > pos.quantity) {
      return {
        ok: false,
        error: `Cannot close ${quantity} shares; only ${pos.quantity} are open in ${sym}.`,
      };
    }

    const gross =
      pos.side === "long"
        ? (exitPrice - pos.avgPrice) * quantity
        : (pos.avgPrice - exitPrice) * quantity;
    released = quantity * pos.avgPrice;
    trade = {
      id: newEntryId(),
      simulated: true,
      ticker: sym,
      side: pos.side,
      quantity,
      entryPrice: pos.avgPrice,
      exitPrice,
      exitDate,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
      realizedPnl: round2(gross),
    };

    const positions = state.positions.flatMap((p) => {
      if (p.ticker !== pos.ticker || p.side !== pos.side) return [p];
      const left = p.quantity - quantity;
      return left > 0 ? [{ ...p, quantity: left, updatedAt: trade.closedAt }] : [];
    });
    persist(opts.accountId, { positions, closed: [...state.closed, trade].slice(-MAX_CLOSED) });
  } catch {
    return { ok: false, error: STORAGE_FAIL };
  }
  emit();
  return { ok: true, trade, released };
}

/**
 * Reset ONE account to its initial balance. The other accounts are untouched.
 * An empty profile is written (not just removed) so that a cleared Conservative
 * Swing is not re-filled from the pre-multi-account legacy data.
 */
export function clearLedger(accountId: AccountId): LedgerResult {
  const active = checkActive(accountId);
  if (!active.ok) return active;
  try {
    persist(accountId, EMPTY);
  } catch {
    return { ok: false, error: "Could not clear this browser's storage." };
  }
  emit();
  return { ok: true };
}

export function newEntryId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
