import type { NextRequest } from "next/server";
import { handleClose } from "@/lib/spyDeskRoutes";
import { deskContext } from "@/lib/spyDeskServer";
import { WWV_PROFILE } from "@/lib/spyProfile";

/** POST /api/spy-wwv/close: close the dry-run position by hand. Changes the saved dry-run position only; no order. */
export async function POST(request: NextRequest) {
  return handleClose(request, deskContext(WWV_PROFILE));
}
