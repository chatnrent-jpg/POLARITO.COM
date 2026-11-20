/**
 * Server-side options cycle (paper only). Runs after the US close, once per
 * session, in place of the stock cycle when POLARITO_PAPER_INSTRUMENT=options.
 *
 * State flow (one direction): daily bars -> polarity -> wanted option type
 * (+1 call, -1 put, else none) -> compare with the broker's ACTUAL option
 * positions -> at most one order per ticker -> one audit record.
 *
 * One option per ticker at a time. Entries are long-dated (>= 365 days),
 * bought at the ask with a limit order; exits are sold at the bid (or at
 * market when no usable quote exists, because a close is never blocked).
 *
 * Virtues:
 *   Wisdom     - Neutral / unready / stale data => no option held.
 *   Courage    - a valid decision is sent with no human step in the path.
 *   Temperance - premium is the whole risk; per-position and cash caps and the
 *                daily loss halt are checked BEFORE the order; closes are never blocked.
 *   Justice    - stale or malformed bars, contracts or quotes mean NO order;
 *                every outcome is audited truthfully.
 */
import { buildAuditRecord, type AuditDraft, type AuditRecord } from "@/lib/audit";
import { buildAutoSimInput, isStale } from "@/lib/autoDecision";
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import {
  CONTRACT_MULTIPLIER,
  MAX_OPTION_CONTRACTS,
  MAX_SPREAD_PCT,
  MIN_EXPIRY_DAYS,
  ROLL_WITHIN_DAYS,
  addDays,
  buyLimit,
  checkQuote,
  daysBetween,
  describeContract,
  optionTypeForPolarity,
  parseOccSymbol,
  pickContract,
  sellLimit,
  type OptionType,
  type OptionsBroker,
} from "@/lib/broker/options";
import { optionClientOrderId, optionPositionsFor, placeOptionIntent } from "@/lib/broker/optionsExecute";
import { completedBars, newYorkClock, paperRunnerSettings, type RunReport, type TickerReport } from "@/lib/paperRunner";
import { computePolaritySeries, type Bar } from "@/lib/polarity";
import { DEFAULT_RISK_CONFIG } from "@/lib/risk";

/** Strike search window around the underlying price. */
const STRIKE_WINDOW = 0.1;
/** Expiries searched beyond the minimum, so the nearest long-dated one is always inside the window. */
const EXPIRY_WINDOW_DAYS = 400;
/** One option position may cost at most this share of equity. */
export const MAX_PREMIUM_PCT_OF_EQUITY = 0.1;

export type OptionsSettings = { watchlist: string[]; contracts: number };

export function optionsRunnerSettings(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; settings: OptionsSettings } | { ok: false; error: string } {
  const base = paperRunnerSettings(env);
  if (!base.ok) return base;
  const contracts = Number((env.POLARITO_OPTIONS_CONTRACTS ?? "1").trim());
  if (!Number.isSafeInteger(contracts) || contracts < 1 || contracts > MAX_OPTION_CONTRACTS) {
    return { ok: false, error: `POLARITO_OPTIONS_CONTRACTS must be a whole number from 1 to ${MAX_OPTION_CONTRACTS}.` };
  }
  return { ok: true, settings: { watchlist: base.settings.watchlist, contracts } };
}

export type OptionsRunnerDeps = {
  broker: OptionsBroker;
  config: PaperBrokerConfig;
  loadBars: (ticker: string) => Promise<Bar[]>;
  audit: (record: AuditRecord) => void;
  now?: () => Date;
};

const sideOf = (t: OptionType): "long" | "short" => (t === "call" ? "long" : "short");
const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

