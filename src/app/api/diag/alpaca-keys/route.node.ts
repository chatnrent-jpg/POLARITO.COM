import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { diagRequestAllowed, runKeyDiagnostic } from "@/lib/keyDiagnostic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/diag/alpaca-keys
 * Read-only, behind the Polarito session gate (src/proxy.ts), same-origin / address-bar only. Reports what the
 * server sees for each Alpaca credential pair (presence, first two characters and length of a key ID, secret
 * length, odd-character flags) and the HTTP status plus Alpaca's message of one real authenticated test call per
 * pair, plus which deployment answered. It never returns a secret or a full key ID, places no order, writes nothing.
 */
export async function GET(request: NextRequest) {
  await connection();
  try {
    if (!diagRequestAllowed(request.headers)) {
      return Response.json({ ok: false, code: "FORBIDDEN", error: "Cross-site request refused." }, { status: 403, headers: NO_STORE });
    }
    const report = await runKeyDiagnostic(process.env, (url, init) => fetch(url, { ...init, cache: "no-store" }));
    return Response.json(report, { headers: NO_STORE });
  } catch {
    return Response.json({ ok: false, code: "INTERNAL", error: "Diagnostic failed." }, { status: 500, headers: NO_STORE });
  }
}
