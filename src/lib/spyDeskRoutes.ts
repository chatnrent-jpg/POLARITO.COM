/**
 * The three SPY desk HTTP handlers, written against an injected context so they can be tested without a network:
 *   GET  /api/spy/desk    the page's data (reads market data and the saved dry-run state; writes nothing)
 *   POST /api/spy/ticket  { type, symbol, acknowledgeDryRun: true }  record a MANUAL dry-run buy (Neutral reading only)
 *   POST /api/spy/close   { acknowledgeDryRun: true, unpriced?: boolean }  close the dry-run position by hand
 *
 * Behind the Polarito session gate (src/proxy.ts) and the POLARITO_SPY_DESK=1 flag; the two POST routes are same-origin
 * only. None of them can send an order: they change the saved dry-run record and nothing else.
 */
import { sameOriginRequest } from "@/lib/sameOrigin";
import { buildDeskSnapshot, closeManual, deskEnabled, openManual, parseCloseRequest, parseTicketRequest, type DeskStore } from "@/lib/spyDesk";
import type { LiveDesk } from "@/lib/spyDeskLive";

export type DeskContext = {
  env: Readonly<Record<string, string | undefined>>;
  makeLive(): Promise<LiveDesk>;
  store: DeskStore | null;
};

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: NO_STORE_HEADERS });
const off = (): Response => json({ ok: false, code: "DESK_OFF", error: "The SPY desk is switched off on this server." }, 404);
const internal = (): Response => json({ ok: false, code: "INTERNAL", error: "Unexpected server error." }, 500);

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

export async function handleSnapshot(ctx: DeskContext): Promise<Response> {
  try {
    if (!deskEnabled(ctx.env)) return off();
    const live = await ctx.makeLive();
    if (!live.ok) return json({ ok: false, code: live.code, error: `Data unavailable: ${live.error}` }, 503);
    return json(await buildDeskSnapshot(live.deps, live.config, ctx.store));
  } catch (e) {
    console.error("SPY desk snapshot failed:", e instanceof Error ? e.name : "unknown");
    return internal();
  }
}

export async function handleTicket(request: Request, ctx: DeskContext): Promise<Response> {
  try {
    if (!deskEnabled(ctx.env)) return off();
    if (!sameOriginRequest(request.headers)) return json({ ok: false, code: "FORBIDDEN", error: "Cross-site request refused." }, 403);
    const body = await readJson(request);
    if (!body.ok) return json({ ok: false, code: "INVALID", error: "Body must be JSON." }, 400);
    const parsed = parseTicketRequest(body.body);
    if (!parsed.ok) return json({ ok: false, code: "INVALID", error: parsed.error }, 400);
    const live = await ctx.makeLive();
    if (!live.ok) return json({ ok: false, code: live.code, error: `Data unavailable: ${live.error} Nothing was recorded.` }, 503);
    const res = await openManual(live.deps, live.config, ctx.store, parsed.value);
    if (!res.ok) return json({ ok: false, code: res.code, error: res.error }, res.status);
    return json({ ok: true, dryRun: true, message: res.message, entry: res.entry });
  } catch (e) {
    console.error("SPY desk ticket failed:", e instanceof Error ? e.name : "unknown");
    return internal();
  }
}

export async function handleClose(request: Request, ctx: DeskContext): Promise<Response> {
  try {
    if (!deskEnabled(ctx.env)) return off();
    if (!sameOriginRequest(request.headers)) return json({ ok: false, code: "FORBIDDEN", error: "Cross-site request refused." }, 403);
    const body = await readJson(request);
    if (!body.ok) return json({ ok: false, code: "INVALID", error: "Body must be JSON." }, 400);
    const parsed = parseCloseRequest(body.body);
    if (!parsed.ok) return json({ ok: false, code: "INVALID", error: parsed.error }, 400);
    const live = await ctx.makeLive();
    if (!live.ok) return json({ ok: false, code: live.code, error: `Data unavailable: ${live.error} Nothing was changed.` }, 503);
    const res = await closeManual(live.deps, ctx.store, parsed.value);
    if (!res.ok) return json({ ok: false, code: res.code, error: res.error }, res.status);
    return json({ ok: true, dryRun: true, message: res.message, entry: res.entry });
  } catch (e) {
    console.error("SPY desk close failed:", e instanceof Error ? e.name : "unknown");
    return internal();
  }
}
