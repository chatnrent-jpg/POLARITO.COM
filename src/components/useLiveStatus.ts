"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type LivePosition = { ticker: string; side: "long" | "short"; quantity: number; avgEntryPrice: number };
export type LiveStatus = {
  ok: boolean;
  live?: boolean;
  enabled?: boolean;
  killed?: boolean;
  configured?: boolean;
  tradingAllowed?: boolean;
  blockedReason?: string;
  error?: string;
  account?: { equity: number; lastEquity: number; cash: number; buyingPower: number };
  positions?: LivePosition[];
  manual?: { watchlist: string[]; defaultQuantity: number; error?: string };
  day?: { date: string; entries: number; lockedTicker: string | null; stoppedToday: boolean };
  auto?: { available: boolean; on: boolean; reason: string; at: string | null; openPositions: number; openOrders: number };
};

const REFRESH_MS = 5_000;

export type LiveFeed = {
  status: LiveStatus | null;
  loadError: string | null;
  reload: () => Promise<void>;
  /**
   * True only when the server says live orders can really be sent: live account on, live trading enabled,
   * kill switch off, keys present. Anything else (still loading, unreadable, off) is false, i.e. the ticket stays simulated.
   */
  liveOrders: boolean;
};

/** The live account, read from Alpaca through /api/broker/live/status. Stops polling once the server says live is off. */
export function useLiveStatus(): LiveFeed {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const liveOff = useRef(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/broker/live/status", { cache: "no-store" });
      const data = (await res.json()) as LiveStatus;
      liveOff.current = data.live === false;
      setStatus(data);
      setLoadError(data.ok ? null : (data.error ?? "Live status failed."));
    } catch {
      setLoadError("Could not reach the live status route.");
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void reload(), 0);
    const id = window.setInterval(() => {
      if (!liveOff.current) void reload();
    }, REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [reload]);

  const liveOrders = status?.live === true && status.tradingAllowed === true && status.ok === true;
  return { status, loadError, reload, liveOrders };
}
