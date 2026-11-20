import type { NextRequest } from "next/server";
import { logAudit } from "@/lib/audit";
import { createLiveBroker, liveBrokerConfig, liveOptedIn, liveSettings } from "@/lib/broker/liveConfig";
import { buyLivePosition } from "@/lib/liveBuy";
import { createAutoStore, readAutoState } from "@/lib/liveAutoStore";
import { fetchRealMarketData } from "@/lib/marketApi";
import { sameOriginRequest } from "@/lib/sameOrigin";

const NO_STORE = { "Cache-Control": "no-store" };

const statusFor = (code: string): number => {
  if (code === "INVALID" || code === "NOT_WATCHLIST") return 400;
  if (code === "UNREADABLE" || code === "BROKER") return 502;
  if (code === "INTERNAL") return 500;
  return 409;
};

/**
 * POST /api/broker/live/buy   body: { "ticker": "NVDA", "quantity": 1, "requireDrive": true }   (requireDrive: the order ticket's gear gate, optional)
 *
 * Manual long entry for the live account, behind the Polarito session gate (src/proxy.ts) like the
 * close and auto routes, same-origin only, never under /api/cron/. Needs POLARITO_LIVE_ACCOUNT=1 AND
 * POLARITO_LIVE_TRADING_ENABLED=1, and POLARITO_BROKER_KILL stops it. Sizing, one-stock-at-a-time and
 * Auto rules live in src/lib/liveBuy.ts; every refusal there says why and sends nothing.
 */
export async function POST(request: NextRequest) {
  try {
    if (!liveOptedIn(process.env)) {
      return Response.json({ ok: false, code: "LIVE_OFF", error: "The live account is not switched on." }, { status: 409, headers: NO_STORE });
    }
    if (!sameOriginRequest(request.headers)) {
      return Response.json({ ok: false, code: "FORBIDDEN", error: "Cross-site request refused." }, { status: 403, headers: NO_STORE });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, code: "INVALID", error: "Body must be JSON." }, { status: 400, headers: NO_STORE });
    }
    const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
    if (!fields || typeof fields.ticker !== "string" || typeof fields.quantity !== "number") {
      return Response.json({ ok: false, code: "INVALID", error: 'Body must be { "ticker": "SYMBOL", "quantity": 1 }.' }, { status: 400, headers: NO_STORE });
    }
    if (fields.requireDrive !== undefined && typeof fields.requireDrive !== "boolean") {
      return Response.json({ ok: false, code: "INVALID", error: "requireDrive must be true or false." }, { status: 400, headers: NO_STORE });
    }
    const settings = liveSettings(process.env);
    if (!settings.ok) {
      return Response.json({ ok: false, code: "CONFIG", error: settings.error }, { status: 500, headers: NO_STORE });
    }
    const broker = createLiveBroker(process.env);
    if (!broker) {
      return Response.json({ ok: false, code: "NOT_CONFIGURED", error: "Live credentials are not configured." }, { status: 503, headers: NO_STORE });
    }
    const autoStore = createAutoStore(process.env);
    const result = await buyLivePosition(
      {
        broker,
        config: liveBrokerConfig(process.env),
        settings: settings.settings,
        readAuto: () => readAutoState(autoStore),
        loadBars: (ticker) => fetchRealMarketData(ticker),
        audit: logAudit,
      },
      fields.ticker,
      fields.quantity,
      { requireDrive: fields.requireDrive === true },
    );
    if (result.ok) return Response.json(result, { headers: NO_STORE });
    return Response.json(result, { status: statusFor(result.code), headers: NO_STORE });
  } catch (e) {
    console.error("Live buy failed:", e instanceof Error ? e.name : "unknown");
    return Response.json({ ok: false, code: "INTERNAL", error: "Unexpected server error." }, { status: 500, headers: NO_STORE });
  }
}
