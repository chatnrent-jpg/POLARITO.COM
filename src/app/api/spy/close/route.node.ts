import type { NextRequest } from "next/server";
import { handleClose } from "@/lib/spyDeskRoutes";
import { deskContext } from "@/lib/spyDeskServer";
import { MONTHLY_PROFILE } from "@/lib/spyProfile";

/** POST /api/spy/close: close the dry-run position by hand. Changes the saved dry-run position only; no order. */
export async function POST(request: NextRequest) {
  return handleClose(request, deskContext(MONTHLY_PROFILE));
}
