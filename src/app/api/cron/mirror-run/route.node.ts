import type { NextRequest } from "next/server";
import { logAudit } from "@/lib/audit";
import { AlpacaPaperBroker } from "@/lib/broker/alpacaPaper";
import { paperBrokerConfig, paperCredentials } from "@/lib/broker/config";
import { cronAuthorized } from "@/lib/cronAuth";
import { fetchRealMarketData } from "@/lib/marketApi";
import { MIRROR_TICK_GAP_MS, mirrorSettings, runMirrorTick } from "@/lib/mirrorRunner";

const NO_STORE = { "Cache-Control": "no-store" };

export const maxDuration = 60;

/** Stop starting new ticks after this long, so the function always finishes inside maxDuration. */
const BUDGET_MS = 50_000;
const MAX_TICKS = 12;

/**
 * GET /api/cron/mirror-run[?dry=1][&ticks=N]
 *
 * Live mirror of POLARITO's SPY polarity (see src/lib/mirrorRunner.ts). Only
 * active when POLARITO_PAPER_INSTRUMENT=mirror; in any other mode it does
 * nothing, so a scheduler can keep calling it harmlessly.
 *
 * One call runs `ticks` ticks (default 1, max 12) spaced like the dashboard's
 * 5s refresh, so a once-a-minute trigger still follows the signal every 5s.
 * Auth: `Authorization: Bearer $CRON_SECRET`; no secret => nobody gets in.
 */
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json(
      { ok: false, code: "UNAUTHORIZED", error: "Not authorized." },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    const instrument = (process.env.POLARITO_PAPER_INSTRUMENT ?? "stock").trim().toLowerCase();
    if (instrument !== "mirror") {
      return Response.json(
        { ok: true, action: "none", reason: "Not in mirror mode (POLARITO_PAPER_INSTRUMENT=mirror). Nothing to do." },
        { headers: NO_STORE },
      );
    }
    const settings = mirrorSettings(process.env);
    if (!settings.ok) {
      return Response.json({ ok: false, code: "CONFIG", error: settings.error }, { status: 500, headers: NO_STORE });
    }
    const creds = paperCredentials(process.env);
    if (!creds) {
      return Response.json(
        { ok: false, code: "NOT_CONFIGURED", error: "Paper credentials are not configured." },
        { status: 503, headers: NO_STORE },
      );
    }

    const dryRun = request.nextUrl.searchParams.get("dry") === "1";
    const requested = Number(request.nextUrl.searchParams.get("ticks") ?? "1");
    const ticks = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), MAX_TICKS) : 1;

    const deps = {
      broker: new AlpacaPaperBroker(creds),
      config: paperBrokerConfig(process.env),
      loadBars: (ticker: string) => fetchRealMarketData(ticker),
      audit: logAudit,
    };
    const started = Date.now();
    const reports = [];
    for (let i = 0; i < ticks; i++) {
      const tickStart = Date.now();
      reports.push(await runMirrorTick(deps, settings.settings, { dryRun }));
      if (i === ticks - 1) break;
      const wait = Math.max(0, MIRROR_TICK_GAP_MS - (Date.now() - tickStart));
      if (Date.now() - started + wait > BUDGET_MS) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    const ok = reports.every((r) => r.ok);
    return Response.json({ ok, ticks: reports.length, reports }, { status: ok ? 200 : 502, headers: NO_STORE });
  } catch (e) {
    console.error("mirror-run failed:", e instanceof Error ? e.name : "unknown");
    return Response.json(
      { ok: false, code: "INTERNAL", error: "Unexpected server error." },
      { status: 500, headers: NO_STORE },
    );
  }
}
