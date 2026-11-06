"use client";

import { useEffect } from "react";
import { readAnalyzed, readDraft } from "@/lib/refreshMemory";

/** Full page reload interval after a successful login (home dashboard only). */
export const PAGE_REFRESH_MS = 5_000;

const normalize = (v: string) => v.trim().toUpperCase();

/** True while the user is mid-entry: typing in a field, or a ticker typed but not yet analyzed. */
function userIsEntering(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  return normalize(readDraft()) !== normalize(readAnalyzed());
}

/**
 * Reloads the current page every 5 seconds so polarity / bars stay fresh.
 * Skips a tick while the user is typing a ticker, so Analyze can actually be clicked.
 * Mount only on authenticated surfaces (the home dashboard), never on /login.
 */
export default function PageRefresher() {
  useEffect(() => {
    const id = window.setInterval(() => {
      if (userIsEntering()) return;
      window.location.reload();
    }, PAGE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <p className="sr-only" aria-live="polite">
      This page refreshes every 5 seconds, except while you are typing a ticker.
    </p>
  );
}
