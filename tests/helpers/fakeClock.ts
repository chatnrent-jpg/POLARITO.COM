import type { PollerEnv } from "../../src/lib/spyPoller";

/** A hand-driven clock for the poller: timers fire only inside `advance`, in time order, and answers settle between them. */
export function createFakeClock(startMs: number) {
  let now = startMs;
  let seq = 0;
  let hidden = false;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const visibility = new Set<() => void>();

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
  };

  const env: PollerEnv = {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    isHidden: () => hidden,
    onVisibility: (cb) => {
      visibility.add(cb);
      return () => visibility.delete(cb);
    },
  };

  return {
    env,
    now: () => now,
    pendingTimers: () => timers.size,
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        await settle();
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (next === null || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
      }
      now = end;
      await settle();
    },
    async setHidden(h: boolean): Promise<void> {
      hidden = h;
      for (const cb of [...visibility]) cb();
      await settle();
    },
    settle,
  };
}
