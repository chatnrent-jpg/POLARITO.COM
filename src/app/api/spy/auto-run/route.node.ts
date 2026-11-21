import { connection } from "next/server";
import { handleAutoRun } from "@/lib/spyAutoRoutes";
import { createLiveDeskDeps } from "@/lib/spyDeskLive";
import { createDeskStore } from "@/lib/spyDeskStore";
import { createSpyKv } from "@/lib/spyKv";

/** Room for a few Alpaca reads and a couple of store writes; the run lock expires after 120 s on its own. */
export const maxDuration = 60;

/**
 * GET /api/spy/auto-run: the scheduled practice-trader run. Bearer CRON_SECRET only (Vercel Cron sends it by itself).
 * Changes the saved practice record and the audit log; it cannot send an order. ?dry=1 changes nothing.
 */
export async function GET(request: Request) {
  await connection();
  return handleAutoRun(request, { env: process.env, makeLive: () => createLiveDeskDeps(process.env), desk: createDeskStore(process.env), kv: createSpyKv(process.env) });
}
