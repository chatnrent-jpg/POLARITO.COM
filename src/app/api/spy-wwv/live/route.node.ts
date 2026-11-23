import { connection } from "next/server";
import { handleLive } from "@/lib/spyDeskRoutes";
import { deskContext } from "@/lib/spyDeskServer";
import { WWV_PROFILE } from "@/lib/spyProfile";

/**
 * GET /api/spy-wwv/live: the desk's light data for the 5 s refresh. Read-only: the saved record, the Auto switch and log, the readings
 * (daily bars from a 15 s cache), the SPY price and the one held contract's quote. It cannot read the option chain (light mode)
 * and cannot send an order.
 */
export async function GET() {
  await connection();
  return handleLive(deskContext(WWV_PROFILE, process.env, { light: true }));
}
