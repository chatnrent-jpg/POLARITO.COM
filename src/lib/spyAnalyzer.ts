/**
 * The ticket's Analyze state, kept outside React: asks the server for the gear (GET only), checks the answer, watches the
 * 5-second live data for a change of gear, and says whether the ticket may be used and for which side.
 * No React, no DOM, no fetch of its own (injected), no storage.
 *
 * Unidirectional flow:  Analyze click or gear change -> GET /api/spy/analyze -> parse + age check -> AnalyzerState -> view.
 * The user's choices (Call/Put, contract row, ticked boxes) live in the container's state and are never touched here,
 * except that the container clears the acknowledgement when the gear changes.
 *
 * Justice: an answer that is malformed, mismatched, or far from the clock is refused. A failed (re-)analysis leaves NO gear,
 * so the ticket stays blocked; an old gear is never reused after a failure.
 */
import type { OptionType } from "@/lib/broker/options";
import { parseAnalysis, type Analysis } from "@/lib/spyAnalysis";
import { GEAR_NAMES, checkSide, gearFromAction, type Gear, type SideCheck } from "@/lib/spyGear";
import type { PollResult, PollerEnv } from "@/lib/spyPoller";

export const ANALYSIS_TIMEOUT_MS = 15_000;
export const ANALYSIS_MAX_CLOCK_DIFF_MS = 60_000;

export type GearChange = { from: Gear; to: Gear; at: string };

export type AnalyzerState = {
  status: "none" | "loading" | "ok" | "error";
  /** Only set while status is "ok" (or "loading" a re-check of a good one is shown as blocked by the permit). */
  analysis: Analysis | null;
  error: string | null;
  /** Set when the live gear moved away from the analysed one; stays until the next manual Analyze. */
  gearChange: GearChange | null;
};

export const NO_ANALYSIS: AnalyzerState = Object.freeze({ status: "none", analysis: null, error: null, gearChange: null }) as AnalyzerState;

export type Analyzer = {
  getState(): AnalyzerState;
  subscribe(listener: () => void): () => void;
  /** The Analyze button. Does nothing while a request is already running. */
  analyze(): Promise<void>;
  /** Tell it the live decision action after every refresh; it re-analyzes once per change of gear. */
  observe(liveAction: string): void;
};

export function createAnalyzer(deps: { fetchAnalysis(signal: AbortSignal): Promise<PollResult<unknown>>; env: Pick<PollerEnv, "now" | "setTimer" | "clearTimer"> }): Analyzer {
  const { env } = deps;
  let state: AnalyzerState = NO_ANALYSIS;
  let inflight = false;
  let lastChangeKey: string | null = null;
  const listeners = new Set<() => void>();

  const set = (next: AnalyzerState): void => {
    state = next;
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        /* a failing listener must not stop the analyzer */
      }
    }
  };

  const run = async (manual: boolean): Promise<void> => {
    if (inflight) return;
    inflight = true;
    set({ ...state, status: "loading", error: null, gearChange: manual ? null : state.gearChange });
    const before = state.analysis;
    const ctl = new AbortController();
    let handle: unknown = null;
    const timedOut = new Promise<PollResult<unknown>>((resolve) => {
      handle = env.setTimer(() => {
        ctl.abort();
        resolve({ ok: false, error: "Analyze timed out. No gear is shown." });
      }, ANALYSIS_TIMEOUT_MS);
    });
    try {
      let out: PollResult<unknown>;
      try {
        out = await Promise.race([deps.fetchAnalysis(ctl.signal), timedOut]);
      } catch {
        out = { ok: false, error: "Analyze failed. No gear is shown." };
      }
      if (!out.ok) {
        set({ status: "error", analysis: null, error: out.error, gearChange: state.gearChange });
        return;
      }
      const parsed = parseAnalysis(out.value);
      if (!parsed.ok) {
        set({ status: "error", analysis: null, error: parsed.error, gearChange: state.gearChange });
        return;
      }
      const gen = Date.parse(parsed.analysis.generatedAt);
      const now = env.now();
      if (Math.abs(now - gen) > ANALYSIS_MAX_CLOCK_DIFF_MS) {
        set({ status: "error", analysis: null, error: `The gear is dated ${Math.round(Math.abs(now - gen) / 1000)} s away from this computer's clock, so it was not used.`, gearChange: state.gearChange });
        return;
      }
      const moved = before && before.gear !== parsed.analysis.gear ? { from: before.gear, to: parsed.analysis.gear, at: parsed.analysis.generatedAt } : null;
      set({ status: "ok", analysis: parsed.analysis, error: null, gearChange: moved ?? state.gearChange });
    } finally {
      if (handle !== null) env.clearTimer(handle);
      inflight = false;
    }
  };

  return {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    analyze: () => run(true),
    observe: (liveAction) => {
      const live = gearFromAction(liveAction);
      const a = state.analysis;
      if (state.status !== "ok" || !a || live === null) return;
      if (live === a.gear) {
        lastChangeKey = null;
        return;
      }
      const key = `${a.gear}>${live}`;
      if (key === lastChangeKey) return;
      lastChangeKey = key;
      set({ ...state, gearChange: { from: a.gear, to: live, at: new Date(env.now()).toISOString() } });
      void run(false);
    },
  };
}

/* ------------------------------------------------------------ the permit */

export type GearPermit =
  | { ready: true; gear: Gear; message: null }
  | { ready: false; kind: "needs-analyze" | "analyzing" | "error" | "gear-changed" | "gear-unavailable" | "stale"; message: string };

export type PermitInput = { analyzer: AnalyzerState; liveAction: string; liveFreshness: "loading" | "live" | "stale" | "paused" };

/**
 * May the ticket be used at all? Only when Analyze has succeeded, the 5 s live gear still agrees with it, and the live data
 * is not stale. (The server checks the gear again on submit; this is the immediate check.)
 */
export function gearPermit({ analyzer, liveAction, liveFreshness }: PermitInput): GearPermit {
  if (analyzer.status === "loading") return { ready: false, kind: "analyzing", message: "Analyzing: loading the daily bars and the gear. The ticket stays disabled until it is done." };
  if (analyzer.status === "error") return { ready: false, kind: "error", message: `Analyze failed: ${analyzer.error ?? "no gear"} The ticket stays disabled.` };
  if (analyzer.status === "none" || !analyzer.analysis) return { ready: false, kind: "needs-analyze", message: "Press Analyze first. The ticket stays disabled until the gear is loaded." };
  const live = gearFromAction(liveAction);
  if (live === null) return { ready: false, kind: "gear-unavailable", message: "The live gear is unavailable right now, so the ticket is disabled (nothing is guessed)." };
  if (live !== analyzer.analysis.gear) {
    return { ready: false, kind: "gear-changed", message: `The gear changed from ${GEAR_NAMES[analyzer.analysis.gear]} to ${GEAR_NAMES[live]} since you analyzed. The ticket is blocked until the new gear is loaded.` };
  }
  if (liveFreshness === "stale") return { ready: false, kind: "stale", message: "The live data is stale (a refresh failed), so the gear cannot be trusted. The ticket is disabled until a refresh succeeds." };
  return { ready: true, gear: analyzer.analysis.gear, message: null };
}

/** The full client-side check for one side: gear permit first, then the polarity rule. */
export function sidePermit(input: PermitInput, type: OptionType): { allowed: boolean; message: string; gear: Gear | null } {
  const g = gearPermit(input);
  if (!g.ready) return { allowed: false, message: g.message, gear: null };
  const c: SideCheck = checkSide(g.gear, type);
  return { allowed: c.allowed, message: c.message, gear: g.gear };
}
