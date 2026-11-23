import type { NextRequest } from "next/server";
import { handleTicket } from "@/lib/spyDeskRoutes";
import { deskContext } from "@/lib/spyDeskServer";
import { WWV_PROFILE } from "@/lib/spyProfile";

/** POST /api/spy-wwv/ticket: a MANUAL dry-run buy at any reading. Changes the saved dry-run position only; no order. */
export async function POST(request: NextRequest) {
  return handleTicket(request, deskContext(WWV_PROFILE));
}
