/**
 * Browser-side plumbing for the SPY desk's refresh: GET-only fetch helpers and the real clock/visibility the poller uses.
 * No decisions and no rendering here. Every network call is inside try/catch and ends as a value, never a throw.
 */
import { MONTHLY_PROFILE, apiPath, type DeskProfile } from "@/lib/spyProfile";
import type { PollResult, PollerEnv } from "@/lib/spyPoller";

/** The three GET paths of one desk. The two desks never share a route. */
export function deskPaths(profile: DeskProfile): { live: string; desk: string; analyze: string } {
  return { live: apiPath(profile, "live"), desk: apiPath(profile, "desk"), analyze: `${apiPath(profile, "analyze")}?ticker=SPY` };
}

export const LIVE_PATH = deskPaths(MONTHLY_PROFILE).live;
export const DESK_PATH = deskPaths(MONTHLY_PROFILE).desk;
export const ANALYZE_PATH = deskPaths(MONTHLY_PROFILE).analyze;

type FetchLike = (url: string, init: { method: "GET"; cache: "no-store"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** GET `path` and hand back the parsed JSON, or a plain error text. Never throws. The shape is checked by the caller. */
export async function getJson(path: string, signal: AbortSignal, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<PollResult<unknown>> {
  try {
    const res = await fetchImpl(path, { method: "GET", cache: "no-store", signal, headers: { Accept: "application/json" } });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : `The server answered ${res.status}.`;
      return { ok: false, error: msg };
    }
    return { ok: true, value: data };
  } catch {
    return { ok: false, error: signal.aborted ? "The request timed out." : "Could not reach the server." };
  }
}

/** The real clock, timers and tab visibility. */
export function browserPollerEnv(): PollerEnv {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
    isHidden: () => document.visibilityState === "hidden",
    onVisibility: (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
  };
}
