import { connection } from "next/server";
import LiveBrokerPanel from "@/components/LiveBrokerPanel";
import { liveOptedIn } from "@/lib/broker/liveConfig";

/**
 * Renders the live-account panel only when the server has the live opt-in
 * (POLARITO_LIVE_ACCOUNT=1). Otherwise it renders nothing and the page is
 * exactly what it was before live trading existed (no panel, no extra request).
 */
export default async function LiveBrokerGate() {
  await connection();
  if (!liveOptedIn(process.env)) return null;
  return <LiveBrokerPanel />;
}
