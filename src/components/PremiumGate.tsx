"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  getServerTier,
  getTier,
  subscribeTier,
  togglePremiumStatus,
} from "@/lib/billingGate";

/** Simulated hop to a hosted checkout page. */
const CHECKOUT_DELAY_MS = 1600;

/** Stand-in shown (blurred) behind the paywall. It is NOT the real card. */
function LockedPlaceholder() {
  return (
    <div className="flex min-h-[19rem] w-full flex-col gap-4 rounded-xl border-l-8 border-zinc-600 bg-zinc-950/60 px-5 py-4 ring-1 ring-zinc-700">
      <div className="h-4 w-40 rounded bg-zinc-500" />
      <div className="h-12 w-3/4 rounded bg-zinc-400" />
      <div className="h-4 w-full rounded bg-zinc-600" />
      <div className="h-4 w-2/3 rounded bg-zinc-600" />
    </div>
  );
}

/**
 * Paywall around premium content.
 *
 * FREE: the real children are NOT rendered at all. A blurred stand-in sits
 * under the overlay, so the premium values are never in the page for a free
 * user to un-blur with dev tools.
 * PREMIUM: children render as-is.
 *
 * Upgrade flow (simulated): button -> "redirecting to secure checkout" ->
 * togglePremiumStatus (the stand-in for the Stripe webhook) -> store notifies
 * -> content unlocks with no reload.
 */
export default function PremiumGate({
  children,
  preview,
}: {
  children: ReactNode;
  /** Optional blurred stand-in. Must not contain premium data. */
  preview?: ReactNode;
}) {
  const tier = useSyncExternalStore(subscribeTier, getTier, getServerTier);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (tier === "PREMIUM") return <>{children}</>;

  function onUpgrade() {
    if (redirecting) return;
    setError(null);
    setRedirecting(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      // Another tab may have upgraded meanwhile; never toggle a paid user back to FREE.
      if (getTier() !== "PREMIUM") {
        const result = togglePremiumStatus();
        if (!result.ok) setError(result.error);
      }
      setRedirecting(false);
    }, CHECKOUT_DELAY_MS);
  }

  return (
    <div className="relative w-full max-w-2xl overflow-hidden rounded-xl">
      <div aria-hidden="true" className="pointer-events-none select-none blur-md">
        {preview ?? <LockedPlaceholder />}
      </div>

      <div
        role="region"
        aria-label="Premium required"
        className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-zinc-950/80 p-5 text-center sm:p-8"
      >
        <h3 className="text-2xl font-black uppercase leading-tight tracking-tight text-white sm:text-3xl">
          🔒 POLARITO PREMIUM REQUIRED
        </h3>
        <p className="max-w-md text-lg font-medium leading-snug text-slate-200">
          Unlock Crowd Sentiment: a headline-keyword reading from live news (bullish vs bearish
          words per day), shown beside Net Volume. Informational only, not a forecast. $15/month.
        </p>
        <button
          type="button"
          onClick={onUpgrade}
          disabled={redirecting}
          className="h-16 w-full max-w-sm rounded-xl bg-amber-400 px-6 text-xl font-black uppercase tracking-wider text-zinc-950 transition-colors hover:bg-amber-300 focus:outline-none focus-visible:ring-4 focus-visible:ring-white disabled:cursor-wait disabled:bg-amber-200"
        >
          {redirecting ? "Redirecting to secure checkout…" : "UPGRADE VIA STRIPE"}
        </button>
        <p role="status" className="text-sm text-slate-400">
          {redirecting
            ? "Simulated checkout. No payment is taken."
            : "Simulated checkout for local testing. No payment is taken."}
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-lg border-2 border-red-500 bg-red-950/70 p-3 text-base font-semibold text-red-200"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
