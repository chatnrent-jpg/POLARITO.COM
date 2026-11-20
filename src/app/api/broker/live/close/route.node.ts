import type { NextRequest } from "next/server";
import { logAudit } from "@/lib/audit";
import { createLiveBroker, liveBrokerConfig, liveOptedIn } from "@/lib/broker/liveConfig";
import { closeLivePosition } from "@/lib/liveClose";
import { sameOriginRequest } from "@/lib/sameOrigin";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/broker/live/close   body: { "ticker": "NVDA" }
 *
 * Behind the Polarito session gate (src/proxy.ts); never under /api/cron/. Places a real
 * sell (long) or buy-to-cover (short) for the BROKER's own quantity, with the live close id
 * scheme. The response says the position is closed (`flat: true`) only after Alpaca's own
 * position list no longer shows it. Without POLARITO_LIVE_ACCOUNT=1 it refuses and does nothing.
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
    const ticker = typeof body === "object" && body !== null ? (body as Record<string, unknown>).ticker : undefined;
    if (typeof ticker !== "string") {
      return Response.json({ ok: false, code: "INVALID", error: 'Body must be { "ticker": "SYMBOL" }.' }, { status: 400, headers: NO_STORE });
    }
    const broker = createLiveBroker(process.env);
    if (!broker) {
      return Response.json({ ok: false, code: "NOT_CONFIGURED", error: "Live credentials are not configured." }, { status: 503, headers: NO_STORE });
    }
    const result = await closeLivePosition({ broker, config: liveBrokerConfig(process.env), audit: logAudit }, ticker);
    if (result.ok) return Response.json(result, { headers: NO_STORE });
    const status = result.code === "INVALID" ? 400 : result.code === "KILLED" || result.code === "NOT_CONFIGURED" ? 409 : 502;
    return Response.json(result, { status, headers: NO_STORE });
  } catch (e) {
    console.error("Live close failed:", e instanceof Error ? e.name : "unknown");
    return Response.json({ ok: false, code: "INTERNAL", error: "Unexpected server error." }, { status: 500, headers: NO_STORE });
  }
}