export async function runOptionsCycle(
  deps: OptionsRunnerDeps,
  settings: OptionsSettings,
  options: { dryRun: boolean },
): Promise<RunReport> {
  const now = (deps.now ?? (() => new Date()))();
  const ranAt = now.toISOString();
  const today = newYorkClock(now).date;
  const results: TickerReport[] = [];
  let dryRun = options.dryRun;

  const record = (draft: AuditDraft): void => {
    const rec = buildAuditRecord(draft, deps.now ? deps.now() : new Date());
    try {
      deps.audit(rec);
    } catch {
      /* an audit sink failure must not change what was decided or sent */
    }
    results.push({ ticker: rec.ticker, outcome: rec.outcome, reason: rec.reason });
  };
  const fail = (error: string): RunReport => {
    record({ source: "options-runner", ticker: "-", outcome: "error", reason: error });
    return { ok: false, dryRun, ranAt, error, results };
  };

  try {
    if (!dryRun) {
      const gate = tradingGate(deps.config);
      if (!gate.ok) {
        if (gate.code !== "DISABLED") return fail(gate.error);
        if (!deps.config.configured) return fail("Paper credentials are not configured.");
        dryRun = true;
        record({
          source: "options-runner",
          ticker: "-",
          outcome: "dry-run",
          reason: "Paper trading is not switched on, so this run only observes. No orders will be sent.",
        });
      }
    }
    if (dryRun && !deps.config.configured) return fail("Paper credentials are not configured.");

    const accountRes = await deps.broker.getAccount();
    if (!accountRes.ok) return fail(`Cannot read the broker account: ${accountRes.error}`);
    const account = accountRes.value;
    if (account.status !== "ACTIVE" || account.tradingBlocked || account.accountBlocked) {
      return fail("Broker account is not active or trading is blocked.");
    }
    if (!(account.equity > 0) || !(account.lastEquity > 0)) {
      return fail("Broker equity is not usable. No trading.");
    }
    const positionsRes = await deps.broker.getPositions();
    if (!positionsRes.ok) return fail(`Cannot read broker positions: ${positionsRes.error}`);
    const positions = positionsRes.value;

    const dayLoss = (account.equity - account.lastEquity) / account.lastEquity;
    const lossHalted = dayLoss <= -DEFAULT_RISK_CONFIG.dailyLossLimitPct;
    let pendingPremium = 0;

    for (const ticker of settings.watchlist) {
      try {
        let bars: Bar[];
        try {
          bars = await deps.loadBars(ticker);
        } catch (e) {
          record({
            source: "options-runner",
            ticker,
            outcome: "error",
            reason: `Could not load bars: ${e instanceof Error ? e.message : "unknown error"}`,
          });
          continue;
        }
        let input: ReturnType<typeof buildAutoSimInput>;
        try {
          input = buildAutoSimInput(ticker, computePolaritySeries(completedBars(bars, now)), "signal-close");
        } catch (e) {
          record({
            source: "options-runner",
            ticker,
            outcome: "skipped",
            reason: `Bars failed validation: ${e instanceof Error ? e.message : "invalid data"}`,
          });
          continue;
        }
        if (!input) {
          record({ source: "options-runner", ticker, outcome: "aside", reason: "Not enough bars to act on yet. Standing aside." });
          continue;
        }
        const base = {
          source: "options-runner" as const,
          ticker,
          signalDate: input.signal.date,
          polarity: input.signal.polarity,
          ready: input.signal.ready,
        };
        if (!(input.fill.price > 0) || isStale(input.fill.date, now)) {
          record({ ...base, outcome: "skipped", reason: `Latest bar (${input.fill.date}) is stale or unusable. No trade on it.` });
          continue;
        }

        const notes: string[] = [];
        if (positions.some((p) => p.ticker === ticker)) {
          notes.push(`A plain ${ticker} stock position is open. Options mode does not manage it.`);
        }
        const wanted = optionTypeForPolarity(input.signal);
        const held = optionPositionsFor(positions, ticker);
        if (held.length > 1 || (held.length === 1 && held[0].side !== "long")) {
          record({ ...base, outcome: "blocked", reason: `Broker option positions in ${ticker} are not one bought option. Fix manually.`, notes });
          continue;
        }
        const heldOcc = held.length === 1 ? parseOccSymbol(held[0].ticker) : null;
        if (held.length === 1 && !heldOcc) {
          record({ ...base, outcome: "blocked", reason: `Option position ${held[0].ticker} has an unreadable symbol. Fix manually.`, notes });
          continue;
        }

        // Close first: neutral, flipped, or about to expire. Re-entry waits for the next session.
        let closeWhy: string | null = null;
        if (heldOcc && held.length === 1) {
          if (wanted === null) {
            closeWhy = input.signal.ready
              ? "Polarity went to 0 (Neutral). Closing the option."
              : "Not enough history yet. Closing the option.";
          } else if (wanted !== heldOcc.type) {
            closeWhy = `Polarity flipped. Closing the ${heldOcc.type.toUpperCase()}; the ${wanted.toUpperCase()} is bought next session once flat is confirmed.`;
          } else if (daysBetween(today, heldOcc.expiration) < ROLL_WITHIN_DAYS) {
            closeWhy = `Expires ${heldOcc.expiration}. Closing it; a fresh long-dated ${wanted.toUpperCase()} is bought next session.`;
          }
        }
        if (heldOcc && held.length === 1 && closeWhy) {
          const side = sideOf(heldOcc.type);
          const quoteRes = await deps.broker.getOptionQuote(held[0].ticker);
          const q = quoteRes.ok ? checkQuote(quoteRes.value, now) : null;
          const limit = q && q.ok ? sellLimit(q.bid) : undefined;
          if (limit === undefined) notes.push("No usable quote: closing at market.");
          if (dryRun) {
            record({ ...base, outcome: "dry-run", reason: `Would sell to close ${held[0].quantity} ${describeContract(heldOcc)}. ${closeWhy}`, notes, side, quantity: held[0].quantity, price: limit });
            continue;
          }
          const cid = optionClientOrderId("close", ticker, heldOcc.type, input.signal.date);
          const res = await placeOptionIntent(deps.broker, deps.config, {
            action: "close",
            ticker,
            signalDate: input.signal.date,
            quantity: 0,
            limitPrice: limit,
          });
          if (!res.ok) {
            record({ ...base, outcome: res.code === "BROKER" ? "error" : "blocked", reason: res.error, notes, side, clientOrderId: cid });
          } else if (res.status === "submitted") {
            record({ ...base, outcome: "closed", reason: `${res.message} ${closeWhy}`, notes, side, quantity: res.order.quantity, price: limit, orderId: res.order.id, clientOrderId: cid });
          } else {
            record({ ...base, outcome: "held", reason: res.message, notes, side, clientOrderId: cid, orderId: res.order?.id });
          }
          continue;
        }

        if (wanted === null) {
          record({
            ...base,
            outcome: "aside",
            reason: input.signal.ready ? "Polarity is 0 (Neutral). Holding no option." : "Not enough history yet. Holding no option.",
            notes,
          });
          continue;
        }
        if (heldOcc) {
          record({
            ...base,
            outcome: "held",
            reason: `Already holding the ${wanted.toUpperCase()} (${describeContract(heldOcc)}). Polarity is still ${wanted === "call" ? "+1" : "−1"}, no change.`,
            notes,
            side: sideOf(wanted),
          });
          continue;
        }

        // Entry. Temperance: no new premium after a 2% daily loss.
        if (lossHalted) {
          record({ ...base, outcome: "blocked", reason: "Daily loss limit reached. No new entries today.", notes });
          continue;
        }
        const spot = input.fill.price;
        const listed = await deps.broker.listContracts({
          underlying: ticker,
          type: wanted,
          expiresFrom: addDays(today, MIN_EXPIRY_DAYS),
          expiresTo: addDays(today, MIN_EXPIRY_DAYS + EXPIRY_WINDOW_DAYS),
          strikeLow: Math.floor(spot * (1 - STRIKE_WINDOW)),
          strikeHigh: Math.ceil(spot * (1 + STRIKE_WINDOW)),
        });
        if (!listed.ok) {
          record({ ...base, outcome: "error", reason: `Could not load option contracts: ${listed.error}`, notes });
          continue;
        }
        const contract = pickContract(listed.value, spot, wanted, addDays(today, MIN_EXPIRY_DAYS));
        if (!contract) {
          record({ ...base, outcome: "skipped", reason: `No tradable ${wanted.toUpperCase()} expiring in ${MIN_EXPIRY_DAYS}+ days near ${spot}.`, notes });
          continue;
        }
        const quoteRes = await deps.broker.getOptionQuote(contract.symbol);
        if (!quoteRes.ok) {
          record({ ...base, outcome: "error", reason: `Could not load the option quote: ${quoteRes.error}`, notes });
          continue;
        }
        const q = checkQuote(quoteRes.value, now);
        if (!q.ok) {
          record({ ...base, outcome: "skipped", reason: `${describeContract(contract)}: ${q.error} No trade.`, notes });
          continue;
        }
        if (q.spreadPct > MAX_SPREAD_PCT) {
          record({
            ...base,
            outcome: "blocked",
            reason: `${describeContract(contract)}: bid/ask gap is ${(q.spreadPct * 100).toFixed(1)}% of the price (limit ${MAX_SPREAD_PCT * 100}%). Too costly to enter.`,
            notes,
          });
          continue;
        }
        const limit = buyLimit(q.ask);
        const premium = limit * CONTRACT_MULTIPLIER * settings.contracts;
        const available = Math.max(0, Math.min(account.cash, account.buyingPower) - pendingPremium);
        if (premium > MAX_PREMIUM_PCT_OF_EQUITY * account.equity) {
          record({
            ...base,
            outcome: "blocked",
            reason: `${describeContract(contract)} costs ${money(premium)}, over ${MAX_PREMIUM_PCT_OF_EQUITY * 100}% of equity. Not entered.`,
            notes,
          });
          continue;
        }
        if (premium > available) {
          record({ ...base, outcome: "blocked", reason: `${describeContract(contract)} costs ${money(premium)}, more than the cash available. Not entered.`, notes });
          continue;
        }
        const side = sideOf(wanted);
        const why = `Polarity is ${wanted === "call" ? "+1 (Drive)" : "−1 (Reverse)"}.`;
        if (dryRun) {
          record({
            ...base,
            outcome: "dry-run",
            reason: `Would buy ${settings.contracts} ${describeContract(contract)} at ${limit.toFixed(2)} (about ${money(premium)}). ${why}`,
            notes,
            side,
            quantity: settings.contracts,
            price: limit,
          });
          continue;
        }
        const cid = optionClientOrderId("enter", ticker, wanted, input.signal.date);
        const res = await placeOptionIntent(deps.broker, deps.config, {
          action: "enter",
          ticker,
          contractSymbol: contract.symbol,
          signalPolarity: input.signal.polarity,
          signalDate: input.signal.date,
          quantity: settings.contracts,
          limitPrice: limit,
        });
        if (!res.ok) {
          record({ ...base, outcome: res.code === "BROKER" ? "error" : "blocked", reason: res.error, notes, side, quantity: settings.contracts, price: limit, clientOrderId: cid });
        } else if (res.status === "submitted") {
          pendingPremium += premium;
          record({ ...base, outcome: "entered", reason: `${res.message} ${why}`, notes, side, quantity: settings.contracts, price: limit, orderId: res.order.id, clientOrderId: cid });
        } else {
          record({ ...base, outcome: "held", reason: res.message, notes, side, clientOrderId: cid, orderId: res.order?.id });
        }
      } catch (e) {
        record({
          source: "options-runner",
          ticker,
          outcome: "error",
          reason: `Unexpected failure: ${e instanceof Error ? e.name : "unknown"}`,
        });
      }
    }
    return { ok: true, dryRun, ranAt, results };
  } catch (e) {
    return fail(`Unexpected runner failure: ${e instanceof Error ? e.name : "unknown"}`);
  }
}
