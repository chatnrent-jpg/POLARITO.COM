import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { diagRequestAllowed, inspectPair, runKeyDiagnostic, type DiagFetch } from "../src/lib/keyDiagnostic";

const LIVE_ID = "AKLIVEID1234567890XY";
const LIVE_SECRET = "liveSECRET0123456789abcdefghijklmnopqrst";
const OLD_ID = "PKOLDPAPER1234567890";
const OLD_SECRET = "oldSECRET0123456789abcdefghijklmnopqrst";

type Reply = { status: number; body?: unknown } | "throw" | "header-error";
function fakeFetch(rule: (url: string, keyId: string) => Reply): { fetchImpl: DiagFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: DiagFetch = async (url, init) => {
    calls.push(url);
    const r = rule(url, init.headers["APCA-API-KEY-ID"]);
    if (r === "throw") throw new Error("socket");
    if (r === "header-error") throw new TypeError("Headers.append: invalid header value");
    return { status: r.status, json: async () => r.body ?? {} };
  };
  return { fetchImpl, calls };
}
const ok = (): Reply => ({ status: 200, body: { bars: [] } });
const denied = (): Reply => ({ status: 401, body: { message: "unauthorized." } });

describe("inspectPair", () => {
  it("reports presence, prefix, lengths and kind, never a value", () => {
    const r = inspectPair("live", "ALPACA_LIVE_KEY_ID", "ALPACA_LIVE_SECRET_KEY", LIVE_ID, LIVE_SECRET);
    assert.equal(r.keyIdPresent, true);
    assert.equal(r.keyIdPrefix, "AK");
    assert.equal(r.keyIdLength, 20);
    assert.equal(r.secretLength, 40);
    assert.equal(r.keyIdKind, "live");
    assert.deepEqual(Object.values(r.flags).filter(Boolean), []);
    const text = JSON.stringify(r);
    assert.ok(!text.includes(LIVE_ID) && !text.includes(LIVE_SECRET));
  });

  it("flags whitespace, quotes, newline, non-ascii", () => {
    assert.equal(inspectPair("market-data", "a", "b", ` ${LIVE_ID}`, LIVE_SECRET).flags.leadingOrTrailingWhitespace, true);
    assert.equal(inspectPair("market-data", "a", "b", `"${LIVE_ID}"`, LIVE_SECRET).flags.quoteCharacters, true);
    assert.equal(inspectPair("market-data", "a", "b", LIVE_ID, `\u201C${LIVE_SECRET}\u201D`).flags.quoteCharacters, true);
    const nl = inspectPair("market-data", "a", "b", LIVE_ID, `${LIVE_SECRET}\n`);
    assert.equal(nl.flags.newline, true);
    assert.equal(nl.flags.leadingOrTrailingWhitespace, true);
    assert.equal(inspectPair("market-data", "a", "b", LIVE_ID, `${LIVE_SECRET}\u200b`).flags.nonAscii, true);
    assert.equal(inspectPair("market-data", "a", "b", "AK12 34", LIVE_SECRET).flags.innerWhitespace, true);
  });

  it("flags a swapped or mispasted pair and unusual lengths", () => {
    assert.equal(inspectPair("live", "a", "b", LIVE_SECRET, LIVE_ID).flags.looksSwapped, true);
    assert.equal(inspectPair("live", "a", "b", LIVE_ID, "short").flags.looksSwapped, true);
    assert.equal(inspectPair("live", "a", "b", LIVE_ID, LIVE_SECRET).flags.looksSwapped, false);
    assert.equal(inspectPair("live", "a", "b", LIVE_ID, "x".repeat(41)).flags.unusualLength, true);
  });

  it("handles a missing pair", () => {
    const r = inspectPair("paper", "a", "b", undefined, undefined);
    assert.equal(r.keyIdPresent, false);
    assert.equal(r.keyIdPrefix, null);
    assert.equal(r.keyIdKind, null);
  });
});

