/**
 * Where the SPY desk keeps its one small record (the dry-run position and the manual journal).
 *
 * Production: the same Redis-over-HTTPS key-value store as the live Auto switch (Upstash / Vercel KV,
 * KV_REST_API_URL + KV_REST_API_TOKEN), under its own key. This is a KEY-VALUE store, not a broker: nothing
 * written here can reach Alpaca. Plain fetch, short timeout, every failure becomes an error value.
 *
 * Local development and tests only: SPY_DESK_STORE=memory keeps the record in this process. It is refused in
 * production, because a per-instance copy would show a position that other requests cannot see (a false state).
 */
import { autoStoreCredentials } from "@/lib/liveAutoStore";
import { EMPTY_DESK, parseDeskState, type DeskState, type DeskStore } from "@/lib/spyDesk";

export const DESK_STORE_KEY = "polarito:spy:desk:v1";
const TIMEOUT_MS = 4_000;

type Env = Readonly<Record<string, string | undefined>>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createKvDeskStore(env: Env, fetchImpl: FetchLike = (u, i) => fetch(u, i)): DeskStore | null {
  const creds = autoStoreCredentials(env);
  if (!creds) return null;
  const { url, token } = creds;

  async function command(args: string[]): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) return { ok: false, error: `The desk store answered ${res.status}.` };
      if (typeof data !== "object" || data === null || !("result" in data)) return { ok: false, error: "The desk store sent an unexpected answer." };
      return { ok: true, result: (data as { result: unknown }).result };
    } catch (e) {
      return { ok: false, error: controller.signal.aborted ? "The desk store timed out." : `The desk store could not be reached (${e instanceof Error ? e.name : "error"}).` };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async read() {
      const r = await command(["GET", DESK_STORE_KEY]);
      if (!r.ok) return r;
      if (r.result === null) return { ok: true, state: EMPTY_DESK };
      if (typeof r.result !== "string") return { ok: false, error: "The saved desk state is malformed." };
      let raw: unknown;
      try {
        raw = JSON.parse(r.result);
      } catch {
        return { ok: false, error: "The saved desk state is not valid JSON." };
      }
      const parsed = parseDeskState(raw);
      return parsed.ok ? { ok: true, state: parsed.state } : { ok: false, error: parsed.error };
    },
    async write(state: DeskState) {
      const r = await command(["SET", DESK_STORE_KEY, JSON.stringify(state)]);
      if (!r.ok) return r;
      return r.result === "OK" ? { ok: true } : { ok: false, error: "The desk store did not confirm the write." };
    },
  };
}

/** In-process store for tests and local development. Copies on the way in and out so callers cannot mutate it. */
export function createMemoryDeskStore(initial: DeskState = EMPTY_DESK): DeskStore & { failWrites: boolean; failReads: boolean; dropWrites: boolean } {
  let held = JSON.stringify(initial);
  const store = {
    failWrites: false,
    failReads: false,
    /** Test switch: acknowledge a write but keep the old value, as a broken store might. */
    dropWrites: false,
    async read() {
      if (store.failReads) return { ok: false as const, error: "The desk store could not be reached." };
      const parsed = parseDeskState(JSON.parse(held));
      return parsed.ok ? { ok: true as const, state: parsed.state } : { ok: false as const, error: parsed.error };
    },
    async write(state: DeskState) {
      if (store.failWrites) return { ok: false as const, error: "The desk store could not be reached." };
      if (!store.dropWrites) held = JSON.stringify(state);
      return { ok: true as const };
    },
  };
  return store;
}

const MEMORY_KEY = Symbol.for("polarito.spyDesk.memoryStore");

/** The store this server should use, or null when none is configured (the page then says so and the manual actions stay off). */
export function createDeskStore(env: Env): DeskStore | null {
  const kv = createKvDeskStore(env);
  if (kv) return kv;
  if (env.SPY_DESK_STORE === "memory" && env.NODE_ENV !== "production") {
    const g = globalThis as unknown as Record<symbol, DeskStore | undefined>;
    g[MEMORY_KEY] ??= createMemoryDeskStore();
    return g[MEMORY_KEY] ?? null;
  }
  return null;
}
