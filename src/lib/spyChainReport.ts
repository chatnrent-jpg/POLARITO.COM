/**
 * Plain-language report for the SPY options chain read (pure; no network, no secrets).
 * The report never contains credentials or the account number: it only receives the fields below.
 */
import { MIN_ABS_DELTA, MIN_DAYS_TO_EXPIRY, affordability, assertContractRules, usd, type ChainRow } from "@/lib/optionsSelect";
import type { AccountSummary, SideReport, Spot } from "@/lib/spyChain";

export type ChainReportInput = {
  generatedAt: string;
  today: string;
  spot: Spot;
  /** Which Alpaca host answered the account request, or null if none did. */
  accountHost: "live" | "paper" | null;
  account: AccountSummary | null;
  accountError: string | null;
  optionsFeed: string;
  /** Henry's real account size, for the plain "can I afford it" line. */
  liveBudget: number;
  call: SideReport;
  put: SideReport;
  model: { rate: number; dividendYield: number };
};

const pct = (n: number, d = 1): string => `${(n * 100).toFixed(d)}%`;
const dec = (n: number | null, d = 2): string => (n === null ? "n/a" : n.toFixed(d));

function pickLines(label: string, side: SideReport, budgets: Array<{ name: string; amount: number }>): string[] {
  const out: string[] = [`### ${label}`];
  if (side.error) out.push(`- Problem: ${side.error}`);
  out.push(`- Listed expiries at least ${MIN_DAYS_TO_EXPIRY} days out (in the window read): ${side.listedExpirations.length ? side.listedExpirations.join(", ") : "none"}`);
  if (!side.pick.ok) {
    out.push(`- Result: NO CONTRACT. ${side.pick.reason}. Nothing is substituted.`);
    return out;
  }
  const r = side.pick.row;
  out.push(
    `- Chosen expiry: ${side.pick.expiration} (${side.pick.daysToExpiry} days out, nearest listed expiry that is at least ${MIN_DAYS_TO_EXPIRY})`,
    `- Contract: ${r.symbol} (strike ${r.strike}); the cheapest of ${side.pick.qualifying} contracts at that expiry with |delta| >= ${MIN_ABS_DELTA}`,
    `- Quote: bid ${usd(r.bid)}, ask ${usd(r.ask)}, mid ${usd(r.mid)} per share (spread ${pct(r.spreadPct)}), quote time ${r.quoteAt}`,
    `- Delta ${r.delta.toFixed(3)} (${r.deltaSource === "alpaca" ? "Alpaca's own greeks" : "computed with Black-Scholes from the quote because Alpaca sent no usable delta"}), implied volatility ${r.iv === null ? "n/a" : pct(r.iv)}${r.ivSource ? ` (${r.ivSource === "alpaca" ? "Alpaca" : "solved from the mid price"})` : ""}`,
    `- Cost per contract (100 shares): ${usd(r.costAtAsk)} at the ask, ${usd(r.costAtMid)} at the mid. Of the mid price, ${usd(r.intrinsicPerShare)} per share is real value (in the money) and ${usd(r.extrinsicPerShare)} is time value.`,
  );
  for (const b of budgets) {
    const a = affordability(r.costAtAsk, b.amount);
    out.push(`- ${b.name} (${usd(b.amount)}): ${a.affordable ? `can buy ${a.contracts} contract(s)` : `CANNOT afford one contract; short by ${usd(a.shortfall)}`}`);
  }
  return out;
}

const rowText = (r: ChainRow): string => `strike ${r.strike}, delta ${r.delta.toFixed(3)} (${r.deltaSource === "alpaca" ? "Alpaca" : "Black-Scholes"}), bid ${usd(r.bid)}, ask ${usd(r.ask)}, spread ${pct(r.spreadPct)}`;

/** What was read for one side: strike coverage, the highest |delta| found, and the strikes closest to the 0.80 rule. */
function coverage(label: string, side: SideReport, today: string): string[] {
  const w = side.window;
  const sr = side.strikesRead;
  const out: string[] = [
    `${label}: strike window requested ${w.low.toFixed(0)} to ${w.high.toFixed(0)}; ${sr.count} usable quotes read at the chosen expiry${sr.min !== null ? `, strikes ${sr.min} to ${sr.max}` : ""}.`,
  ];
  const h = side.highestAbsDelta;
  out.push(h ? `Highest |delta| found: ${rowText(h)}${assertContractRules(h, side.type, today) === null ? " (meets every rule)" : ` (does not qualify: ${assertContractRules(h, side.type, today)})`}.` : "Highest |delta| found: none (no usable quote).");
  if (side.ladder.length === 0) return out;
  const rows: ChainRow[] = side.ladder.slice(0, 14).sort((a, b) => a.strike - b.strike);
  return [
    ...out,
    "",
    `Strikes closest to the ${MIN_ABS_DELTA} rule, same expiry:`,
    "",
    "| Strike | Delta | Source | Bid | Ask | Spread | Cost per contract (ask) | Rule met |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.strike} | ${r.delta.toFixed(3)} | ${r.deltaSource === "alpaca" ? "Alpaca" : "Black-Scholes"} | ${usd(r.bid)} | ${usd(r.ask)} | ${pct(r.spreadPct)} | ${usd(r.costAtAsk)} | ${assertContractRules(r, side.type, today) === null ? "yes" : `no (${assertContractRules(r, side.type, today)})`} |`),
    "",
  ];
}