describe("runKeyDiagnostic", () => {
  const env = (extra: Record<string, string> = {}) => ({
    ALPACA_API_KEY_ID: OLD_ID,
    ALPACA_API_SECRET_KEY: OLD_SECRET,
    ALPACA_LIVE_KEY_ID: LIVE_ID,
    ALPACA_LIVE_SECRET_KEY: LIVE_SECRET,
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_SHA: "0123456789abcdef",
    ...extra,
  });

  it("market-data rejected, live accepted: reports statuses, deployment and the matching hint, no secrets", async () => {
    const { fetchImpl, calls } = fakeFetch((url, id) => (url.includes("data.alpaca.markets") ? (id === OLD_ID ? denied() : ok()) : { status: 200, body: { status: "ACTIVE" } }));
    const d = await runKeyDiagnostic(env(), fetchImpl);
    assert.deepEqual(d.deployment, { vercelEnv: "production", commit: "0123456", nodeEnv: process.env.NODE_ENV ?? null });
    const md = d.tests.find((t) => t.pair === "market-data");
    assert.equal(md?.status, 401);
    assert.equal(md?.message, "unauthorized.");
    assert.equal(d.tests.find((t) => t.pair === "live" && t.target === "data-bars")?.ok, true);
    assert.equal(d.tests.find((t) => t.pair === "live" && t.target === "live-account")?.ok, true);
    assert.ok(d.hints.some((h) => /market-data pair is rejected but the live pair is accepted/i.test(h)));
    assert.deepEqual(d.marketDataSameAsLive, { keyId: false, secret: false });
    assert.ok(calls.every((u) => u.startsWith("https://data.alpaca.markets/") || u === "https://api.alpaca.markets/v2/account"));
    assert.ok(calls.filter((u) => u.includes("data.alpaca.markets")).every((u) => u.includes("symbols=AAPL") && u.includes("limit=1") && u.includes("feed=iex") && u.includes("timeframe=1Day")));
    const text = JSON.stringify(d);
    for (const v of [OLD_ID, OLD_SECRET, LIVE_ID, LIVE_SECRET]) assert.ok(!text.includes(v), "leaked a credential");
  });

  it("never calls paper hosts and skips tests for absent pairs", async () => {
    const { fetchImpl, calls } = fakeFetch(ok);
    const d = await runKeyDiagnostic({ ALPACA_PAPER_KEY_ID: OLD_ID, ALPACA_PAPER_SECRET_KEY: OLD_SECRET }, fetchImpl);
    assert.equal(calls.length, 0);
    assert.deepEqual(d.tests, []);
    assert.equal(d.pairs.find((p) => p.pair === "paper")?.keyIdKind, "paper");
    assert.equal(d.pairs.find((p) => p.pair === "market-data")?.keyIdPresent, false);
    assert.ok(d.hints.some((h) => /not both set/.test(h)));
  });

  it("both rejected points at the keys themselves", async () => {
    const { fetchImpl } = fakeFetch(denied);
    const d = await runKeyDiagnostic(env(), fetchImpl);
    assert.ok(d.hints.some((h) => /Both pairs are rejected/.test(h)));
  });

  it("market-data accepted says the page deployment may differ", async () => {
    const { fetchImpl } = fakeFetch(ok);
    const d = await runKeyDiagnostic(env(), fetchImpl);
    assert.ok(d.hints.some((h) => /accepted by Alpaca from this deployment/.test(h)));
  });

  it("sends the trimmed values the app sends, and flags the raw whitespace", async () => {
    const seen: string[] = [];
    const fetchImpl: DiagFetch = async (_u, init) => {
      seen.push(init.headers["APCA-API-KEY-ID"]);
      return { status: 200, json: async () => ({}) };
    };
    const d = await runKeyDiagnostic(env({ ALPACA_API_KEY_ID: ` ${LIVE_ID}\n` }), fetchImpl);
    assert.ok(seen.includes(LIVE_ID));
    assert.equal(d.pairs[0].flags.leadingOrTrailingWhitespace, true);
    assert.equal(d.marketDataSameAsLive?.keyId, true);
  });

  it("reports failures without throwing, and redacts a credential echoed by Alpaca", async () => {
    const t1 = await runKeyDiagnostic(env(), fakeFetch(() => "throw").fetchImpl);
    assert.ok(t1.tests.every((t) => !t.ok && t.status === null && t.failure));
    const t2 = await runKeyDiagnostic(env(), fakeFetch(() => "header-error").fetchImpl);
    assert.ok(t2.tests.every((t) => /cannot be sent/.test(t.failure ?? "")));
    const t3 = await runKeyDiagnostic(env(), fakeFetch(() => ({ status: 401, body: { message: `bad ${LIVE_ID} and ${OLD_SECRET}` } })).fetchImpl);
    const text = JSON.stringify(t3);
    assert.ok(!text.includes(LIVE_ID) && !text.includes(OLD_SECRET));
    assert.ok(text.includes("[redacted]"));
  });

  it("an invalid data feed setting is reported, not used", async () => {
    const d = await runKeyDiagnostic(env({ ALPACA_DATA_FEED: "bogus" }), fakeFetch(ok).fetchImpl);
    assert.equal(d.feedSetting, "invalid");
  });
});

describe("diagRequestAllowed", () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
  it("allows the address bar and the app's own pages, refuses cross-site and header-less requests", () => {
    assert.equal(diagRequestAllowed(h({ "sec-fetch-site": "none" })), true);
    assert.equal(diagRequestAllowed(h({ "sec-fetch-site": "same-origin" })), true);
    assert.equal(diagRequestAllowed(h({ "sec-fetch-site": "cross-site" })), false);
    assert.equal(diagRequestAllowed(h({ "sec-fetch-site": "same-site" })), false);
    assert.equal(diagRequestAllowed(h({})), false);
    assert.equal(diagRequestAllowed(h({ origin: "https://www.polarito.com", host: "www.polarito.com" })), true);
    assert.equal(diagRequestAllowed(h({ origin: "https://evil.example", host: "www.polarito.com" })), false);
  });
});

describe("route file", () => {
  const route = readFileSync(new URL("../src/app/api/diag/alpaca-keys/route.node.ts", import.meta.url), "utf8");
  it("is GET only, no-store, behind the cross-site check, and catches everything", () => {
    assert.match(route, /export async function GET/);
    assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
    assert.match(route, /diagRequestAllowed\(request\.headers\)/);
    assert.match(route, /no-store/);
    assert.match(route, /catch/);
  });
});
