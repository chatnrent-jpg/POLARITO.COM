import type { NextRequest } from "next/server";
import { handleClose } from "@/lib/spyDeskRoutes";
import { createLiveDeskDeps } from "@/lib/spyDeskLive";
import { createDeskStore } from "@/lib/spyDeskStore";

/** POST /api/spy/close: close the dry-run position by hand. Changes the saved dry-run position only; no order. */
export async function POST(request: NextRequest) {
  return handleClose(request, { env: process.env, makeLive: () => createLiveDeskDeps(process.env), store: createDeskStore(process.env) });
}
