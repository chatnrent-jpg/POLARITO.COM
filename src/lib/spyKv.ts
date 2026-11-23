/**
 * A tiny key-value client for the SPY desk's AUTO trader: the on/off switch, the audit log and the run lock.
 *
 * Same store as the desk record (Upstash / Vercel KV over HTTPS, KV_REST_API_URL + KV_REST_API_TOKEN). It is a KEY-VALUE
 * store, not a broker: nothing written here can reach Alpaca. Plain fetch, short timeout, every failure is an error value
 * (never a throw, never a guessed value).
 *
 * Local development and tests only: SPY_DESK_STORE=memory keeps everything in this process. It is refused in production,
 * because a per-instance copy would show a state other requests cannot see (a false state).
 */
import { autoStoreCredentials } from "@/lib/liveAutoStore";
import { MONTHLY_PROFILE, scopeKey, type DeskProfile } from "@/lib/spyProfile";

const TIMEOUT_MS = 4_000;

type Env = Readonly<Record<string, string | undefined>>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type KvResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SpyKv {
  get(key: string): Promise<KvResult<string | null>>;
  set(key: string, value: string): Promise<KvResult<true>>;
  /** SET key value NX EX ttl: true when this caller created the key, false when it already existed. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<KvResult<boolean>>;
  del(key: string): Promise<KvResult<true>>;
}

export function createKvSpyKv(env: Env, fetchImpl: FetchLike = (u, i) => fetch(u, i)): SpyKv | null {
  const creds = autoStoreCredentials(env);
  if (!creds) return null;
  const { url, token } = creds;

  async function command(args: string[]): Promise<KvResult<unknown>> {
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
      if (!res.ok) return { ok: false, error: `The Auto store answered ${res.status}.` };
      if (typeof data !== "object" || data === null || !("result" in data)) return { ok: false, error: "The Auto store sent an unexpected answer." };
      return { ok: true, value: (data as { result: unknown }).result };
    } catch (e) {
      return { ok: false, error: controller.signal.aborted ? "The Auto store timed out." : `The Auto store could not be reached (${e instanceof Error ? e.name : "error"}).` };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get(key) {
      const r = await command(["GET", key]);
      if (!r.ok) return r;
      if (r.value === null) return { ok: true, value: null };
      return typeof r.value === "string" ? { ok: true, value: r.value } : { ok: false, error: "The Auto store held a value of an unexpected type." };
    },
    async set(key, value) {
      const r = await command(["SET", key, value]);
      if (!r.ok) return r;
      return r.value === "OK" ? { ok: true, value: true } : { ok: false, error: "The Auto store did not confirm the write." };
    },
    async setNx(key, value, ttlSeconds) {
      const r = await command(["SET", key, value, "NX", "EX", String(Math.max(1, Math.floor(ttlSeconds)))]);
      if (!r.ok) return r;
      if (r.value === "OK") return { ok: true, value: true };
      if (r.value === null) return { ok: true, value: false };
      return { ok: false, error: "The Auto store sent an unexpected answer to the lock request." };
    },
    async del(key) {
      const r = await command(["DEL", key]);
      return r.ok ? { ok: true, value: true } : r;
    },
  };
}

export type MemorySpyKv = SpyKv & {
  failReads: boolean;
  failWrites: boolean;
  /** Test switch: acknowledge a write but keep the old value, as a broken store might. */
  dropWrites: boolean;
  data: Map<string, { value: string; expiresAt: number | null }>;
};

/** In-process store for tests and local development. Honours NX and expiry like the real one. */
export function createMemorySpyKv(clock: () => number = () => Date.now()): MemorySpyKv {
  const data = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string): string | null => {
    const e = data.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= clock()) {
      data.delete(key);
      return null;
    }
    return e.value;
  };
  const kv: MemorySpyKv = {
    failReads: false,
    failWrites: false,
    dropWrites: false,
    data,
    async get(key) {
      if (kv.failReads) return { ok: false, error: "The Auto store could not be reached." };
      return { ok: true, value: live(key) };
    },
    async set(key, value) {
      if (kv.failWrites) return { ok: false, error: "The Auto store could not be reached." };
      if (!kv.dropWrites) data.set(key, { value, expiresAt: null });
      return { ok: true, value: true };
    },
    async setNx(key, value, ttlSeconds) {
      if (kv.failWrites) return { ok: false, error: "The Auto store could not be reached." };
      if (live(key) !== null) return { ok: true, value: false };
      data.set(key, { value, expiresAt: clock() + ttlSeconds * 1000 });
      return { ok: true, value: true };
    },
    async del(key) {
      if (kv.failWrites) return { ok: false, error: "The Auto store could not be reached." };
      data.delete(key);
      return { ok: true, value: true };
    },
  };
  return kv;
}

const MEMORY_KEY = Symbol.for("polarito.spyAuto.memoryKv");
const memoryKeyFor = (profile: DeskProfile): symbol => (profile.id === "monthly" ? MEMORY_KEY : Symbol.for(`polarito.spyAuto.memoryKv.${profile.id}`));

/**
 * The same client, but every key goes through the profile's own prefix, so one desk's Auto switch, audit log and run lock can
 * never be read, written or locked by the other. The auto-cycle code keeps using the shared key names and does not know.
 */
export function scopeKv(kv: SpyKv, profile: DeskProfile): SpyKv {
  return {
    get: (key) => kv.get(scopeKey(profile, key)),
    set: (key, value) => kv.set(scopeKey(profile, key), value),
    setNx: (key, value, ttlSeconds) => kv.setNx(scopeKey(profile, key), value, ttlSeconds),
    del: (key) => kv.del(scopeKey(profile, key)),
  };
}

/** The key-value client this desk should use, or null when none is configured (Auto then stays OFF and says so). */
export function createSpyKv(env: Env, profile: DeskProfile = MONTHLY_PROFILE): SpyKv | null {
  const kv = createKvSpyKv(env);
  if (kv) return scopeKv(kv, profile);
  if (env.SPY_DESK_STORE === "memory" && env.NODE_ENV !== "production") {
    const g = globalThis as unknown as Record<symbol, SpyKv | undefined>;
    const k = memoryKeyFor(profile);
    g[k] ??= createMemorySpyKv();
    return g[k] ? scopeKv(g[k] as SpyKv, profile) : null;
  }
  return null;
}
