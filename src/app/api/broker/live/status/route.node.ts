import { connection } from "next/server";
import { deriveDayState } from "@/lib/broker/liveOrders";
import { createLiveBroker, liveBrokerConfig, liveOptedIn, liveSettings } from "@/lib/broker/liveConfig";
import { tradingGate } from "@/lib/broker/config";
import { createAutoStore, readAutoState } from "@/lib/liveAutoStore";
import { LIVE_LIMITS, liveLimitsView, slotUse } from "@/lib/liveLimits";
import { newYorkClock } from "@/lib/paperRunner";
import { isStockPosition } from "@/lib/pickRunner";

const NO_STORE = { "Cache-Control": "no-store" };
const ORDER_LOOKBACK_MS = 36 * 3_600_000;

/**
 * GET /api/broker/live/status
 * Read-only, behind the Polarito session gate (src/proxy.ts). Without the live opt-in
 * (POLARITO_LIVE_ACCOUNT=1) it answers `{ live: false }` and touches nothing. With it,
 * it reports the LIVE account, positions and the day's pick state straight from Alpaca.
 * It never places an order and never returns credentials.
 */
export async function GET() {
  await connection();
  if (!liveOptedIn(process.env)) {
    return Response.json({ ok: true, live: false }, { headers: NO_STORE });
  }
  const config = liveBrokerConfig(process.env);
  const gate = tradingGate(config, "live");
  const base = {
    live: true as const,
    mode: "live" as const,
    enabled: config.enabled,
    killed: config.killed,
    configured: config.configured,
    tradingAllowed: gate.ok,
    ...(gate.ok ? {} : { blockedReason: gate.error }),
  };
  const broker = createLiveBroker(process.env);
  if (!broker) return Response.json({ ok: true, ...base }, { headers: NO_STORE });

  try {
    const now = new Date();
    const [account, positions, orders, openOrders] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      broker.listOrdersSince(new Date(now.getTime() - ORDER_LOOKBACK_MS).toISOString()),
      broker.listOpenOrders(),
    ]);
    for (const r of [account, positions, orders, openOrders]) {
      if (!r.ok) {
        return Response.json({ ok: false, ...base, code: r.code, error: r.error }, { status: 502, headers: NO_STORE });
      }
    }
    if (!account.ok || !positions.ok || !orders.ok || !openOrders.ok) throw new Error("unreachable");
    const state = deriveDayState(orders.value, newYorkClock(now).date);
    const auto = await readAutoState(createAutoStore(process.env));
    const settings = liveSettings(process.env);
    const slots = slotUse(positions.value, openOrders.value, settings.ok ? settings.settings.maxPositions : LIVE_LIMITS.maxPositions);
    return Response.json(
      {
        ok: true,
        ...base,
        account: account.value,
        positions: positions.value.filter(isStockPosition),
        auto: { available: auto.available, on: auto.on, reason: auto.reason, at: auto.at, openPositions: positions.value.length, openOrders: openOrders.value.length },
        manual: settings.ok
          ? { watchlist: settings.settings.watchlist, defaultQuantity: settings.settings.quantity }
          : { watchlist: [] as string[], defaultQuantity: 1, error: settings.error },
        limits: liveLimitsView(settings.ok ? settings.settings : null, slots.used),
        day: {
          date: state.date,
          entries: state.entryCount,
          lockedTicker: state.lockTicker,
          enteredTickers: state.enteredTickers,
          stoppedToday: state.stoppedToday,
        },
      },
      { headers: NO_STORE },
    );
  } catch (e) {
    console.error("Live status failed:", e instanceof Error ? e.name : "unknown");
    return Response.json({ ok: false, ...base, code: "INTERNAL", error: "Unexpected server error." }, { status: 500, headers: NO_STORE });
  }
}
