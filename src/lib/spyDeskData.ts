/**
 * The SPY desk page's data layer: owns the polling, checks every answer, lays the light data over the heavy snapshot and says,
 * in plain words, how fresh what is on screen really is. No React, no DOM, no fetch of its own (all injected).
 *
 * Cadence (see spyPoller.ts): light every 5 s, heavy (option chain) every 45 s or on demand.
 *
 * Unidirectional flow:  poller (GET) -> parse + age checks -> heavy / live snapshots -> merge -> DeskDataState -> view.
 * The user's own choices (Call/Put, chosen contract, ticked boxes, an open Close box, notices) live in the container's state,
 * not here, and nothing in this module writes to them: a refresh cannot reset or submit anything.
 *
 * Justice: an answer that is malformed, older than what is already shown, far from the client clock, or too old is REJECTED
 * and counted as a failed refresh. Data on screen older than 15 s is labelled STALE, never shown as current.
 */
import { parseDeskSnapshot, type DeskSnapshot } from "@/lib/spyDesk";
import { mergeLive, parseLiveSnapshot, type LiveSnapshot } from "@/lib/spyLive";
import { DEFAULT_POLLER_CONFIG, SpyPoller, type PollResult, type PollStatus, type PollerConfig, type PollerEnv } from "@/lib/spyPoller";

export const LIGHT_POLL_MS = DEFAULT_POLLER_CONFIG.light.intervalMs;
export const HEAVY_POLL_MS = DEFAULT_POLLER_CONFIG.heavy.intervalMs;
/** Light data older than this on screen is shown as STALE. */
export const STALE_AFTER_MS = 3 * LIGHT_POLL_MS;
/** An answer whose own timestamp is further than this from the browser clock is rejected. */
export const MAX_CLOCK_DIFF_MS = 60_000;

export type Freshness = {
  state: "loading" | "live" | "stale" | "paused";
  /** Server time (ISO) of the data on screen. */
  updatedAt: string | null;
  /** Server time (ISO) of the option chain the contract preview and ticket list come from. */
  chainAt: string | null;
  lightError: string | null;
  heavyError: string | null;
  /** Milliseconds until the next try of the light refresh after a failure; null when it is not backing off. */
  retryInMs: number | null;
  /** The request cap is holding a refresh back. */
  throttled: boolean;
  /** The reading or position changed since the chain was read; the chain is being re-read. */
  chainUpdating: boolean;
};

export type DeskDataState = {
  snapshot: DeskSnapshot | null;
  /** Set only when there is nothing to show yet and the first full read failed. */
  fatal: string | null;
  fresh: Freshness;
};

export type DeskDataDeps = {
  env: PollerEnv;
  fetchLive(signal: AbortSignal): Promise<PollResult<unknown>>;
  fetchDesk(signal: AbortSignal): Promise<PollResult<unknown>>;
  config?: PollerConfig;
};

export type DeskData = {
  getState(): DeskDataState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  refreshNow(which?: "light" | "heavy" | "both"): void;
  /** A user action is running: pause refreshing and drop answers in flight; call the result when it is over. */
  hold(): () => void;
};

export const LOADING_FRESHNESS: Freshness = Object.freeze({ state: "loading", updatedAt: null, chainAt: null, lightError: null, heavyError: null, retryInMs: null, throttled: false, chainUpdating: false }) as Freshness;
const INITIAL: DeskDataState = { snapshot: null, fatal: null, fresh: LOADING_FRESHNESS };

