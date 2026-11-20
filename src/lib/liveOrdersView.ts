import { createLiveBroker, liveOptedIn } from "@/lib/broker/liveConfig";
import type { BrokerOrder } from "@/lib/broker/types";

const LOOKBACK_MS = 7 * 24 * 3_600_000;
export const MAX_LIVE_ORDER_ROWS = 50;

export type LiveOrdersResponse =
  | { status: 200; body: { ok: true; live: false } }
  | { status: 200; body: { ok: true; live: true; orders: BrokerOrder[] } }
  | { status: 500 | 502 | 503; body: { ok: false; live: true; code: string; error: string } };

/**
 * Read-only list of the live account's recent real orders (last 7 days, newest first, capped), straight from Alpaca.
 * Without POLARITO_LIVE_ACCOUNT=1 it touches nothing. It never places or cancels an order and never returns
 * credentials. An unreadable list is an error, never an empty list.
 */
export async function readLiveOrders(env: Record<string, string | undefined>, now = Date.now()): Promise<LiveOrdersResponse> {
  if (!liveOptedIn(env)) return { status: 200, body: { ok: true, live: false } };
  const broker = createLiveBroker(env);
  if (!broker) return { status: 503, body: { ok: false, live: true, code: "NOT_CONFIGURED", error: "Live credentials are not configured." } };
  try {
    const res = await broker.listOrdersSince(new Date(now - LOOKBACK_MS).toISOString());
    if (!res.ok) return { status: 502, body: { ok: false, live: true, code: res.code, error: res.error } };
    const orders = [...res.value].reverse().slice(0, MAX_LIVE_ORDER_ROWS);
    return { status: 200, body: { ok: true, live: true, orders } };
  } catch (e) {
    console.error("Live orders failed:", e instanceof Error ? e.name : "unknown");
    return { status: 500, body: { ok: false, live: true, code: "INTERNAL", error: "Unexpected server error." } };
  }
}
