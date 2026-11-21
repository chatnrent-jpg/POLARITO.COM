/**
 * Read-only Alpaca client for the SPY options design (server / CI only).
 *
 * This client CANNOT place, change or cancel an order: it only ever sends GET, and only to an
 * explicit allowlist of read paths (account, option contracts, latest stock trade, stock bars, option snapshots).
 * Any other path is refused before a request is made. The hosts are constants; no caller can pass a URL.
 * Credentials go out as headers only and never appear in a returned error.
 */
import type { BrokerErrorCode, Result } from "@/lib/broker/types";

export type ReadOnlyHost = "trading-live" | "trading-paper" | "data";

export const READ_ONLY_BASE_URLS: Readonly<Record<ReadOnlyHost, string>> = Object.freeze({
  "trading-live": "https://api.alpaca.markets",
  "trading-paper": "https://paper-api.alpaca.markets",
  data: "https://data.alpaca.markets",
});

const TRADING_READS: readonly RegExp[] = [/^\/v2\/account$/, /^\/v2\/options\/contracts$/];

const ALLOWED_PATHS: Readonly<Record<ReadOnlyHost, readonly RegExp[]>> = Object.freeze({
  "trading-live": TRADING_READS,
  "trading-paper": TRADING_READS,
  data: [/^\/v2\/stocks\/[A-Z]{1,6}\/trades\/latest$/, /^\/v2\/stocks\/bars$/, /^\/v1beta1\/options\/snapshots\/[A-Z]{1,6}$/],
});

export function isAllowedReadPath(host: ReadOnlyHost, path: string): boolean {
  return (ALLOWED_PATHS[host] ?? []).some((re) => re.test(path));
}

export type ReadOnlyFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ReadOnlyClientOptions = {
  keyId: string;
  secretKey: string;
  fetchImpl?: ReadOnlyFetch;
  timeoutMs?: number;
  /** Retries after HTTP 429 (rate limit). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type ReadOnlyResponse = { status: number; data: unknown };

export interface ReadOnlyClient {
  get(
    host: ReadOnlyHost,
    path: string,
    params?: Record<string, string>,
  ): Promise<Result<ReadOnlyResponse, BrokerErrorCode>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (code: BrokerErrorCode, error: string): { ok: false; code: BrokerErrorCode; error: string } => ({
  ok: false,
  code,
  error,
});

export function createReadOnlyClient(opts: ReadOnlyClientOptions): ReadOnlyClient {
  const keyId = opts.keyId.trim();
  const secretKey = opts.secretKey.trim();
  if (!keyId || !secretKey) throw new Error("Alpaca credentials are required.");
  const fetchImpl: ReadOnlyFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async get(host, path, params) {
      const base = READ_ONLY_BASE_URLS[host];
      if (!base || !isAllowedReadPath(host, path)) {
        return fail("REJECTED", `Path is not on the read-only allowlist: ${String(path).slice(0, 80)}`);
      }
      const query = new URLSearchParams(params ?? {}).toString();
      const url = `${base}${path}${query ? `?${query}` : ""}`;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchImpl(url, {
            method: "GET",
            headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey, Accept: "application/json" },
            signal: controller.signal,
          });
          let data: unknown = null;
          try {
            data = await res.json();
          } catch {
            data = null;
          }
          if (res.status === 429 && attempt < retries) {
            await sleep(1500 * (attempt + 1));
            continue;
          }
          if (!res.ok && res.status !== 404) {
            const message = isRecord(data) && typeof data.message === "string" ? data.message.slice(0, 200) : "no details";
            return fail(res.status === 401 || res.status === 403 ? "REJECTED" : "HTTP", `Alpaca ${host} returned ${res.status}: ${message}`);
          }
          return { ok: true, value: { status: res.status, data } };
        } catch (e) {
          const aborted = e instanceof Error && e.name === "AbortError";
          return fail(aborted ? "TIMEOUT" : "NETWORK", aborted ? `Alpaca ${host} timed out.` : `Network error talking to Alpaca ${host}.`);
        } finally {
          clearTimeout(timer);
        }
      }
      return fail("HTTP", `Alpaca ${host} kept answering 429 (rate limit).`);
    },
  };
}
