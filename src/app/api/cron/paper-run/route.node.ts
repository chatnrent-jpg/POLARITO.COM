import type { NextRequest } from "next/server";
import { logAudit } from "@/lib/audit";
import { AlpacaPaperBroker } from "@/lib/broker/alpacaPaper";
import { paperBrokerConfig, paperCredentials } from "@/lib/broker/config";
import { cronAuthorized } from "@/lib/cronAuth";
import { fetchRealMarketData } from "@/lib/marketApi";
import { paperRunnerSettings, runPaperCycle } from "@/lib/paperRunner";

const NO_STORE = { "Cache-Control": "no-store" };

export const maxDuration = 60;

/**
 * GET /api/cron/paper-run[?dry=1]
 *
 * Scheduled once per weekday after the US close (vercel.json). It skips the
 * browser session gate (a scheduler has no cookie) and authenticates with
 * `Authorization: Bearer $CRON_SECRET` instead; no secret => nobody gets in.
 *
 * `dry=1` computes and audits every decision but sends no order.
 */
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json(
      { ok: false, code: "UNAUTHORIZED", error: "Not authorized." },
      { status: 401, headers: NO_STORE },
    );
  }

  const dryRun = request.nextUrl.searchParams.get("dry") === "1";
  try {
    const settings = paperRunnerSettings(process.env);
    if (!settings.ok) {
      return Response.json(
        { ok: false, code: "CONFIG", error: settings.error },
        { status: 500, headers: NO_STORE },
      );
    }
    const config = paperBrokerConfig(process.env);
    const creds = paperCredentials(process.env);
    if (!creds) {
      return Response.json(
        { ok: false, code: "NOT_CONFIGURED", error: "Paper credentials are not configured." },
        { status: 503, headers: NO_STORE },
      );
    }
    const report = await runPaperCycle(
      {
        broker: new AlpacaPaperBroker(creds),
        config,
        loadBars: (ticker) => fetchRealMarketData(ticker),
        audit: logAudit,
      },
      settings.settings,
      { dryRun },
    );
    return Response.json(report, { status: report.ok ? 200 : 502, headers: NO_STORE });
  } catch (e) {
    console.error("paper-run failed:", e instanceof Error ? e.name : "unknown");
    return Response.json(
      { ok: false, code: "INTERNAL", error: "Unexpected server error." },
      { status: 500, headers: NO_STORE },
    );
  }
}
