/**
 * Polling scheduler for the SPY desk page. Pure logic: no React, no DOM, no fetch of its own. The clock, the timers and the
 * tab visibility are injected, so the same code runs in the browser and under fake timers in tests.
 *
 * Two channels, each with its own cadence:
 *   light  every 5 s   saved record, Auto, journal, readings, SPY price, the one held contract (cheap)
 *   heavy  every 45 s  the full view including the option chain (125+ quotes), or on demand
 *
 * Guards (all of them apply to both channels):
 *   - no overlap: a channel never starts a request while its previous one is still running (the tick is skipped);
 *   - pause: nothing is requested while the tab is hidden; on return both channels refresh at once;
 *   - exponential backoff: after a failure the next try waits interval x 2^failures, up to a ceiling; a success resets it;
 *   - request cap: at most `maxPerMinute` requests in any 60 s window across both channels (retries and manual refreshes
 *     included); when the cap is reached the next request waits until a slot frees;
 *   - timeout: a request that never answers is aborted after `requestTimeoutMs` and counts as a failure;
 *   - generation: `hold()` and `invalidate()` throw away answers of requests started before them, so an old answer can
 *     never overwrite what a user action just changed.
 *
 * A refresh only ever asks (GET). Nothing here submits anything.
 */
export type PollResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type ChannelName = "light" | "heavy";

export type PollerEnv = {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  isHidden(): boolean;
  /** Calls `cb` whenever the tab is hidden or shown again; returns the unsubscribe function. */
  onVisibility(cb: () => void): () => void;
};

export type ChannelConfig = { intervalMs: number; maxBackoffMs: number };
export type PollerConfig = {
  light: ChannelConfig;
  heavy: ChannelConfig;
  maxPerMinute: number;
  requestTimeoutMs: number;
};

export const DEFAULT_POLLER_CONFIG: PollerConfig = {
  light: { intervalMs: 5_000, maxBackoffMs: 60_000 },
  heavy: { intervalMs: 45_000, maxBackoffMs: 120_000 },
  maxPerMinute: 20,
  requestTimeoutMs: 15_000,
};

export type ChannelStatus = {
  state: "idle" | "loading" | "ok" | "error" | "paused";
  /** Client time (ms) of the last accepted answer; null before the first. */
  lastOkAt: number | null;
  failures: number;
  error: string | null;
  /** Client time (ms) the next request is planned for; null when none is planned (paused or stopped). */
  nextAt: number | null;
};

export type PollStatus = { light: ChannelStatus; heavy: ChannelStatus; hidden: boolean; throttled: boolean };

export type PollerHandlers<L, H> = {
  fetchLight(signal: AbortSignal): Promise<PollResult<L>>;
  fetchHeavy(signal: AbortSignal): Promise<PollResult<H>>;
  /** Called with an answer that was fetched after the last hold/invalidate. May reject an answer by returning an error text. */
  onLight(value: L): string | null;
  onHeavy(value: H): string | null;
  onStatus(status: PollStatus): void;
};

type Channel = {
  name: ChannelName;
  cfg: ChannelConfig;
  timer: unknown;
  inflight: { token: number; ctl: AbortController; timeout: unknown } | null;
  status: ChannelStatus;
};

const WINDOW_MS = 60_000;

