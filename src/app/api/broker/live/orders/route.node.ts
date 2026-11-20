import { connection } from "next/server";
import { readLiveOrders } from "@/lib/liveOrdersView";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/broker/live/orders
 * Read-only, behind the Polarito session gate (src/proxy.ts). See readLiveOrders: lists the live account's
 * recent real orders from Alpaca, never places or cancels anything, never returns credentials.
 */
export async function GET() {
  await connection();
  const out = await readLiveOrders(process.env);
  return Response.json(out.body, { status: out.status, headers: NO_STORE });
}
