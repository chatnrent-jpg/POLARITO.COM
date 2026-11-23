import { connection } from "next/server";
import { handleSnapshot } from "@/lib/spyDeskRoutes";
import { deskContext } from "@/lib/spyDeskServer";
import { MONTHLY_PROFILE } from "@/lib/spyProfile";

/** GET /api/spy/desk: the SPY desk's data. Read-only market data plus the saved dry-run state; flag POLARITO_SPY_DESK=1. */
export async function GET() {
  await connection();
  return handleSnapshot(deskContext(MONTHLY_PROFILE));
}