export class SpyPoller<L, H> {
  private readonly channels: Record<ChannelName, Channel>;
  private running = false;
  private holds = 0;
  private generation = 0;
  private tokens = 0;
  private sent: number[] = [];
  private throttled = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly env: PollerEnv,
    private readonly cfg: PollerConfig,
    private readonly handlers: PollerHandlers<L, H>,
  ) {
    const mk = (name: ChannelName): Channel => ({
      name,
      cfg: cfg[name],
      timer: null,
      inflight: null,
      status: { state: "idle", lastOkAt: null, failures: 0, error: null, nextAt: null },
    });
    this.channels = { light: mk("light"), heavy: mk("heavy") };
  }

  getStatus(): PollStatus {
    return { light: { ...this.channels.light.status }, heavy: { ...this.channels.heavy.status }, hidden: this.env.isHidden(), throttled: this.throttled };
  }

  /** Start polling: both channels ask at once (unless the tab is hidden), then keep to their cadence. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.env.onVisibility(() => this.onVisibility());
    if (this.env.isHidden()) this.pauseAll();
    else this.resumeAll(true);
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const ch of Object.values(this.channels)) {
      this.clearTimer(ch);
      this.abortInflight(ch);
      ch.status = { ...ch.status, state: "idle", nextAt: null };
    }
    this.emit();
  }

  /** Ask now (still subject to the no-overlap rule, the pause and the request cap). */
  refreshNow(which: ChannelName | "both" = "both"): void {
    if (!this.running) return;
    const names: ChannelName[] = which === "both" ? ["light", "heavy"] : [which];
    for (const n of names) this.schedule(this.channels[n], 0);
  }

  /** Throw away answers of requests already started (a user action changed things). Does not stop polling. */
  invalidate(): void {
    this.generation++;
    for (const ch of Object.values(this.channels)) {
      if (!ch.inflight) continue;
      this.abortInflight(ch);
      this.schedule(ch, ch.cfg.intervalMs);
    }
  }

  /**
   * A user action is running: no new request starts and running ones are discarded. The returned function ends the hold and
   * refreshes both channels at once. Calling it twice is harmless.
   */
  hold(): () => void {
    this.holds++;
    this.invalidate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
      if (this.holds === 0) this.refreshNow("both");
    };
  }

  /* ----------------------------------------------------------- internals */

  private emit(): void {
    try {
      this.handlers.onStatus(this.getStatus());
    } catch {
      /* a failing listener must not stop polling */
    }
  }

  private clearTimer(ch: Channel): void {
    if (ch.timer !== null) this.env.clearTimer(ch.timer);
    ch.timer = null;
  }

  private abortInflight(ch: Channel): void {
    const f = ch.inflight;
    if (!f) return;
    ch.inflight = null;
    this.env.clearTimer(f.timeout);
    try {
      f.ctl.abort();
    } catch {
      /* already settled */
    }
  }

  private schedule(ch: Channel, delayMs: number): void {
    if (!this.running) return;
    this.clearTimer(ch);
    const wait = Math.max(0, delayMs);
    ch.status = { ...ch.status, nextAt: this.env.now() + wait };
    ch.timer = this.env.setTimer(() => this.tick(ch), wait);
  }

  private pauseAll(): void {
    for (const ch of Object.values(this.channels)) {
      this.clearTimer(ch);
      this.abortInflight(ch);
      ch.status = { ...ch.status, state: "paused", nextAt: null };
    }
    this.emit();
  }

  private resumeAll(first: boolean): void {
    const now = this.env.now();
    for (const ch of Object.values(this.channels)) {
      const due = ch.status.lastOkAt === null ? 0 : Math.max(0, ch.status.lastOkAt + ch.cfg.intervalMs - now);
      const backoffDue = ch.status.failures > 0 && ch.status.nextAt !== null ? Math.max(0, ch.status.nextAt - now) : 0;
      this.schedule(ch, first ? 0 : Math.max(due, backoffDue));
    }
    this.emit();
  }

  private onVisibility(): void {
    if (!this.running) return;
    if (this.env.isHidden()) this.pauseAll();
    else this.resumeAll(false);
  }

  /** Milliseconds until a request slot frees, 0 when one is free right now. */
  private rateWait(): number {
    const now = this.env.now();
    this.sent = this.sent.filter((t) => now - t < WINDOW_MS);
    if (this.sent.length < this.cfg.maxPerMinute) return 0;
    return this.sent[0] + WINDOW_MS - now + 1;
  }

  private tick(ch: Channel): void {
    ch.timer = null;
    if (!this.running) return;
    if (this.env.isHidden()) {
      ch.status = { ...ch.status, state: "paused", nextAt: null };
      this.emit();
      return;
    }
    if (this.holds > 0 || ch.inflight) {
      this.schedule(ch, ch.cfg.intervalMs);
      return;
    }
    const wait = this.rateWait();
    if (wait > 0) {
      this.throttled = true;
      this.schedule(ch, wait);
      this.emit();
      return;
    }
    this.throttled = false;
    void this.run(ch);
  }

  private async run(ch: Channel): Promise<void> {
    const token = ++this.tokens;
    const ctl = new AbortController();
    let timeoutHandle: unknown = null;
    const timedOut = new Promise<PollResult<unknown>>((resolve) => {
      timeoutHandle = this.env.setTimer(() => {
        ctl.abort();
        resolve({ ok: false, error: "The request timed out." });
      }, this.cfg.requestTimeoutMs);
    });
    const timeout = timeoutHandle;
    const generation = this.generation;
    ch.inflight = { token, ctl, timeout };
    this.sent.push(this.env.now());
    ch.status = { ...ch.status, state: ch.status.state === "ok" || ch.status.state === "error" ? ch.status.state : "loading", nextAt: null };
    this.emit();

    let outcome: PollResult<unknown>;
    try {
      const asked = ch.name === "light" ? this.handlers.fetchLight(ctl.signal) : this.handlers.fetchHeavy(ctl.signal);
      outcome = await Promise.race([asked, timedOut]);
    } catch (e) {
      outcome = { ok: false, error: ctl.signal.aborted ? "The request timed out." : `The request failed (${e instanceof Error ? e.name : "error"}).` };
    }
    if (ctl.signal.aborted && outcome.ok) outcome = { ok: false, error: "The request timed out." };

    if (ch.inflight?.token !== token) return;
    this.env.clearTimer(ch.inflight.timeout);
    ch.inflight = null;
    if (!this.running || generation !== this.generation) {
      if (this.running && this.holds === 0) this.schedule(ch, 0);
      return;
    }

    let error: string | null = outcome.ok ? null : outcome.error;
    if (outcome.ok) {
      try {
        error = ch.name === "light" ? this.handlers.onLight(outcome.value as L) : this.handlers.onHeavy(outcome.value as H);
      } catch {
        error = "The answer could not be used.";
      }
    }

    if (error === null) {
      ch.status = { ...ch.status, state: "ok", lastOkAt: this.env.now(), failures: 0, error: null };
      this.after(ch, ch.cfg.intervalMs);
    } else {
      const failures = ch.status.failures + 1;
      const delay = Math.min(ch.cfg.intervalMs * 2 ** failures, ch.cfg.maxBackoffMs);
      ch.status = { ...ch.status, state: "error", failures, error };
      this.after(ch, delay);
    }
  }

  private after(ch: Channel, delayMs: number): void {
    if (this.env.isHidden()) {
      ch.status = { ...ch.status, state: "paused", nextAt: null };
      this.emit();
      return;
    }
    this.schedule(ch, delayMs);
    this.emit();
  }
}
