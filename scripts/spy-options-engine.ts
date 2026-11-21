/**
 * DRY RUN of the SPY-only options decision engine. Never submits an order: it only reads market data
 * through src/lib/alpacaReadOnly.ts (GET-only allowlist) and logs what it would do.
 *
 *   npx tsx --env-file=.env.local scripts/spy-options-engine.ts [--write] [--dir=spy-options-dry-run]
 *       [--timeframe=M|Q|H|Y] [--stock-feed=sip|iex]
 *       [--options-feed=indicative|opra] [--live-budget=1000]
 *
 * Without --write nothing is saved (a one-off look). With --write the state (state.json) and an append-only event log
 * (log.jsonl) are saved in --dir, so the next run can log every CHANGE of any reading with its timestamp.
 * Also reads SPY_DECISION_TIMEFRAME / SPY_LIVE_BUDGET from the environment (arguments win).
 * POLARITO_LIVE_TRADING_ENABLED is not read here and nothing in this path can place an order.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DIVIDEND_YIELD, DEFAULT_RISK_FREE_RATE, buildRow } from "../src/lib/optionsSelect";
import { addCalendarDays, etClock } from "../src/lib/marketCalendar";
import { longPeriodStart } from "../src/lib/longPolarity";
import { loadDailyBars } from "../src/lib/spyBars";
import { readSide, readSnapshots, readSpot } from "../src/lib/spyChain";
import { connectAlpaca } from "../src/lib/spyConnect";
import { EMPTY_STATE, ENGINE_SYMBOL, parseEngineConfig, parseEngineState, runEngine, type EngineDeps, type EngineState } from "../src/lib/spyEngine";
import { renderEngineReport } from "../src/lib/spyEngineReport";

const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main(): Promise<void> {
  const env = { ...process.env } as Record<string, string | undefined>;
  if (arg("timeframe")) env.SPY_DECISION_TIMEFRAME = arg("timeframe");
  if (arg("live-budget")) env.SPY_LIVE_BUDGET = arg("live-budget");
  const cfg = parseEngineConfig(env);
  if (!cfg.ok) throw new Error(cfg.error);
  const stockFeed = arg("stock-feed") ?? "sip";
  const optionsFeed = arg("options-feed") ?? "indicative";
  if (stockFeed !== "sip" && stockFeed !== "iex") throw new Error("--stock-feed must be sip or iex");
  if (optionsFeed !== "indicative" && optionsFeed !== "opra") throw new Error("--options-feed must be indicative or opra");
  const dir = arg("dir") ?? "spy-options-dry-run";
  const write = process.argv.includes("--write");

  let previous: EngineState = EMPTY_STATE;
  const stateFile = path.join(dir, "state.json");
  if (fs.existsSync(stateFile)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      throw new Error(`${stateFile} is not valid JSON; refusing to guess a state.`);
    }
    const parsed = parseEngineState(raw);
    if (!parsed.ok) throw new Error(`${stateFile}: ${parsed.error}; refusing to guess a state.`);
    previous = parsed.state;
  }

  const conn = await connectAlpaca(process.env);
  const { client, contractsHost } = conn;
  const model = { rate: DEFAULT_RISK_FREE_RATE, dividendYield: DEFAULT_DIVIDEND_YIELD };
  const now = new Date();
  const dailyStart = addCalendarDays(longPeriodStart(etClock(now).date, "Y"), -45);
  const feeds = stockFeed === "sip" ? ["sip", "iex"] : ["iex"];

  const deps: EngineDeps = {
    now: () => now,
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

  const result = await runEngine(deps, cfg.config, previous);
  const feedNote = stockFeed === "iex" ? "\nNOTE: the IEX feed carries only a small share of consolidated volume, so the net volume magnitude will NOT match a consolidated chart (its sign follows price). Use --stock-feed=sip to compare with the chart.\n" : "";
  const report = renderEngineReport(result, cfg.config) + feedNote;
  console.log(report);

  if (write) {
    fs.mkdirSync(dir, { recursive: true });
    if (result.ok || result.readings) fs.writeFileSync(stateFile, `${JSON.stringify(result.state, null, 2)}\n`);
    fs.appendFileSync(path.join(dir, "log.jsonl"), result.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "latest.md"), report);
  }
  if (!result.ok && result.decision?.action !== "DATA_UNAVAILABLE") process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`spy-options-engine failed: ${e instanceof Error ? e.message : "unknown error"}`);
  process.exit(1);
});
