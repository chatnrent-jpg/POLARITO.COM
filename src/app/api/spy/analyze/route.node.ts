import { connection } from "next/server";
import { handleAnalyze } from "@/lib/spyDeskRoutes";
import { deskContext } from "@/lib/spyDeskServer";
import { MONTHLY_PROFILE } from "@/lib/spyProfile";

/**
 * GET /api/spy/analyze?ticker=SPY: "Analyze" for the manual ticket. Reads the daily bars (fresh, not from the light cache) and
 * computes the gear with the same code the ticket route re-runs. Read-only; it never reads the option chain, holds no store
 * and cannot send an order.
 */
export async function GET(request: Request) {
  await connection();
  return handleAnalyze(request, deskContext(MONTHLY_PROFILE, process.env, { readOnly: true }));
}
