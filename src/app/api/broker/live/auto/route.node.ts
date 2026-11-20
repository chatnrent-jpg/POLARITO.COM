import type { NextRequest } from "next/server";
import { buildAuditRecord, logAudit } from "@/lib/audit";
import { liveOptedIn } from "@/lib/broker/liveConfig";
import { createAutoStore, readAutoState } from "@/lib/liveAutoStore";
import { sameOriginRequest } from "@/lib/sameOrigin";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/broker/live/auto   body: { "auto": true | false }
 *
 * The live Auto on/off, behind the Polarito session gate (src/proxy.ts) like the close route,
 * same-origin only. Writes the persisted switch, then reads it back and answers with what the
 * store really holds, so the page never shows a state that was not saved. Without
 * POLARITO_LIVE_ACCOUNT=1 it refuses; without an Auto store it refuses (Auto stays OFF).
 * It sends no order: it only decides whether the runner may place signal-driven ones.
 */
export async function POST(request: NextRequest) {
  try {
    if (!liveOptedIn(process.env)) {
      return Response.json({ ok: false, code: "LIVE_OFF", error: "The live account is not switched on." }, { status: 409, headers: NO_STORE });
    }
    if (!sameOriginRequest(request.headers)) {
      return Response.json({ ok: false, code: "FORBIDDEN", error: "Cross-site request refused." }, { status: 403, headers: NO_STORE });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, code: "INVALID", error: "Body must be JSON." }, { status: 400, headers: NO_STORE });
    }
    const wanted = typeof body === "object" && body !== null ? (body as Record<string, unknown>).auto : undefined;
    if (typeof wanted !== "boolean") {
      return Response.json({ ok: false, code: "INVALID", error: 'Body must be { "auto": true } or { "auto": false }.' }, { status: 400, headers: NO_STORE });
    }
    const store = createAutoStore(process.env);
    if (!store) {
      return Response.json(
        { ok: false, code: "NO_STORE", error: "No Auto store is configured (KV_REST_API_URL / KV_REST_API_TOKEN). Auto stays OFF." },
        { status: 503, headers: NO_STORE },
      );
    }
    const written = await store.write(wanted);
    if (!written.ok) {
      return Response.json({ ok: false, code: "STORE", error: `${written.error} Auto was not changed.` }, { status: 502, headers: NO_STORE });
    }
    const state = await readAutoState(store);
    if (state.on !== wanted) {
      return Response.json({ ok: false, code: "STORE", error: "The Auto store did not keep the change. Check the state shown.", auto: state }, { status: 502, headers: NO_STORE });
    }
    try {
      logAudit(
        buildAuditRecord({
          source: "live-auto",
          ticker: "PICK",
          outcome: "held",
          reason: wanted
            ? "Live Auto switched ON from the site: the runner may place signal-driven entries and closes."
            : "Live Auto switched OFF from the site: no entries or signal-driven closes (stop-out and flatten still run).",
        }),
      );
    } catch {
      /* logging must not change the answer */
    }
    return Response.json({ ok: true, auto: { available: true, on: state.on, reason: state.reason, at: state.at } }, { headers: NO_STORE });
  } catch (e) {
    console.error("Live auto failed:", e instanceof Error ? e.name : "unknown");
    return Response.json({ ok: false, code: "INTERNAL", error: "Unexpected server error." }, { status: 500, headers: NO_STORE });
  }
}
