/**
 * Plain-language summary of one dry-run engine evaluation (pure; no secrets). Shows the inputs next to each reading.
 */
import { LONG_TIMEFRAMES, LONG_TIMEFRAME_NAMES, type LongReading } from "@/lib/longPolarity";
import { MIN_ABS_DELTA, MIN_DAYS_TO_EXPIRY, usd } from "@/lib/optionsSelect";
import type { EngineConfig, EngineResult } from "@/lib/spyEngine";

const raw = (n: number | null): string => (n === null ? "n/a" : `${n > 0 ? "+" : ""}${Math.round(n).toLocaleString("en-US")}`);

function row(r: LongReading, mark: string): string {
  const candle = r.kind ? `${r.kind}${r.open !== null && r.close !== null ? ` (${r.open.toFixed(2)} -> ${r.close.toFixed(2)})` : ""}` : "n/a";
  const net = r.status !== "ok" ? "n/a" : r.netSign === null ? `${raw(r.netVolume)} (missing)` : `${raw(r.netVolume)} (${r.netSign > 0 ? "positive" : r.netSign < 0 ? "negative" : "zero"})`;
  const flag = r.netFlag ? `**${r.netFlag.toUpperCase()} NET VOLUME**` : "";
  const prev = r.previousClose === null ? "n/a" : r.previousClose.toFixed(2);
  return `| ${LONG_TIMEFRAME_NAMES[r.timeframe]}${mark} | ${candle} | ${prev} | ${net} | ${flag} | ${r.agreement ?? "n/a"} | **${r.label}** | ${r.periodStart} | ${r.asOf} | ${r.throughDate} | ${r.sessions || "n/a"} | ${r.reason ?? ""} |`;
}

export function renderEngineReport(result: EngineResult, config: EngineConfig): string {
  const L: string[] = ["# SPY options dry run", "", "DRY RUN: no order is sent and none can be: this job only reads market data.", ""];
  L.push(
    `Decision timeframe: ${LONG_TIMEFRAME_NAMES[config.timeframe]} (marked with *). Net volume = the chart definition: total daily volume of the period to date (SIP), signed by the latest close vs the previous period's last close (one definition only; the raw number is shown so it can be compared with the chart). An exactly zero or missing net volume is flagged and is Neutral. A reading counts only when candle colour and net volume match (green + positive = Drive, red + negative = Reverse, otherwise Neutral). On Neutral the engine does nothing automatic: the trader decides. Rules: expiry at least ${MIN_DAYS_TO_EXPIRY} days out (nearest listed), |delta| >= ${MIN_ABS_DELTA}; calls on Drive, puts on Reverse; one position at a time; max loss = premium; roll or exit only when the decision timeframe flips.`,
    "",
  );
  if (result.decision?.traderDecides) L.push("## NEUTRAL: TRADER DECIDES", "", "Candle colour and net volume do not agree, or the net volume is exactly zero or missing (flagged). No automatic exit and no automatic entry. Decide by hand.", "");
  if (result.decision) L.push(`## Decision: ${result.decision.action.replace("_", " ")}`, "", result.decision.reason, "");
  if (result.readings) {
    L.push(
      "## Readings (period to date, one value per period)",
      "",
      "| Timeframe | Candle (open -> close) | Previous period close | Net volume (raw) | Flag | Match | Reading | Period start | As of | Newest daily bar | Sessions | Note |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...LONG_TIMEFRAMES.map((tf) => row(result.readings![tf], tf === config.timeframe ? " *" : "")),
      "",
    );
  }
  const p = result.state.position;
  L.push("## Dry-run position", "", p ? `${p.type.toUpperCase()} ${p.symbol} (strike ${p.strike}, expires ${p.expiration}), entered ${p.entryAt} at the ask ${usd(p.entryAsk)}, delta ${p.entryDelta.toFixed(3)}; max loss ${usd(p.maxLossUsd)}.` : "None.", "", "## Events this run", "");
  for (const e of result.events) L.push(`- ${e.at} [${e.kind}] ${e.message}`);
  L.push("");
  return L.join("\n");
}
