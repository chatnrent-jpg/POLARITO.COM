import { connection } from "next/server";
import { AlpacaPaperBroker } from "@/lib/broker/alpacaPaper";
import { paperBrokerConfig, paperCredentials, tradingGate } from "@/lib/broker/config";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/broker/paper/status
 * Read-only. Behind the Polarito session gate (src/proxy.ts). Reports the
 * paper-trading switches and, when credentials exist, the paper account and
 * positions. It never places an order and never returns credentials.
 */
export async function GET() {
  // With cacheComponents a handler that reads no request data is prerendered at
  // build time, which would freeze env-derived state. Opt into per-request rendering.
  await connection();
  const config = paperBrokerConfig(process.env);
  const gate = tradingGate(config);
  const base = {
    mode: "paper" as const,
    enabled: config.enabled,
    killed: config.killed,
    configured: config.configured,
    tradingAllowed: gate.ok,
    ...(gate.ok ? {} : { blockedReason: gate.error }),
  };

  const creds = paperCredentials(process.env);
  if (!creds) {
    return Response.json({ ok: true, ...base }, { headers: NO_STORE });
  }

  try {
    const broker = new AlpacaPaperBroker(creds);
    const [account, positions] = await Promise.all([broker.getAccount(), broker.getPositions()]);
    if (!account.ok) {
      return Response.json(
        { ok: false, ...base, code: account.code, error: account.error },
        { status: 502, headers: NO_STORE },
      );
    }
    if (!positions.ok) {
      return Response.json(
        { ok: false, ...base, code: positions.code, error: positions.error },
        { status: 502, headers: NO_STORE },
      );
    }
    return Response.json(
      { ok: true, ...base, account: account.value, positions: positions.value },
      { headers: NO_STORE },
    );
  } catch (e) {
    console.error("Paper status failed:", e instanceof Error ? e.name : "unknown");
    return Response.json(
      { ok: false, ...base, code: "INTERNAL", error: "Unexpected server error." },
      { status: 500, headers: NO_STORE },
    );
  }
}
