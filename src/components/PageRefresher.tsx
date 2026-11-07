"use client";

import { useEffect, useRef } from "react";

/** How often the dashboard re-fetches its data after login. */
export const PAGE_REFRESH_MS = 5_000;

/**
 * The 5-second refresher. Calls `onRefresh` every 5 seconds; the dashboard re-fetches
 * its data in place, so the page does not reload, scroll or flicker.
 * Mounted only inside the dashboard, which Proxy serves only to signed-in sessions.
 */
export default function PageRefresher({ onRefresh }: { onRefresh: () => void }) {
  const latest = useRef(onRefresh);

  useEffect(() => {
    latest.current = onRefresh;
  });

  useEffect(() => {
    const id = window.setInterval(() => latest.current(), PAGE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <p className="sr-only" aria-live="polite">
      Data refreshes every 5 seconds.
    </p>
  );
}
