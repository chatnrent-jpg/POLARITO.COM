import type { NextRequest } from "next/server";
import { handleTicket } from "@/lib/spyDeskRoutes";
import { deskContext } from "@/lib/spyDeskServer";
import { MONTHLY_PROFILE } from "@/lib/spyProfile";

/** POST /api/spy/ticket: a MANUAL dry-run buy at any reading. Changes the saved dry-run position only; no order. */
export async function POST(request: NextRequest) {
  return handleTicket(request, deskContext(MONTHLY_PROFILE));
}