export function createDeskData(deps: DeskDataDeps): DeskData {
  let heavy: DeskSnapshot | null = null;
  let live: LiveSnapshot | null = null;
  let lightAcceptedAt: number | null = null;
  let lastLiveGen = -Infinity;
  let lastHeavyGen = -Infinity;
  let chainUpdating = false;
  let requestedFor: string | null = null;
  let status: PollStatus | null = null;
  let state: DeskDataState = INITIAL;
  let watchdog: unknown = null;
  const listeners = new Set<() => void>();

  const { env } = deps;
  const maxAge = MAX_CLOCK_DIFF_MS;

  /** Null when the answer's own time is sane, else why it was rejected. */
  const timeProblem = (generatedAt: string, lastGen: number, label: string): string | null => {
    const gen = Date.parse(generatedAt);
    const now = env.now();
    if (!Number.isFinite(gen)) return `The ${label} data has no valid time. It was not used.`;
    if (now - gen > maxAge) return `The ${label} data is ${Math.round((now - gen) / 1000)} s old, so it was not used.`;
    if (gen - now > maxAge) return `The ${label} data is dated ${Math.round((gen - now) / 1000)} s in the future (clock difference). It was not used.`;
    if (gen < lastGen) return `The ${label} data is older than what is already shown. It was not used.`;
    return null;
  };

  const recompute = (): void => {
    let snapshot: DeskSnapshot | null = null;
    let chainStale = false;
    if (heavy) {
      if (live && Date.parse(live.generatedAt) >= Date.parse(heavy.generatedAt)) {
        const m = mergeLive(heavy, live);
        snapshot = m.snapshot;
        chainStale = m.chainStale;
      } else {
        snapshot = heavy;
      }
    }
    const now = env.now();
    const hidden = status?.hidden ?? env.isHidden();
    const lightErr = status && status.light.failures > 0 ? status.light.error : null;
    const heavyErr = status && status.heavy.failures > 0 ? status.heavy.error : null;
    const tooOld = lightAcceptedAt !== null && now - lightAcceptedAt > STALE_AFTER_MS;
    const fstate: Freshness["state"] = !snapshot ? "loading" : hidden ? "paused" : lightErr || tooOld ? "stale" : "live";
    const retryInMs = status && status.light.failures > 0 && status.light.nextAt !== null ? Math.max(0, status.light.nextAt - now) : null;
    const next: DeskDataState = {
      snapshot,
      fatal: !snapshot && heavyErr ? heavyErr : null,
      fresh: {
        state: fstate,
        updatedAt: snapshot ? snapshot.generatedAt : null,
        chainAt: heavy ? heavy.generatedAt : null,
        lightError: lightErr,
        heavyError: heavyErr,
        retryInMs,
        throttled: status?.throttled ?? false,
        chainUpdating: chainStale || chainUpdating,
      },
    };
    state = next;
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        /* a failing listener must not stop the data layer */
      }
    }
    if (chainStale && live) {
      // Ask for the chain once per change (not once per tick), so a disagreement that never resolves cannot loop.
      const key = `${live.decision.action}|${live.position.status === "held" ? live.position.symbol : live.position.status}|${live.store.available}`;
      if (key !== requestedFor) {
        requestedFor = key;
        chainUpdating = true;
        poller.refreshNow("heavy");
      }
    }
  };

  const armWatchdog = (): void => {
    if (watchdog !== null) env.clearTimer(watchdog);
    watchdog = env.setTimer(() => {
      watchdog = null;
      recompute();
    }, STALE_AFTER_MS + 1);
  };

  const poller = new SpyPoller<unknown, unknown>(env, deps.config ?? DEFAULT_POLLER_CONFIG, {
    fetchLight: deps.fetchLive,
    fetchHeavy: deps.fetchDesk,
    onLight: (raw) => {
      const parsed = parseLiveSnapshot(raw);
      if (!parsed.ok) return parsed.error;
      const problem = timeProblem(parsed.snapshot.generatedAt, lastLiveGen, "live");
      if (problem) return problem;
      live = parsed.snapshot;
      lastLiveGen = Date.parse(parsed.snapshot.generatedAt);
      lightAcceptedAt = env.now();
      armWatchdog();
      return null;
    },
    onHeavy: (raw) => {
      const parsed = parseDeskSnapshot(raw);
      if (!parsed.ok) return parsed.error;
      const problem = timeProblem(parsed.snapshot.generatedAt, lastHeavyGen, "full");
      if (problem) return problem;
      heavy = parsed.snapshot;
      lastHeavyGen = Date.parse(parsed.snapshot.generatedAt);
      chainUpdating = false;
      return null;
    },
    onStatus: (s) => {
      status = s;
      recompute();
    },
  });

  return {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    start: () => poller.start(),
    stop: () => {
      poller.stop();
      if (watchdog !== null) env.clearTimer(watchdog);
      watchdog = null;
    },
    refreshNow: (which = "both") => poller.refreshNow(which),
    hold: () => poller.hold(),
  };
}
