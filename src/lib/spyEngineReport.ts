/**
 * Plain-language summary of one dry-run engine evaluation (pure; no secrets). Shows the inputs next to each reading.
 */
import { LONG_TIMEFRAMES, LONG_TIMEFRAME_NAMES, NET_VOLUME_METHODS, type LongReading } from "@/lib/longPolarity";
import { MIN_ABS_DELTA, MIN_DAYS_TO_EXPIRY, usd } from "@/lib/optionsSelect";
import type { EngineConfig, EngineResult } from "@/lib/spyEngine";

const m = (n: number | null): string => (n === null ? "n/a" : `${(n / 1e6).toFixed(1)}M`);

function row(r: LongReading, mark: string): string {
  return `| ${LONG_TIMEFRAME_NAMES[r.timeframe]}${mark} | **${r.label}** | ${r.periodStart} | ${m(r.netVolume)} | ${m(r.upVolume)} | ${m(r.downVolume)} | ${r.asOf} | ${r.throughDate}${r.lastBarAt ? ` / ${r.lastBarAt}` : ""} | ${r.sessions || "n/a"} | ${r.reason ?? ""} |`;
}

export function renderEngineReport(result: EngineResult, config: EngineConfig): string {
  const L: string[] = ["# SPY options dry run", "", "DRY RUN: no order is sent and none can be: this job only reads market data.", ""];
  L.push(
    `Decision timeframe: ${LONG_TIMEFRAME_NAMES[config.timeframe]} (marked with *). Net volume method: ${config.method}. Rules: expiry at least ${MIN_DAYS_TO_EXPIRY} days out (nearest listed), |delta| >= ${MIN_ABS_DELTA}; calls on Drive, puts on Reverse; one position at a time; max loss = premium; roll or exit only when the decision timeframe flips.`,
    "",
  );
  if (result.decision) L.push(`## Decision: ${result.decision.action.replace("_", " ")}`, "", result.decision.reason, "");
  if (result.readings) {
    L.push(
      "## Readings (period to date, one value per period)",
      "",
      "| Timeframe | Reading | Period start | Net volume | Up volume | Down volume | As of | Newest bar | Sessions | Why unavailable |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...LONG_TIMEFRAMES.map((tf) => row(result.readings![tf], tf === config.timeframe ? " *" : "")),
      "",
    );
    const others = NET_VOLUME_METHODS.filter((x) => x !== config.method && result.comparison[x]);
    if (others.length) {
      L.push("For comparison only (never used to decide):", "", "| Method | Monthly | Quarterly | 6-month | Yearly |", "| --- | --- | --- | --- | --- |");
      for (const x of others) L.push(`| ${x} | ${LONG_TIMEFRAMES.map((tf) => (result.comparison[x] as NonNullable<(typeof result.comparison)[typeof x]>)[tf].label).join(" | ")} |`);
      L.push("");
    }
  }
  const p = result.state.position;
  L.push("## Dry-run position", "", p ? `${p.type.toUpperCase()} ${p.symbol} (strike ${p.strike}, expires ${p.expiration}), entered ${p.entryAt} at the ask ${usd(p.entryAsk)}, delta ${p.entryDelta.toFixed(3)}; max loss ${usd(p.maxLossUsd)}.` : "None.", "", "## Events this run", "");
  for (const e of result.events) L.push(`- ${e.at} [${e.kind}] ${e.message}`);
  L.push("");
  return L.join("\n");
}
