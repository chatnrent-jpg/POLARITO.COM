import { connection } from "next/server";
import { handleLive } from "@/lib/spyDeskRoutes";
import { createLiveDeskDeps } from "@/lib/spyDeskLive";
import { createDeskStore } from "@/lib/spyDeskStore";
import { createSpyKv } from "@/lib/spyKv";

/**
 * GET /api/spy/live: the SPY desk's light data for the 5 s refresh. Read-only: the saved record, the Auto switch and log,
 * the readings (daily bars from a 15 s cache), the SPY price and the one held contract's quote. It cannot read the option
 * chain (see createLiveDeskDeps light mode) and cannot send an order.
 */
export async function GET() {
  // Opt out of build-time prerendering: this answer must be computed per request, never frozen at build.
  await connection();
  return handleLive({ env: process.env, makeLive: () => createLiveDeskDeps(process.env, undefined, { light: true }), store: createDeskStore(process.env), kv: createSpyKv(process.env) });
}
