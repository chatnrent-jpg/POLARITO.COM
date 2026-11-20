/**
 * Persisted live "Auto" on/off, the one piece of server state the live runner needs.
 *
 * The repo has no database and a Vercel function has no durable disk, so this uses a
 * Redis-over-HTTPS key-value store (Upstash Redis, which Vercel's Marketplace provisions
 * and wires up with KV_REST_API_URL / KV_REST_API_TOKEN). It is plain `fetch`: no new
 * dependency. One key holds one small JSON value.
 *
 * Fail-closed (Justice): Auto is ON only when the store answers and says so. No store
 * configured, an unreachable store, a missing key, or a malformed value all mean OFF. The
 * runner reads it every tick, so a switch made on polarito.com takes effect on the next tick.
 */
import type { BrokerEnv } from "@/lib/broker/config";
import type { FetchLike } from "@/lib/broker/alpacaPaper";

export const LIVE_AUTO_KEY = "polarito:live:auto:v1";
const TIMEOUT_MS = 4_000;

export type AutoStore = {
  /** ok(false) when the key is unset: Auto defaults to OFF. */
  read(): Promise<{ ok: true; on: boolean; at: string | null } | { ok: false; error: string }>;
  write(on: boolean, now?: Date): Promise<{ ok: true } | { ok: false; error: string }>;
};

export type AutoState = {
  on: boolean;
  /** Why it is off (or a note when on); shown in the UI and the audit log. */
  reason: string;
  /** Whether a store is configured at all (the site can only switch Auto when it is). */
  available: boolean;
  at: string | null;
};

export function autoStoreCredentials(env: BrokerEnv): { url: string; token: string } | null {
  const url = (env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();
  if (!url || !token || !url.startsWith("https://")) return null;
  return { url, token };
}

export function createAutoStore(env: BrokerEnv, fetchImpl: FetchLike = (u, i) => fetch(u, i)): AutoStore | null {
  const creds = autoStoreCredentials(env);
  if (!creds) return null;
  const { url, token } = creds;

  async function command(args: string[]): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
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
      if (typeof data !== "object" || data === null || !("result" in data)) {
        return { ok: false, error: "The Auto store sent an unexpected answer." };
      }
      return { ok: true, result: (data as { result: unknown }).result };
    } catch (e) {
      return { ok: false, error: controller.signal.aborted ? "The Auto store timed out." : `The Auto store could not be reached (${e instanceof Error ? e.name : "error"}).` };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async read() {
      const r = await command(["GET", LIVE_AUTO_KEY]);
      if (!r.ok) return r;
      if (r.result === null) return { ok: true, on: false, at: null };
      if (typeof r.result !== "string") return { ok: false, error: "The Auto value is malformed. Treating Auto as OFF." };
      try {
        const v = JSON.parse(r.result) as unknown;
        if (typeof v !== "object" || v === null || typeof (v as { auto?: unknown }).auto !== "boolean") {
          return { ok: false, error: "The Auto value is malformed. Treating Auto as OFF." };
        }
        const at = (v as { at?: unknown }).at;
        return { ok: true, on: (v as { auto: boolean }).auto, at: typeof at === "string" ? at : null };
      } catch {
        return { ok: false, error: "The Auto value is malformed. Treating Auto as OFF." };
      }
    },
    async write(on, now = new Date()) {
      const r = await command(["SET", LIVE_AUTO_KEY, JSON.stringify({ auto: on, at: now.toISOString() })]);
      if (!r.ok) return r;
      return r.result === "OK" ? { ok: true } : { ok: false, error: "The Auto store did not confirm the write." };
    },
  };
}

/** What the runner and the status route act on. Never throws; anything doubtful is OFF. */
export async function readAutoState(store: AutoStore | null): Promise<AutoState> {
  if (!store) {
    return {
      on: false,
      available: false,
      at: null,
      reason: "No Auto store is configured (KV_REST_API_URL / KV_REST_API_TOKEN), so Auto is OFF and cannot be switched on from the site.",
    };
  }
  try {
    const r = await store.read();
    if (!r.ok) return { on: false, available: true, at: null, reason: `${r.error} Auto is OFF until the store answers.` };
    return r.on
      ? { on: true, available: true, at: r.at, reason: "Auto is ON." }
      : { on: false, available: true, at: r.at, reason: "Auto is OFF." };
  } catch {
    return { on: false, available: true, at: null, reason: "The Auto store failed. Auto is OFF until it answers." };
  }
}
