/**
 * Real read-only data for the SPY desk: the same Alpaca wiring the dry-run engine script uses (alpacaReadOnly.ts is
 * GET-only on a fixed allowlist, so no order endpoint is reachable). Keys come from server env and go out as headers only.
 */
import { DEFAULT_DIVIDEND_YIELD, DEFAULT_RISK_FREE_RATE, buildRow } from "@/lib/optionsSelect";
import { addCalendarDays, etClock } from "@/lib/marketCalendar";
import { longPeriodStart } from "@/lib/longPolarity";
import { loadDailyBars } from "@/lib/spyBars";
import { readSide, readSnapshots, readSpot } from "@/lib/spyChain";
import { connectAlpaca, type Connection } from "@/lib/spyConnect";
import { memoAsync } from "@/lib/spyTtlCache";
import type { DeskConfig, DeskDeps } from "@/lib/spyDesk";
import { ENGINE_SYMBOL, parseEngineConfig } from "@/lib/spyEngine";
import { MONTHLY_PROFILE, type DeskProfile } from "@/lib/spyProfile";
import { WWV_HISTORY_CALENDAR_DAYS } from "@/lib/wwv";

type Env = Readonly<Record<string, string | undefined>>;
export type LiveDesk = { ok: true; deps: DeskDeps; config: DeskConfig } | { ok: false; code: "CONFIG" | "NO_KEYS"; error: string };

/** Light view cache lifetimes: bars barely change in seconds, the last trade and one contract snapshot are re-read at most every 2 s. */
export const LIGHT_BARS_TTL_MS = 15_000;
export const LIGHT_QUOTE_TTL_MS = 2_000;
const CONNECTION_TTL_MS = 5 * 60_000;

let connection: { at: number; promise: Promise<Connection> } | null = null;

/** The Alpaca connection (which key set answers) is the same for every request, so it is probed once per few minutes, not per request. */
function sharedConnection(env: Env): Promise<Connection> {
  if (connection && Date.now() - connection.at < CONNECTION_TTL_MS) return connection.promise;
  const promise = connectAlpaca(env);
  connection = { at: Date.now(), promise };
  promise.then(
    (c) => {
      if (c.accountHost === null && connection?.promise === promise) connection = null;
    },
    () => {
      if (connection?.promise === promise) connection = null;
    },
  );
  return promise;
}

export type LiveDeskOptions = {
  /** The 5 s refresh: short caches, and the option chain is unreachable (readSide throws), so it cannot be hit by mistake. */
  light?: boolean;
  /** Which desk (decision source) the data is for. Default: the monthly desk. */
  profile?: DeskProfile;
};

type Cached = { loadDaily: DeskDeps["loadDaily"]; readSpot: DeskDeps["readSpot"]; readHeld: DeskDeps["readHeld"] };

/**
 * The light refresh caches live in module scope, so they are shared by every request this server instance answers (a cache
 * built per request would never be hit). One entry per connection and data setup, so a key rotation or feed change cannot
 * serve data read under another setup. Only good answers are kept, for seconds; nothing is written anywhere.
 */
const lightCaches = new WeakMap<Connection, Map<string, Cached>>();

export function lightCacheFor(conn: Connection, key: string, make: () => Cached): Cached {
  let byKey = lightCaches.get(conn);
  if (!byKey) {
    byKey = new Map();
    lightCaches.set(conn, byKey);
  }
  let hit = byKey.get(key);
  if (!hit) {
    hit = make();
    byKey.set(key, hit);
  }
  return hit;
}

/** First calendar day of the daily bars to load: enough sessions for the period readings (year-to-date plus the one before); the WWV desk loads the longer of that and its own window (it shows the period readings as context, and its decision reads only its own window). */
export function dailyStartFor(profile: DeskProfile, today: string): string {
  const periods = addCalendarDays(longPeriodStart(today, "Y"), -45);
  if (profile.fixedTimeframe !== "D") return periods;
  const wwv = addCalendarDays(today, -WWV_HISTORY_CALENDAR_DAYS);
  return wwv < periods ? wwv : periods;
}

export async function createLiveDeskDeps(env: Env, now: () => Date = () => new Date(), opts: LiveDeskOptions = {}): Promise<LiveDesk> {
  const profile = opts.profile ?? MONTHLY_PROFILE;
  const cfg = parseEngineConfig(env, profile.fixedTimeframe);
  if (!cfg.ok) return { ok: false, code: "CONFIG", error: cfg.error };
  const stockFeed = (env.SPY_STOCK_FEED ?? "sip").trim();
  const optionsFeed = (env.SPY_OPTIONS_FEED ?? "indicative").trim();
  if (stockFeed !== "sip" && stockFeed !== "iex") return { ok: false, code: "CONFIG", error: "SPY_STOCK_FEED must be sip or iex." };
  if (optionsFeed !== "indicative" && optionsFeed !== "opra") return { ok: false, code: "CONFIG", error: "SPY_OPTIONS_FEED must be indicative or opra." };

  let conn;
  try {
    conn = await sharedConnection(env);
  } catch (e) {
    return { ok: false, code: "NO_KEYS", error: e instanceof Error ? e.message : "No Alpaca data keys are configured." };
  }
  const { client, contractsHost } = conn;
  const model = { rate: DEFAULT_RISK_FREE_RATE, dividendYield: DEFAULT_DIVIDEND_YIELD };
  const dailyStart = dailyStartFor(profile, etClock(now()).date);
  const feeds = stockFeed === "sip" ? ["sip", "iex"] : ["iex"];

  const full: DeskDeps = {
    now,
    loadDaily: () => loadDailyBars(client, ENGINE_SYMBOL, dailyStart, stockFeed),
    readSpot: () => readSpot(client, ENGINE_SYMBOL, feeds),
    readSide: (type, spot, today, at) => readSide(client, type, { symbol: ENGINE_SYMBOL, today, now: at, spot, optionsFeed, contractsHost, model }),
    readHeld: async (p, spot, today, at) => {
      const res = await readSnapshots(client, ENGINE_SYMBOL, p.type, p.expiration, p.strike, p.strike, optionsFeed);
      if (!res.ok) return null;
      const raw = res.value.find((r) => r.symbol === p.symbol);
      if (!raw) return null;
      const row = buildRow(raw, spot, today, at, model);
      return row.ok ? row.row : null;
    },
  };
  let deps: DeskDeps = full;
  if (opts.light) {
    const cached = lightCacheFor(conn, `${stockFeed}|${optionsFeed}|${dailyStart}`, () => ({
      loadDaily: memoAsync(full.loadDaily, { ttlMs: LIGHT_BARS_TTL_MS, keyOf: () => `daily|${profile.id}`, cacheable: (r) => r.ok }),
      readSpot: memoAsync(full.readSpot, { ttlMs: LIGHT_QUOTE_TTL_MS, keyOf: () => "spot", cacheable: (r) => r.ok }),
      readHeld: memoAsync(full.readHeld, { ttlMs: LIGHT_QUOTE_TTL_MS, keyOf: (p) => p.symbol, cacheable: (r) => r !== null }),
    }));
    deps = {
      now,
      loadDaily: cached.loadDaily,
      readSpot: cached.readSpot,
      readSide: async () => {
        throw new Error("The option chain is not read by the light refresh.");
      },
      readHeld: cached.readHeld,
    };
  }
  return { ok: true, deps, config: { timeframe: cfg.config.timeframe, liveBudget: cfg.config.liveBudget } };
}
