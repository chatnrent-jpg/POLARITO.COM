import type { NextRequest } from "next/server";
import { logAudit } from "@/lib/audit";
import { createLiveBroker, liveBrokerConfig, liveOptedIn, liveSettings } from "@/lib/broker/liveConfig";
import { cronAuthorized } from "@/lib/cronAuth";
import { fetchRealMarketData } from "@/lib/marketApi";
import { MIRROR_TICK_GAP_MS } from "@/lib/mirrorRunner";
import { runPickTick } from "@/lib/pickRunner";

const NO_STORE = { "Cache-Control": "no-store" };

export const maxDuration = 60;

const BUDGET_MS = 50_000;
const MAX_TICKS = 12;

/**
 * GET /api/cron/pick-run[?dry=1][&ticks=N]
 *
 * Live one-stock-a-day runner (src/lib/pickRunner.ts). Does nothing unless
 * POLARITO_PAPER_INSTRUMENT=pick AND POLARITO_LIVE_ACCOUNT=1, so a scheduler can keep
 * calling it harmlessly. Orders also need POLARITO_LIVE_TRADING_ENABLED=1 and an off
 * kill switch; until then every tick only observes and audits. `dry=1` never sends.
 * Auth: `Authorization: Bearer $CRON_SECRET`; no secret => nobody gets in.
 */
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ ok: false, code: "UNAUTHORIZED", error: "Not authorized." }, { status: 401, headers: NO_STORE });
  }
  try {
    const instrument = (process.env.POLARITO_PAPER_INSTRUMENT ?? "stock").trim().toLowerCase();
    if (instrument !== "pick") {
      return Response.json(
        { ok: true, action: "none", reason: "Not in pick mode (POLARITO_PAPER_INSTRUMENT=pick). Nothing to do." },
        { headers: NO_STORE },
      );
    }
    if (!liveOptedIn(process.env)) {
      return Response.json(
        { ok: true, action: "none", reason: "The live account is not switched on (POLARITO_LIVE_ACCOUNT=1). Nothing to do." },
        { headers: NO_STORE },
      );
    }
    const settings = liveSettings(process.env);
    if (!settings.ok) {
      return Response.json({ ok: false, code: "CONFIG", error: settings.error }, { status: 500, headers: NO_STORE });
    }
    const broker = createLiveBroker(process.env);
    if (!broker) {
      return Response.json({ ok: false, code: "NOT_CONFIGURED", error: "Live credentials are not configured." }, { status: 503, headers: NO_STORE });
    }

    const dryRun = request.nextUrl.searchParams.get("dry") === "1";
    const requested = Number(request.nextUrl.searchParams.get("ticks") ?? "1");
    const ticks = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), MAX_TICKS) : 1;

    const deps = {
      broker,
      config: liveBrokerConfig(process.env),
      loadBars: (ticker: string) => fetchRealMarketData(ticker),
      audit: logAudit,
    };
    const started = Date.now();
    const reports = [];
    for (let i = 0; i < ticks; i++) {
      const tickStart = Date.now();
      reports.push(await runPickTick(deps, settings.settings, { dryRun }));
      if (i === ticks - 1) break;
      const wait = Math.max(0, MIRROR_TICK_GAP_MS - (Date.now() - tickStart));
      if (Date.now() - started + wait > BUDGET_MS) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    const ok = reports.every((r) => r.ok);
    return Response.json({ ok, ticks: reports.length, reports }, { status: ok ? 200 : 502, headers: NO_STORE });
  } catch (e) {
    console.error("pick-run failed:", e instanceof Error ? e.name : "unknown");
    return Response.json({ ok: false, code: "INTERNAL", error: "Unexpected server error." }, { status: 500, headers: NO_STORE });
  }
}
