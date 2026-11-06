"use client";

import { useEffect } from "react";

/** Full page reload interval after a successful login (home dashboard only). */
export const PAGE_REFRESH_MS = 5_000;

/**
 * Reloads the current page every 5 seconds so polarity / bars stay fresh.
 * Mount only on authenticated surfaces (the home dashboard), never on /login.
 */
export default function PageRefresher() {
  useEffect(() => {
    const id = window.setInterval(() => {
      window.location.reload();
    }, PAGE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <p className="sr-only" aria-live="polite">
      This page refreshes every 5 seconds.
    </p>
  );
}
