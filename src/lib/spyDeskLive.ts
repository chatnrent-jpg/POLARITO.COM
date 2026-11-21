/**
 * Real read-only data for the SPY desk: the same Alpaca wiring the dry-run engine script uses (alpacaReadOnly.ts is
 * GET-only on a fixed allowlist, so no order endpoint is reachable). Keys come from server env and go out as headers only.
 */
import { DEFAULT_DIVIDEND_YIELD, DEFAULT_RISK_FREE_RATE, buildRow } from "@/lib/optionsSelect";
import { addCalendarDays, etClock } from "@/lib/marketCalendar";
import { longPeriodStart } from "@/lib/longPolarity";
import { loadDailyBars } from "@/lib/spyBars";
import { readSide, readSnapshots, readSpot } from "@/lib/spyChain";
import { connectAlpaca } from "@/lib/spyConnect";
import type { DeskConfig, DeskDeps } from "@/lib/spyDesk";
import { ENGINE_SYMBOL, parseEngineConfig } from "@/lib/spyEngine";

type Env = Readonly<Record<string, string | undefined>>;
export type LiveDesk = { ok: true; deps: DeskDeps; config: DeskConfig } | { ok: false; code: "CONFIG" | "NO_KEYS"; error: string };

export async function createLiveDeskDeps(env: Env, now: () => Date = () => new Date()): Promise<LiveDesk> {
  const cfg = parseEngineConfig(env);
  if (!cfg.ok) return { ok: false, code: "CONFIG", error: cfg.error };
  const stockFeed = (env.SPY_STOCK_FEED ?? "sip").trim();
  const optionsFeed = (env.SPY_OPTIONS_FEED ?? "indicative").trim();
  if (stockFeed !== "sip" && stockFeed !== "iex") return { ok: false, code: "CONFIG", error: "SPY_STOCK_FEED must be sip or iex." };
  if (optionsFeed !== "indicative" && optionsFeed !== "opra") return { ok: false, code: "CONFIG", error: "SPY_OPTIONS_FEED must be indicative or opra." };

  let conn;
  try {
    conn = await connectAlpaca(env);
  } catch (e) {
    return { ok: false, code: "NO_KEYS", error: e instanceof Error ? e.message : "No Alpaca data keys are configured." };
  }
  const { client, contractsHost } = conn;
  const model = { rate: DEFAULT_RISK_FREE_RATE, dividendYield: DEFAULT_DIVIDEND_YIELD };
  const dailyStart = addCalendarDays(longPeriodStart(etClock(now()).date, "Y"), -45);
  const feeds = stockFeed === "sip" ? ["sip", "iex"] : ["iex"];

  const deps: DeskDeps = {
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
  return { ok: true, deps, config: { timeframe: cfg.config.timeframe, liveBudget: cfg.config.liveBudget } };
}
