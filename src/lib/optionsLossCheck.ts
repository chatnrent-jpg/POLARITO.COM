/**
 * Intraday loss stop for options mode. Called every ~30 minutes during the
 * regular session by an outside timer. It never reads a signal and never buys:
 * its only job is to flatten the options when the account is down 2% or more
 * on the day, so the system stands aside until the next session.
 *
 * Idempotent: the close order id is fixed per ticker per day, so repeated
 * calls (or the evening runner) can never sell the same option twice.
 *
 * Justice: an unreadable account or position list means no action and a
 * truthful error record, never an assumed state. Closes are never blocked by
 * risk limits; only the gate (kill switch, enabled, credentials) applies.
 */
import { buildAuditRecord, type AuditDraft, type AuditRecord } from "@/lib/audit";
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import { checkQuote, describeContract, parseOccSymbol, sellLimit, type OptionsBroker } from "@/lib/broker/options";
import { optionClientOrderId, optionPositionsFor, placeOptionIntent } from "@/lib/broker/optionsExecute";
import { newYorkClock } from "@/lib/paperRunner";
import { DEFAULT_RISK_CONFIG } from "@/lib/risk";

/** Regular session, New York time. */
export const SESSION_OPEN_MINUTES = 9 * 60 + 30;
export const SESSION_CLOSE_MINUTES = 16 * 60;

export type LossCheckDeps = {
  broker: OptionsBroker;
  config: PaperBrokerConfig;
  audit: (record: AuditRecord) => void;
  now?: () => Date;
};

export type LossCheckReport =
  | { ok: true; action: "none" | "closed" | "observed"; reason: string; ranAt: string }
  | { ok: false; error: string; ranAt: string };

/** Mon-Fri, 09:30 to 16:00 New York. Outside it, an order would just queue, so nothing is done. */
export function inSession(now: Date): boolean {
  const ny = newYorkClock(now);
  const weekday = new Date(`${ny.date}T00:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5 && ny.minutes >= SESSION_OPEN_MINUTES && ny.minutes < SESSION_CLOSE_MINUTES;
}

export async function runLossCheck(
  deps: LossCheckDeps,
  settings: { watchlist: readonly string[] },
  options: { dryRun: boolean },
): Promise<LossCheckReport> {
  const now = (deps.now ?? (() => new Date()))();
  const ranAt = now.toISOString();
  const record = (draft: AuditDraft): void => {
    try {
      deps.audit(buildAuditRecord(draft, deps.now ? deps.now() : new Date()));
    } catch {
      /* an audit sink failure must not change what was decided or sent */
    }
  };
  const fail = (error: string): LossCheckReport => {
    record({ source: "options-runner", ticker: "-", outcome: "error", reason: `Loss check: ${error}` });
    return { ok: false, error, ranAt };
  };

  try {
    if (!inSession(now)) return { ok: true, action: "none", reason: "Market is closed. Nothing to check.", ranAt };

    if (!deps.config.configured) return fail("Paper credentials are not configured.");
    let dryRun = options.dryRun;
    const gate = tradingGate(deps.config);
    if (!gate.ok) {
      if (gate.code !== "DISABLED") return fail(gate.error);
      dryRun = true;
    }

    const accountRes = await deps.broker.getAccount();
    if (!accountRes.ok) return fail(`Cannot read the broker account: ${accountRes.error}`);
    const account = accountRes.value;
    if (account.status !== "ACTIVE" || account.accountBlocked) return fail("Broker account is not active.");
    if (!(account.equity > 0) || !(account.lastEquity > 0)) return fail("Broker equity is not usable.");

    const dayLoss = (account.equity - account.lastEquity) / account.lastEquity;
    const limit = DEFAULT_RISK_CONFIG.dailyLossLimitPct;
    if (dayLoss > -limit) {
      return { ok: true, action: "none", reason: `Day change ${(dayLoss * 100).toFixed(2)}%. Above the -${limit * 100}% limit.`, ranAt };
    }

    const positionsRes = await deps.broker.getPositions();
    if (!positionsRes.ok) return fail(`Cannot read broker positions: ${positionsRes.error}`);
    const today = newYorkClock(now).date;
    const why = `Account is down ${(-dayLoss * 100).toFixed(2)}% today (limit ${limit * 100}%). Closing the option; trading resumes next session.`;
    let closed = 0;

    for (const ticker of settings.watchlist) {
      try {
        const held = optionPositionsFor(positionsRes.value, ticker);
        if (held.length === 0) continue;
        for (const pos of held) {
          const occ = parseOccSymbol(pos.ticker);
          if (!occ) {
            record({ source: "options-runner", ticker, outcome: "blocked", reason: `Option position ${pos.ticker} has an unreadable symbol. Close it manually.` });
            continue;
          }
          const quoteRes = await deps.broker.getOptionQuote(pos.ticker);
          const q = quoteRes.ok ? checkQuote(quoteRes.value, now) : null;
          const limitPrice = q && q.ok ? sellLimit(q.bid) : undefined;
          const notes = limitPrice === undefined ? ["No usable quote: closing at market."] : [];
          const side = occ.type === "call" ? "long" : "short";
          if (dryRun) {
            record({ source: "options-runner", ticker, outcome: "dry-run", reason: `Would sell to close ${pos.quantity} ${describeContract(occ)}. ${why}`, notes, side, quantity: pos.quantity, price: limitPrice });
            continue;
          }
          const cid = optionClientOrderId("close", ticker, occ.type, today);
          const res = await placeOptionIntent(deps.broker, deps.config, {
            action: "close",
            ticker,
            signalDate: today,
            quantity: 0,
            limitPrice,
          });
          if (!res.ok) {
            record({ source: "options-runner", ticker, outcome: res.code === "BROKER" ? "error" : "blocked", reason: res.error, notes, side, clientOrderId: cid });
          } else if (res.status === "submitted") {
            closed += 1;
            record({ source: "options-runner", ticker, outcome: "closed", reason: `${res.message} ${why}`, notes, side, quantity: res.order.quantity, price: limitPrice, orderId: res.order.id, clientOrderId: cid });
          } else {
            record({ source: "options-runner", ticker, outcome: "held", reason: res.message, notes, side, clientOrderId: cid, orderId: res.order?.id });
          }
        }
      } catch (e) {
        record({ source: "options-runner", ticker, outcome: "error", reason: `Loss check failed: ${e instanceof Error ? e.name : "unknown"}` });
      }
    }
    return {
      ok: true,
      action: dryRun ? "observed" : "closed",
      reason: dryRun ? `Loss limit reached; observing only. ${why}` : `Loss limit reached; ${closed} close order(s) sent. ${why}`,
      ranAt,
    };
  } catch (e) {
    return fail(`Unexpected failure: ${e instanceof Error ? e.name : "unknown"}`);
  }
}
