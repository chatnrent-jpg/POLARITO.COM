/**
 * READ-ONLY: read the SPY options chain from Alpaca and print what the SPY options design would pick.
 *
 *   npx tsx --env-file=.env.local scripts/spy-options-chain.ts [--out-dir=spy-options-chain-out] [--stock-feed=sip,iex]
 *       [--options-feed=indicative] [--live-budget=1000] [--rate=0.043] [--div=0.012]
 *
 * Keys (never printed): ALPACA_LIVE_KEY_ID + ALPACA_LIVE_SECRET_KEY (the live account, optional) and/or
 * ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY. Every request goes through src/lib/alpacaReadOnly.ts, which can
 * only send GET to account / option contracts / latest trade / option snapshots. No order endpoint is reachable.
 */
import fs from "node:fs";
import path from "node:path";
import { createReadOnlyClient, type ReadOnlyClient, type ReadOnlyHost } from "../src/lib/alpacaReadOnly";
import { DEFAULT_DIVIDEND_YIELD, DEFAULT_RISK_FREE_RATE } from "../src/lib/optionsSelect";
import { newYorkDate, readAccount, readSide, readSpot, type AccountSummary } from "../src/lib/spyChain";
import { renderChainReport } from "../src/lib/spyChainReport";

const arg = (name: string, d: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const SYMBOL = "SPY";

async function main(): Promise<void> {
  const outDir = arg("out-dir", "spy-options-chain-out");
  const stockFeeds = arg("stock-feed", "sip,iex").split(",").map((s) => s.trim()).filter((s) => s === "sip" || s === "iex");
  const optionsFeed = arg("options-feed", "indicative");
  if (optionsFeed !== "indicative" && optionsFeed !== "opra") throw new Error("--options-feed must be indicative or opra");
  const liveBudget = Number(arg("live-budget", "1000"));
  const rate = Number(arg("rate", String(DEFAULT_RISK_FREE_RATE)));
  const dividendYield = Number(arg("div", String(DEFAULT_DIVIDEND_YIELD)));
  if (![liveBudget, rate, dividendYield].every(Number.isFinite) || liveBudget <= 0) throw new Error("bad numeric argument");
  if (stockFeeds.length === 0) throw new Error("--stock-feed must list sip and/or iex");

  const env = process.env;
  const candidates: Array<{ client: ReadOnlyClient; hosts: ReadOnlyHost[] }> = [];
  const liveId = env.ALPACA_LIVE_KEY_ID?.trim();
  const liveSecret = env.ALPACA_LIVE_SECRET_KEY?.trim();
  if (liveId && liveSecret) candidates.push({ client: createReadOnlyClient({ keyId: liveId, secretKey: liveSecret }), hosts: ["trading-live"] });
  const dataId = env.ALPACA_API_KEY_ID?.trim();
  const dataSecret = env.ALPACA_API_SECRET_KEY?.trim();
  if (dataId && dataSecret) candidates.push({ client: createReadOnlyClient({ keyId: dataId, secretKey: dataSecret }), hosts: ["trading-live", "trading-paper"] });
  if (candidates.length === 0) throw new Error("No Alpaca keys found (ALPACA_LIVE_KEY_ID/SECRET or ALPACA_API_KEY_ID/SECRET).");

  let client = candidates[candidates.length - 1].client;
  let account: AccountSummary | null = null;
  let accountHost: "live" | "paper" | null = null;
  let contractsHost: ReadOnlyHost | null = null;
  const accountErrors: string[] = [];
  outer: for (const c of candidates) {
    for (const host of c.hosts) {
      const res = await readAccount(c.client, host);
      if (res.ok) {
        client = c.client;
        account = res.value;
        accountHost = host === "trading-live" ? "live" : "paper";
        contractsHost = host;
        break outer;
      }
      accountErrors.push(res.error);
    }
  }

  const now = new Date();
  const today = newYorkDate(now);
  const spotRes = await readSpot(client, SYMBOL, stockFeeds);
  if (!spotRes.ok) throw new Error(spotRes.error);
  const spot = spotRes.value;
  const model = { rate, dividendYield };
  const common = { symbol: SYMBOL, today, now, spot: spot.price, optionsFeed, contractsHost, model };
  const call = await readSide(client, "call", common);
  const put = await readSide(client, "put", common);

  const report = renderChainReport({
    generatedAt: now.toISOString(),
    today,
    spot,
    accountHost,
    account,
    accountError: account ? null : accountErrors.join(" | ") || null,
    optionsFeed,
    liveBudget,
    call,
    put,
    model,
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "spy-options-chain.md"), report);
  fs.writeFileSync(path.join(outDir, "spy-options-chain.json"), JSON.stringify({ today, spot, accountHost, account, call: { ...call, ladder: call.ladder.slice(0, 20) }, put: { ...put, ladder: put.ladder.slice(0, 20) }, model }, null, 2));
  console.log(report);
  if (!call.pick.ok && !put.pick.ok && (call.error || put.error)) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`spy-options-chain failed: ${e instanceof Error ? e.message : "unknown error"}`);
  process.exit(1);
});
