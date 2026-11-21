/**
 * The two Auto HTTP handlers, written against an injected context so they can be tested without a network:
 *   GET  /api/spy/auto-run   the scheduler. Bearer CRON_SECRET only (no session cookie: a cron cannot sign in). Optional ?dry=1
 *                            reads everything and reports what it would do, saving nothing.
 *   POST /api/spy/auto       { on: boolean, acknowledgeDryRun: true }  the trader's on/off switch. Session-gated and same-origin.
 *
 * DRY RUN ONLY: a run changes the saved practice record and the audit log, nothing else. No order can be sent.
 * Fail-closed: no CRON_SECRET (or a short one) means the scheduler route refuses everything.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { sameOriginRequest } from "@/lib/sameOrigin";
import { deskEnabled, type DeskConfig, type DeskDeps, type DeskStore } from "@/lib/spyDesk";
import type { LiveDesk } from "@/lib/spyDeskLive";
import { runAutoCycle, setAutoSwitch } from "@/lib/spyAuto";
import type { SpyKv } from "@/lib/spyKv";

export const CRON_SECRET_ENV = "CRON_SECRET";
export const CRON_SECRET_MIN_LENGTH = 32;

export type AutoRouteContext = {
  env: Readonly<Record<string, string | undefined>>;
  makeLive(): Promise<LiveDesk>;
  desk: DeskStore | null;
  kv: SpyKv | null;
  now?: () => Date;
};

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: NO_STORE_HEADERS });
const off = (): Response => json({ ok: false, code: "DESK_OFF", error: "The SPY desk is switched off on this server." }, 404);

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time check of "Authorization: Bearer <secret>". False when the secret is unset or shorter than 32 characters. */
export function cronAuthorized(authorization: string | null, secret: string | undefined): boolean {
  if (typeof secret !== "string" || secret.length < CRON_SECRET_MIN_LENGTH) return false;
  if (authorization === null) return false;
  const m = /^Bearer (.+)$/.exec(authorization);
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(secret));
}

/** A data source that always says "unavailable", so a missing key is refused and logged like any other bad data. */
function unavailableDeps(error: string, now: () => Date): DeskDeps {
  const fail = { ok: false as const, code: "NETWORK" as const, error };
  return {
    now,
    loadDaily: async () => fail,
    readSpot: async () => fail,
    readSide: async () => {
      throw new Error(error);
    },
    readHeld: async () => null,
  };
}

export async function handleAutoRun(request: Request, ctx: AutoRouteContext): Promise<Response> {
  try {
    if (!deskEnabled(ctx.env)) return off();
    const secret = ctx.env[CRON_SECRET_ENV];
    if (typeof secret !== "string" || secret.length < CRON_SECRET_MIN_LENGTH) {
      return json({ ok: false, code: "NOT_CONFIGURED", error: `${CRON_SECRET_ENV} is not set (or is shorter than ${CRON_SECRET_MIN_LENGTH} characters), so the scheduler route refuses every request.` }, 503);
    }
    if (!cronAuthorized(request.headers.get("authorization"), secret)) return json({ ok: false, code: "UNAUTHORIZED", error: "Unauthorized." }, 401);

    let dryRun = false;
    try {
      dryRun = new URL(request.url).searchParams.get("dry") === "1";
    } catch {
      dryRun = false;
    }
    const clock = ctx.now ?? (() => new Date());
    const live = await ctx.makeLive();
    const deps: DeskDeps = live.ok ? live.deps : unavailableDeps(live.error, clock);
    const config: DeskConfig = live.ok ? live.config : { timeframe: "M", liveBudget: 1000 };
    const res = await runAutoCycle(deps, config, { desk: ctx.desk, kv: ctx.kv }, { dryRun });
    return json({ ok: res.status < 400, dryRun: res.dryRun, outcome: res.outcome, message: res.message, logged: res.logged, repeat: res.repeat }, res.status);
  } catch (e) {
    console.error("SPY auto run failed:", e instanceof Error ? e.name : "unknown");
    return json({ ok: false, code: "INTERNAL", error: "Unexpected server error." }, 500);
  }
}

export async function handleAutoSwitch(request: Request, ctx: AutoRouteContext): Promise<Response> {
  try {
    if (!deskEnabled(ctx.env)) return off();
    if (!sameOriginRequest(request.headers)) return json({ ok: false, code: "FORBIDDEN", error: "Cross-site request refused." }, 403);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, code: "INVALID", error: "Body must be JSON." }, 400);
    }
    const parsed = parseSwitchRequest(body);
    if (!parsed.ok) return json({ ok: false, code: "INVALID", error: parsed.error }, 400);
    const res = await setAutoSwitch(ctx.kv, parsed.on, (ctx.now ?? (() => new Date()))());
    if (!res.ok) return json({ ok: false, code: "AUTO_SWITCH", error: res.error }, res.status);
    return json({ ok: true, dryRun: true, on: res.on, message: res.message });
  } catch (e) {
    console.error("SPY auto switch failed:", e instanceof Error ? e.name : "unknown");
    return json({ ok: false, code: "INTERNAL", error: "Unexpected server error." }, 500);
  }
}

/** Body of POST /api/spy/auto: { on: boolean, acknowledgeDryRun: true }. Exact keys. */
export function parseSwitchRequest(body: unknown): { ok: true; on: boolean } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object." };
  const rec = body as Record<string, unknown>;
  const extra = Object.keys(rec).filter((k) => k !== "on" && k !== "acknowledgeDryRun");
  if (extra.length > 0) return { ok: false, error: `Unexpected field: ${extra[0].slice(0, 30)}.` };
  if (rec.acknowledgeDryRun !== true) return { ok: false, error: "acknowledgeDryRun must be true: Auto only records practice trades, no order is sent." };
  if (typeof rec.on !== "boolean") return { ok: false, error: "on must be true or false." };
  return { ok: true, on: rec.on };
}
