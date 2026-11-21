/**
 * A tiny in-process cache for read-only market-data calls, so many browser tabs (or a 5 s poll) cannot multiply the
 * requests Alpaca sees. Only good answers are kept, only for a short time, and identical calls that overlap share one
 * request. It stores nothing on disk and sends nothing anywhere.
 */
export type MemoOptions<A extends unknown[], T> = {
  ttlMs: number;
  keyOf(...args: A): string;
  /** Only answers for which this is true are kept; a failure is always asked for again. */
  cacheable(value: T): boolean;
  clock?: () => number;
  maxEntries?: number;
};

export function memoAsync<A extends unknown[], T>(fn: (...args: A) => Promise<T>, opts: MemoOptions<A, T>): (...args: A) => Promise<T> {
  const clock = opts.clock ?? (() => Date.now());
  const max = opts.maxEntries ?? 16;
  const kept = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  return (...args: A): Promise<T> => {
    const key = opts.keyOf(...args);
    const hit = kept.get(key);
    if (hit && clock() - hit.at < opts.ttlMs) return Promise.resolve(hit.value);
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const value = await fn(...args);
        if (opts.cacheable(value)) {
          kept.set(key, { at: clock(), value });
          while (kept.size > max) {
            const oldest = kept.keys().next().value;
            if (oldest === undefined) break;
            kept.delete(oldest);
          }
        } else {
          kept.delete(key);
        }
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}