/** Information only: what later qualifying expiries would offer when the nearest one gave no contract. Never selected. */
function laterLines(side: SideReport): string[] {
  if (side.later.length === 0) return [];
  return [
    `Later expiries, INFORMATION ONLY (the rule uses the nearest listed expiry at least ${MIN_DAYS_TO_EXPIRY} days out; nothing below is selected or substituted):`,
    "",
    ...side.later.map((l) => (l.error ? `- ${l.expiration} (${l.daysToExpiry} days): could not be read (${l.error})` : `- ${l.expiration} (${l.daysToExpiry} days): ${l.rowsBuilt} usable quotes, ${l.meetingRules} meet every rule; highest |delta| ${l.highestAbsDelta ? rowText(l.highestAbsDelta) : "none"}`)),
    "",
  ];
}

export function renderChainReport(i: ChainReportInput): string {
  const budgets: Array<{ name: string; amount: number }> = [{ name: "Live account reference", amount: i.liveBudget }];
  if (i.account?.cash != null) budgets.push({ name: `Cash in the account Alpaca answered for (${i.accountHost})`, amount: i.account.cash });
  if (i.account?.optionsBuyingPower != null) budgets.push({ name: "Options buying power", amount: i.account.optionsBuyingPower });

  const L: string[] = [];
  L.push(
    "# SPY options chain check (read-only)",
    "",
    `Run ${i.generatedAt}; New York date ${i.today}. This job only READS. It sends no order and cannot: the client it uses refuses every path except account, contracts, latest trade and option snapshots, and only ever sends GET.`,
    "",
    "## Rules applied (hard)",
    `- Expiration at least ${MIN_DAYS_TO_EXPIRY} calendar days out; the nearest LISTED expiry that is at least ${MIN_DAYS_TO_EXPIRY} days out. Never less.`,
    `- |delta| >= ${MIN_ABS_DELTA} (deep in the money): a CALL for Drive, a PUT for Reverse.`,
    `- A crossed, empty, stale or wide (over 15% of mid) quote is never chosen.`,
    "",
    "## Plain answer",
  );
  const callCost = i.call.pick.ok ? i.call.pick.row.costAtAsk : null;
  const putCost = i.put.pick.ok ? i.put.pick.row.costAtAsk : null;
  L.push(
    `- One call (delta >= ${MIN_ABS_DELTA}, at least ${MIN_DAYS_TO_EXPIRY} days): ${callCost === null ? "none found" : `${usd(callCost)} per contract at the ask`}.`,
    `- One put (delta >= ${MIN_ABS_DELTA}, at least ${MIN_DAYS_TO_EXPIRY} days): ${putCost === null ? "none found" : `${usd(putCost)} per contract at the ask`}.`,
  );
  const cheapest = [callCost, putCost].filter((c): c is number => c !== null);
  if (cheapest.length > 0) {
    const min = Math.min(...cheapest);
    L.push(
      min > i.liveBudget
        ? `- Against the ${usd(i.liveBudget)} live account: NOT affordable (the cheaper side is ${usd(min)}, ${(min / i.liveBudget).toFixed(1)} times the account). This design is paper / dry-run only until the capital changes.`
        : `- Against the ${usd(i.liveBudget)} live account: one contract of the cheaper side (${usd(min)}) fits, but the whole account would be one position.`,
    );
  }
  L.push("", "## Underlying and account", `- SPY last trade ${usd(i.spot.price)} at ${i.spot.at} (feed: ${i.spot.feed}). Option feed: ${i.optionsFeed}.`);
  if (i.account) {
    const a = i.account;
    L.push(
      `- Account answered on the ${i.accountHost} host: status ${a.status}${a.tradingBlocked || a.accountBlocked ? " (BLOCKED)" : ""}`,
      a.optionsApprovedLevel === null && a.optionsTradingLevel === null
        ? `- Options approval level: NOT RETURNED by Alpaca. The account answer had no usable options_approved_level or options_trading_level (option-related fields Alpaca did send: ${a.optionsFieldsSeen.length ? a.optionsFieldsSeen.join(", ") : "none"}). This job cannot tell whether options trading is enabled: check it in the Alpaca dashboard (buying a call or put needs level 2).`
        : `- Options approval level: approved ${a.optionsApprovedLevel ?? "not returned"}, trading ${a.optionsTradingLevel ?? "not returned"} (buying a call or put needs level 2)`,
      `- Equity ${a.equity === null ? "n/a" : usd(a.equity)}, cash ${a.cash === null ? "n/a" : usd(a.cash)}, buying power ${a.buyingPower === null ? "n/a" : usd(a.buyingPower)}, options buying power ${a.optionsBuyingPower === null ? "not returned" : usd(a.optionsBuyingPower)}, multiplier ${dec(a.multiplier, 0)}`,
    );
  } else {
    L.push(`- Account could not be read (${i.accountError ?? "no answer"}). The chain was still read with the data keys.`);
  }
  L.push("", "## Contracts", "", ...pickLines("Call (for a Drive reading)", i.call, budgets), "", ...coverage("Call", i.call, i.today), ...laterLines(i.call), ...pickLines("Put (for a Reverse reading)", i.put, budgets), "", ...coverage("Put", i.put, i.today), ...laterLines(i.put));
  const rej = (s: SideReport) => Object.entries(s.rejected).map(([k, v]) => `${k}: ${v}`);
  L.push(
    "## Data quality",
    `- Rows with a usable quote: calls ${i.call.rowsBuilt}, puts ${i.put.rowsBuilt}.`,
    `- Rows rejected (calls): ${rej(i.call).join("; ") || "none"}`,
    `- Rows rejected (puts): ${rej(i.put).join("; ") || "none"}`,
    `- Where Alpaca sent no greeks, delta is computed with Black-Scholes from the quote (rate ${pct(i.model.rate)}, dividend yield ${pct(i.model.dividendYield)} assumed). Each contract above says which source it used.`,
    "",
  );
  return L.join("\n");
}
