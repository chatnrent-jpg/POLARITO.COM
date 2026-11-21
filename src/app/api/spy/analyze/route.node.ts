import { connection } from "next/server";
import { handleAnalyze } from "@/lib/spyDeskRoutes";
import { createLiveDeskDeps } from "@/lib/spyDeskLive";

/**
 * GET /api/spy/analyze?ticker=SPY: "Analyze" for the manual ticket. Reads the daily bars (fresh, not from the light cache)
 * and computes the monthly gear with the same code the ticket route re-runs. Read-only; it never reads the option chain,
 * holds no store and cannot send an order.
 */
export async function GET(request: Request) {
  await connection();
  return handleAnalyze(request, { env: process.env, makeLive: () => createLiveDeskDeps(process.env), store: null });
}
