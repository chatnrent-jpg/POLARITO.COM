/**
 * Subscription tier for the premium gate. SIMULATED: there is no Stripe call,
 * no webhook and no server here. The tier is a browser-local flag so the
 * checkout funnel can be exercised during development.
 *
 * !! NOT A SECURITY BOUNDARY !!
 * Anyone can edit localStorage. Before a commercial launch the real tier must
 * come from a server that verifies a Stripe webhook, and premium data must be
 * withheld by that server. This module is the client-side seam to swap.
 *
 * Fail-closed: a missing, unreadable or unrecognized value is FREE.
 */

export const TIERS = ["FREE", "PREMIUM"] as const;
export type UserTier = (typeof TIERS)[number];

export const TIER_STORAGE_KEY = "polarito.user.tier";

export const isTier = (v: unknown): v is UserTier =>
  typeof v === "string" && (TIERS as readonly string[]).includes(v);

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export function subscribeTier(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === TIER_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Current tier. Anything but an exact "PREMIUM" is FREE. */
export function getTier(): UserTier {
  if (typeof window === "undefined") return "FREE";
  try {
    const raw = window.localStorage.getItem(TIER_STORAGE_KEY);
    return isTier(raw) ? raw : "FREE";
  } catch {
    return "FREE";
  }
}

/** The server never has a subscriber, so it always renders the locked state. */
export function getServerTier(): UserTier {
  return "FREE";
}

export function isPremium(): boolean {
  return getTier() === "PREMIUM";
}

export type TierResult = { ok: true; tier: UserTier } | { ok: false; error: string };

/**
 * Simulates a successful Stripe webhook callback by flipping the tier
 * FREE <-> PREMIUM (checkout completed / subscription cancelled).
 * If the flag cannot be saved, nothing changes and an error is returned, so
 * the screen never claims a tier that was not recorded.
 */
export function togglePremiumStatus(): TierResult {
  const next: UserTier = getTier() === "PREMIUM" ? "FREE" : "PREMIUM"; // fresh read: other tabs may have written
  try {
    window.localStorage.setItem(TIER_STORAGE_KEY, next);
  } catch {
    return {
      ok: false,
      error: "Could not save your plan to this browser's storage, so it was NOT changed.",
    };
  }
  notify();
  return { ok: true, tier: next };
}
