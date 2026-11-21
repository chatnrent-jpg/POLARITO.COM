import type { NextRequest } from "next/server";
import { handleTicket } from "@/lib/spyDeskRoutes";
import { createLiveDeskDeps } from "@/lib/spyDeskLive";
import { createDeskStore } from "@/lib/spyDeskStore";
import { createSpyKv } from "@/lib/spyKv";

/** POST /api/spy/ticket: a MANUAL dry-run buy at any reading. Changes the saved dry-run position only; no order. */
export async function POST(request: NextRequest) {
  return handleTicket(request, { env: process.env, makeLive: () => createLiveDeskDeps(process.env), store: createDeskStore(process.env), kv: createSpyKv(process.env) });
}
