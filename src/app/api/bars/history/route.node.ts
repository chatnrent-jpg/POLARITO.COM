import type { NextRequest } from "next/server";
import {
  fetchRealMarketData,
  HISTORY_LOOKBACK_CALENDAR_DAYS,
  MarketApiError,
  TimeframeFirewallError,
} from "@/lib/marketApi";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/bars/history?ticker=SPY -> { ok: true, ticker, bars } | { ok: false, code, error }
 *
 * Chart-only: the same daily bars as /api/bars but reaching back years, so the
 * quarterly and yearly candles can be real. No sentiment, no signal: the
 * dashboard's analysis still runs on /api/bars. Read once per ticker by the browser.
 */
export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker") ?? "";
  try {
    const bars = await fetchRealMarketData(ticker, {}, { lookbackDays: HISTORY_LOOKBACK_CALENDAR_DAYS });
    return Response.json({ ok: true, ticker: ticker.trim().toUpperCase(), bars }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof MarketApiError) {
      return Response.json({ ok: false, code: e.code, error: e.message }, { status: e.status, headers: NO_STORE });
    }
    if (e instanceof TimeframeFirewallError) {
      console.error(e.message);
      return Response.json({ ok: false, code: "FIREWALL", error: e.message }, { status: 500, headers: NO_STORE });
    }
    console.error("Unexpected /api/bars/history failure:", e instanceof Error ? e.name : "unknown");
    return Response.json({ ok: false, code: "INTERNAL", error: "Unexpected server error." }, { status: 500, headers: NO_STORE });
  }
}
