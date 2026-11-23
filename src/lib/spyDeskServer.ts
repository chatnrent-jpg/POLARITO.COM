/**
 * Server-side wiring of one desk: turns a profile into the contexts the route handlers take (live data, saved record, Auto
 * key-value client). Both desks' route files are one-liners over this, so the monthly desk and the WWV desk run the same code
 * and differ only by the profile. No logic and no I/O of its own beyond building the clients.
 */
import type { AutoRouteContext } from "@/lib/spyAutoRoutes";
import type { DeskContext } from "@/lib/spyDeskRoutes";
import { createLiveDeskDeps } from "@/lib/spyDeskLive";
import { createDeskStore } from "@/lib/spyDeskStore";
import { createSpyKv } from "@/lib/spyKv";
import type { DeskProfile } from "@/lib/spyProfile";

type Env = Readonly<Record<string, string | undefined>>;

export type DeskContextOptions = {
  /** The 5 s refresh (short caches, no option chain). */
  light?: boolean;
  /** Analyze reads market data only: no saved record and no key-value client. */
  readOnly?: boolean;
};

export function deskContext(profile: DeskProfile, env: Env = process.env, opts: DeskContextOptions = {}): DeskContext {
  return {
    env,
    profile,
    makeLive: () => createLiveDeskDeps(env, undefined, { light: opts.light, profile }),
    store: opts.readOnly ? null : createDeskStore(env, profile),
    ...(opts.readOnly ? {} : { kv: createSpyKv(env, profile) }),
  };
}

export function autoContext(profile: DeskProfile, env: Env = process.env): AutoRouteContext {
  return {
    env,
    profile,
    makeLive: () => createLiveDeskDeps(env, undefined, { profile }),
    desk: createDeskStore(env, profile),
    kv: createSpyKv(env, profile),
  };
}
