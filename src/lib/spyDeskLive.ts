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
};

export async function createLiveDeskDeps(env: Env, now: () => Date = () => new Date(), opts: LiveDeskOptions = {}): Promise<LiveDesk> {
  const cfg = parseEngineConfig(env);
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
  const dailyStart = addCalendarDays(longPeriodStart(etClock(now()).date, "Y"), -45);
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
  const deps: DeskDeps = opts.light
    ? {
        now,
        loadDaily: memoAsync(full.loadDaily, { ttlMs: LIGHT_BARS_TTL_MS, keyOf: () => "daily", cacheable: (r) => r.ok }),
        readSpot: memoAsync(full.readSpot, { ttlMs: LIGHT_QUOTE_TTL_MS, keyOf: () => "spot", cacheable: (r) => r.ok }),
        readSide: async () => {
          throw new Error("The option chain is not read by the light refresh.");
        },
        readHeld: memoAsync(full.readHeld, { ttlMs: LIGHT_QUOTE_TTL_MS, keyOf: (p) => p.symbol, cacheable: (r) => r !== null }),
      }
    : full;
  return { ok: true, deps, config: { timeframe: cfg.config.timeframe, liveBudget: cfg.config.liveBudget } };
}
