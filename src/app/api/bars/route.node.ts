import type { NextRequest } from "next/server";
import {
  fetchMarketDataWithSentiment,
  MarketApiError,
  TimeframeFirewallError,
} from "@/lib/marketApi";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/bars?ticker=NVDA  ->  { ok: true, ticker, bars, sentiment } | { ok: false, code, error } */
export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker") ?? "";

  try {
    const { bars, sentiment } = await fetchMarketDataWithSentiment(ticker);
    return Response.json(
      { ok: true, ticker: ticker.trim().toUpperCase(), bars, sentiment },
      { headers: NO_STORE },
    );
  } catch (e) {
    if (e instanceof MarketApiError) {
      return Response.json(
        { ok: false, code: e.code, error: e.message },
        { status: e.status, headers: NO_STORE },
      );
    }
    if (e instanceof TimeframeFirewallError) {
      console.error(e.message);
      return Response.json(
        { ok: false, code: "FIREWALL", error: e.message },
        { status: 500, headers: NO_STORE },
      );
    }
    console.error("Unexpected /api/bars failure:", e instanceof Error ? e.name : "unknown");
    return Response.json(
      { ok: false, code: "INTERNAL", error: "Unexpected server error." },
      { status: 500, headers: NO_STORE },
    );
  }
}
