import type { NextRequest } from "next/server";
import { logAudit } from "@/lib/audit";
import { AlpacaPaperBroker } from "@/lib/broker/alpacaPaper";
import { paperBrokerConfig, paperCredentials } from "@/lib/broker/config";
import { cronAuthorized } from "@/lib/cronAuth";
import { fetchRealMarketData } from "@/lib/marketApi";
import { optionsRunnerSettings, runOptionsCycle } from "@/lib/optionsRunner";
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
    const instrument = (process.env.POLARITO_PAPER_INSTRUMENT ?? "stock").trim().toLowerCase();
    if (instrument === "mirror") {
      return Response.json(
        { ok: true, action: "none", reason: "Mirror mode is on. /api/cron/mirror-run handles trading; the daily run does nothing." },
        { headers: NO_STORE },
      );
    }
    if (instrument !== "stock" && instrument !== "options") {
      return Response.json(
        { ok: false, code: "CONFIG", error: 'POLARITO_PAPER_INSTRUMENT must be "stock", "options" or "mirror".' },
        { status: 500, headers: NO_STORE },
      );
    }
    if (instrument === "options") {
      const opts = optionsRunnerSettings(process.env);
      if (!opts.ok) {
        return Response.json({ ok: false, code: "CONFIG", error: opts.error }, { status: 500, headers: NO_STORE });
      }
      const optConfig = paperBrokerConfig(process.env);
      const optCreds = paperCredentials(process.env);
      if (!optCreds) {
        return Response.json(
          { ok: false, code: "NOT_CONFIGURED", error: "Paper credentials are not configured." },
          { status: 503, headers: NO_STORE },
        );
      }
      const optReport = await runOptionsCycle(
        {
          broker: new AlpacaPaperBroker(optCreds),
          config: optConfig,
          loadBars: (ticker) => fetchRealMarketData(ticker),
          audit: logAudit,
        },
        opts.settings,
        { dryRun },
      );
      return Response.json(optReport, { status: optReport.ok ? 200 : 502, headers: NO_STORE });
    }
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
