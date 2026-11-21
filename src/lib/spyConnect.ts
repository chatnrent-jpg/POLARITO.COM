/**
 * Pick the Alpaca keys and find which trading host answers (read-only, GET only). Shared by the chain and engine scripts.
 * Keys are read from the environment and go out as headers only; nothing here prints them.
 */
import { createReadOnlyClient, type ReadOnlyClient, type ReadOnlyHost } from "@/lib/alpacaReadOnly";
import { readAccount, type AccountSummary } from "@/lib/spyChain";

export type Connection = {
  client: ReadOnlyClient;
  account: AccountSummary | null;
  accountHost: "live" | "paper" | null;
  contractsHost: ReadOnlyHost | null;
  accountErrors: string[];
};

export async function connectAlpaca(env: Readonly<Record<string, string | undefined>>): Promise<Connection> {
  const candidates: Array<{ client: ReadOnlyClient; hosts: ReadOnlyHost[] }> = [];
  const liveId = env.ALPACA_LIVE_KEY_ID?.trim();
  const liveSecret = env.ALPACA_LIVE_SECRET_KEY?.trim();
  if (liveId && liveSecret) candidates.push({ client: createReadOnlyClient({ keyId: liveId, secretKey: liveSecret }), hosts: ["trading-live"] });
  const dataId = env.ALPACA_API_KEY_ID?.trim();
  const dataSecret = env.ALPACA_API_SECRET_KEY?.trim();
  if (dataId && dataSecret) candidates.push({ client: createReadOnlyClient({ keyId: dataId, secretKey: dataSecret }), hosts: ["trading-live", "trading-paper"] });
  if (candidates.length === 0) throw new Error("No Alpaca keys found (ALPACA_LIVE_KEY_ID/SECRET or ALPACA_API_KEY_ID/SECRET).");

  const accountErrors: string[] = [];
  for (const c of candidates) {
    for (const host of c.hosts) {
      const res = await readAccount(c.client, host);
      if (res.ok) return { client: c.client, account: res.value, accountHost: host === "trading-live" ? "live" : "paper", contractsHost: host, accountErrors };
      accountErrors.push(res.error);
    }
  }
  return { client: candidates[candidates.length - 1].client, account: null, accountHost: null, contractsHost: null, accountErrors };
}
