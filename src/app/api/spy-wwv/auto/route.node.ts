import type { NextRequest } from "next/server";
import { handleAutoSwitch } from "@/lib/spyAutoRoutes";
import { autoContext } from "@/lib/spyDeskServer";
import { WWV_PROFILE } from "@/lib/spyProfile";

/** POST /api/spy-wwv/auto: switch this desk's practice trader on or off (default OFF). Changes the saved switch only; no order. */
export async function POST(request: NextRequest) {
  return handleAutoSwitch(request, autoContext(WWV_PROFILE));
}
