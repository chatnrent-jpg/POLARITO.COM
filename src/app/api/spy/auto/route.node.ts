import type { NextRequest } from "next/server";
import { handleAutoSwitch } from "@/lib/spyAutoRoutes";
import { createLiveDeskDeps } from "@/lib/spyDeskLive";
import { createDeskStore } from "@/lib/spyDeskStore";
import { createSpyKv } from "@/lib/spyKv";

/** POST /api/spy/auto: switch the practice trader on or off (default OFF). Changes the saved switch only; no order. */
export async function POST(request: NextRequest) {
  return handleAutoSwitch(request, { env: process.env, makeLive: () => createLiveDeskDeps(process.env), desk: createDeskStore(process.env), kv: createSpyKv(process.env) });
}
