"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { deriveLiveMode, type LiveMode, type LiveStatus } from "@/lib/liveMode";

const REFRESH_MS = 5_000;

export type LiveFeed = { mode: LiveMode; reload: () => Promise<void> };

const SIM: LiveFeed = { mode: { kind: "sim" }, reload: async () => {} };
const LiveModeContext = createContext<LiveFeed>(SIM);

/**
 * One shared read of the live account for every display (account card, ledger, order ticket, live block).
 * `optIn` comes from the server (POLARITO_LIVE_ACCOUNT=1); without it nothing is fetched and every display
 * stays on today's simulated data. With it, the status route is polled every 5s and the answer is turned into
 * a single mode (see src/lib/liveMode.ts), so the screen never mixes simulated and live numbers.
 */
export default function LiveModeProvider({ optIn, children }: { optIn: boolean; children: ReactNode }) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!optIn) return;
    try {
      const res = await fetch("/api/broker/live/status", { cache: "no-store" });
      const data = (await res.json()) as LiveStatus;
      setStatus(data);
      setLoadError(null);
    } catch {
      setLoadError("Could not reach the live status route.");
    }
  }, [optIn]);

  useEffect(() => {
    if (!optIn) return;
    const first = window.setTimeout(() => void reload(), 0);
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [optIn, reload]);

  const value = useMemo<LiveFeed>(() => ({ mode: deriveLiveMode(optIn, status, loadError), reload }), [optIn, status, loadError, reload]);
  return <LiveModeContext.Provider value={value}>{children}</LiveModeContext.Provider>;
}

export const useLiveMode = (): LiveFeed => useContext(LiveModeContext);
