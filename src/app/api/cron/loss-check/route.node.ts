import type { NextRequest } from "next/server";
import { logAudit } from "@/lib/audit";
import { AlpacaPaperBroker } from "@/lib/broker/alpacaPaper";
import { paperBrokerConfig, paperCredentials } from "@/lib/broker/config";
import { cronAuthorized } from "@/lib/cronAuth";
import { runLossCheck } from "@/lib/optionsLossCheck";
import { optionsDailyLossLimit } from "@/lib/optionsLossLimit";
import { paperRunnerSettings } from "@/lib/paperRunner";
import { createLiveBroker, liveBrokerConfig, liveOptedIn, liveSettings } from "@/lib/broker/liveConfig";
import { fetchRealMarketData } from "@/lib/marketApi";
import { runPickTick } from "@/lib/pickRunner";

const NO_STORE = { "Cache-Control": "no-store" };

export const maxDuration = 60;

/**
 * GET /api/cron/loss-check[?dry=1]
 *
 * Called every ~30 minutes during the regular session by an outside timer
 * (.github/workflows/loss-check.yml). Options mode only. It reads no signal and
 * buys nothing: if the account is down 1% (POLARITO_OPTIONS_DAILY_LOSS_PCT) on the day it sells every option and
 * stands aside until the next session. Authenticates like the paper runner:
 * `Authorization: Bearer $CRON_SECRET`; no secret => nobody gets in.
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
    if (instrument === "pick" && liveOptedIn(process.env)) {
      // Backstop for the live pick: stop-out and end-of-day flatten only. It reads no signal and enters nothing.
      const live = liveSettings(process.env);
      if (!live.ok) {
        return Response.json({ ok: false, code: "CONFIG", error: live.error }, { status: 500, headers: NO_STORE });
      }
      const liveBroker = createLiveBroker(process.env);
      if (!liveBroker) {
        return Response.json(
          { ok: false, code: "NOT_CONFIGURED", error: "Live credentials are not configured." },
          { status: 503, headers: NO_STORE },
        );
      }
      const pickReport = await runPickTick(
        {
          broker: liveBroker,
          config: liveBrokerConfig(process.env),
          loadBars: (ticker) => fetchRealMarketData(ticker),
          audit: logAudit,
        },
        live.settings,
        { dryRun: request.nextUrl.searchParams.get("dry") === "1", lossOnly: true },
      );
      return Response.json(pickReport, { status: pickReport.ok ? 200 : 502, headers: NO_STORE });
    }
    if (instrument !== "options") {
      return Response.json(
        { ok: true, action: "none", reason: "Not in options mode. Nothing to check." },
        { headers: NO_STORE },
      );
    }
    const settings = paperRunnerSettings(process.env);
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
    const report = await runLossCheck(
      { broker: new AlpacaPaperBroker(creds), config: paperBrokerConfig(process.env), audit: logAudit },
      { watchlist: settings.settings.watchlist, dailyLossLimit: optionsDailyLossLimit(process.env) },
      { dryRun: request.nextUrl.searchParams.get("dry") === "1" },
    );
    return Response.json(report, { status: report.ok ? 200 : 502, headers: NO_STORE });
  } catch (e) {
    console.error("loss-check failed:", e instanceof Error ? e.name : "unknown");
    return Response.json(
      { ok: false, code: "INTERNAL", error: "Unexpected server error." },
      { status: 500, headers: NO_STORE },
    );
  }
}
