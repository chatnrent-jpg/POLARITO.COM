import { connection } from "next/server";
import { handleSnapshot } from "@/lib/spyDeskRoutes";
import { createLiveDeskDeps } from "@/lib/spyDeskLive";
import { createDeskStore } from "@/lib/spyDeskStore";

/** GET /api/spy/desk: the SPY desk's data. Read-only market data plus the saved dry-run state; flag POLARITO_SPY_DESK=1. */
export async function GET() {
  // Opt out of build-time prerendering: this answer must be computed per request, never frozen at build.
  await connection();
  return handleSnapshot({ env: process.env, makeLive: () => createLiveDeskDeps(process.env), store: createDeskStore(process.env) });
}
