/**
 * Manual close of a live position, server side. polarito.com's Close button for the
 * live account calls this through POST /api/broker/live/close.
 *
 * Order of operations is Alpaca first, display second: the answer says "accepted"
 * only after Alpaca returned the order, and `flat: true` only after the broker's own
 * position list no longer shows the stock. The browser's quantity is never used:
 * the close flattens the broker's real position under the same id scheme as the
 * automation, so a second click, the automation and a stop-out cannot double-sell.
 */
import { buildAuditRecord, type AuditDraft, type AuditRecord } from "@/lib/audit";
import { tradingGate, type PaperBrokerConfig } from "@/lib/broker/config";
import { placeLiveClose } from "@/lib/broker/liveExecute";
import { deriveDayState } from "@/lib/broker/liveOrders";
import type { LiveBroker, PositionSide } from "@/lib/broker/types";
import { newYorkClock } from "@/lib/paperRunner";
import { isStockPosition } from "@/lib/pickRunner";
import { normalizeTicker } from "@/lib/ticker";

export type LiveCloseDeps = {
  broker: LiveBroker;
  config: PaperBrokerConfig;
  audit: (record: AuditRecord) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type LiveCloseOutcome =
  | {
      ok: true;
      /** submitted: Alpaca accepted a new close. noop: one is already in. observed: live trading is off, nothing sent. none: no such position. */
      status: "submitted" | "noop" | "observed" | "none";
      side?: PositionSide;
      quantity?: number;
      clientOrderId?: string;
      orderId?: string;
      orderStatus?: string;
      /** true only when the broker's own positions no longer list the stock. null when not checked (nothing sent). */
      flat: boolean | null;
      message: string;
    }
  | { ok: false; code: string; error: string; clientOrderId?: string };

const ORDER_LOOKBACK_MS = 36 * 3_600_000;
const FLAT_CHECKS = 6;
const FLAT_CHECK_MS = 400;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function closeLivePosition(deps: LiveCloseDeps, tickerInput: unknown): Promise<LiveCloseOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? defaultSleep;
  const ticker = normalizeTicker(tickerInput);
  if (!ticker) return { ok: false, code: "INVALID", error: "Ticker is not a valid stock symbol." };

  const audit = (draft: Omit<AuditDraft, "source" | "ticker">): void => {
    try {
      deps.audit(buildAuditRecord({ ...draft, source: "live-close", ticker }, now));
    } catch {
      /* logging must not change what was sent */
    }
  };

  try {
    const gate = tradingGate(deps.config, "live");
    if (!gate.ok && gate.code !== "DISABLED") return { ok: false, code: gate.code, error: gate.error };

    const positions = await deps.broker.getPositions();
    if (!positions.ok) return { ok: false, code: "BROKER", error: `Cannot read broker positions: ${positions.error}` };
    const held = positions.value.filter(isStockPosition).find((p) => p.ticker === ticker);
    if (!held) {
      return { ok: true, status: "none", flat: true, message: `No ${ticker} position at the broker. Nothing to close.` };
    }

    if (!gate.ok) {
      audit({ outcome: "dry-run", reason: `Would close ${held.side} ${held.quantity} ${ticker} (live trading is not enabled, so nothing was sent).`, side: held.side, quantity: held.quantity });
      return {
        ok: true,
        status: "observed",
        side: held.side,
        quantity: held.quantity,
        flat: null,
        message: `Live trading is not enabled. Would close ${held.side} ${held.quantity} ${ticker}. Nothing was sent; the position is still open.`,
      };
    }

    const orders = await deps.broker.listOrdersSince(new Date(now.getTime() - ORDER_LOOKBACK_MS).toISOString());
    if (!orders.ok) return { ok: false, code: "BROKER", error: `Cannot read today's orders: ${orders.error}` };
    const state = deriveDayState(orders.value, newYorkClock(now).date);

    const res = await placeLiveClose({ broker: deps.broker, config: deps.config, state, ticker, side: held.side, kind: "close" });
    if (!res.ok) {
      audit({ outcome: res.code === "BROKER" || res.code === "BREAKER" ? "error" : "blocked", reason: res.error, side: held.side, clientOrderId: res.clientOrderId });
      return { ok: false, code: res.code, error: res.error, clientOrderId: res.clientOrderId };
    }

    let flat = false;
    for (let i = 0; i < FLAT_CHECKS && !flat; i++) {
      const again = await deps.broker.getPositions();
      if (again.ok) flat = !again.value.some((p) => p.ticker === ticker);
      if (!flat && i < FLAT_CHECKS - 1) await sleep(FLAT_CHECK_MS);
    }

    if (res.status === "submitted") {
      audit({
        outcome: "closed",
        reason: `Manual close accepted by Alpaca (${res.order.status}). ${flat ? "Position is flat." : "Not filled yet; the position stays shown as open."}`,
        side: held.side,
        quantity: res.order.quantity,
        orderId: res.order.id,
        clientOrderId: res.clientOrderId,
      });
    }
    return {
      ok: true,
      status: res.status,
      side: held.side,
      quantity: held.quantity,
      clientOrderId: res.clientOrderId,
      orderId: res.order?.id,
      orderStatus: res.order?.status,
      flat,
      message: flat
        ? `Alpaca accepted the close and the ${ticker} position is flat.`
        : `Alpaca accepted the close (${res.order?.status ?? "pending"}) but the ${ticker} position is not flat yet. It stays shown as open until Alpaca confirms. ${res.message}`,
    };
  } catch (e) {
    return { ok: false, code: "INTERNAL", error: `Unexpected close failure (${e instanceof Error ? e.name : "error"}).` };
  }
}
