/**
 * Alpaca credential diagnostic (read-only). Answers "what does the server actually see in its environment,
 * and does Alpaca accept it?" without ever returning a secret or a full key ID: only presence, the first two
 * characters and the length of a key ID, the length of a secret, yes/no flags about odd characters, HTTP
 * statuses and Alpaca's own message text (redacted if it ever echoed a credential).
 *
 * Pure except for the injected `fetchImpl`; every network call has its own try/catch and timeout, so a failing
 * call is reported as a failure and nothing throws. It places no order and writes nothing.
 */
import { ALPACA_DATA_BASE_URL, ALPACA_LIVE_BASE_URL } from "@/lib/broker/alpacaPaper";

type Env = Record<string, string | undefined>;

export type CredentialReport = {
  pair: "market-data" | "live" | "paper";
  keyIdVar: string;
  secretVar: string;
  keyIdPresent: boolean;
  secretPresent: boolean;
  keyIdPrefix: string | null;
  keyIdLength: number;
  secretLength: number;
  /** Alpaca: AK... = live, PK... = paper. Derived from the two prefix characters only. */
  keyIdKind: "live" | "paper" | "other" | null;
  flags: {
    leadingOrTrailingWhitespace: boolean;
    innerWhitespace: boolean;
    quoteCharacters: boolean;
    newline: boolean;
    nonAscii: boolean;
    /** Secret shorter than the key ID, or the key ID as long as a secret: probably pasted into the wrong field. */
    looksSwapped: boolean;
    /** Not 20 / 40 characters, the usual Alpaca lengths (a hint, not proof). */
    unusualLength: boolean;
  };
};

export type TestReport = {
  pair: CredentialReport["pair"];
  target: "data-bars" | "live-account";
  ok: boolean;
  status: number | null;
  message: string | null;
  failure: string | null;
};

export type KeyDiagnostic = {
  ok: true;
  deployment: { vercelEnv: string | null; commit: string | null; nodeEnv: string | null };
  feedSetting: "iex" | "sip" | "invalid";
  pairs: CredentialReport[];
  marketDataSameAsLive: { keyId: boolean; secret: boolean } | null;
  tests: TestReport[];
  hints: string[];
};

export type DiagFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const QUOTES = /["'`\u2018\u2019\u201C\u201D]/;
const TEST_TIMEOUT_MS = 8_000;

const PAIRS: ReadonlyArray<{ pair: CredentialReport["pair"]; keyIdVar: string; secretVar: string }> = [
  { pair: "market-data", keyIdVar: "ALPACA_API_KEY_ID", secretVar: "ALPACA_API_SECRET_KEY" },
  { pair: "live", keyIdVar: "ALPACA_LIVE_KEY_ID", secretVar: "ALPACA_LIVE_SECRET_KEY" },
  { pair: "paper", keyIdVar: "ALPACA_PAPER_KEY_ID", secretVar: "ALPACA_PAPER_SECRET_KEY" },
];

/** Inspects one raw pair exactly as it sits in the environment. Returns no value. */
export function inspectPair(pair: CredentialReport["pair"], keyIdVar: string, secretVar: string, rawId: string | undefined, rawSecret: string | undefined): CredentialReport {
  const id = rawId ?? "";
  const secret = rawSecret ?? "";
  const both = `${id}\u0000${secret}`;
  const idT = id.trim();
  const secretT = secret.trim();
  const prefix = idT.length >= 2 ? idT.slice(0, 2) : null;
  return {
    pair,
    keyIdVar,
    secretVar,
    keyIdPresent: idT !== "",
    secretPresent: secretT !== "",
    keyIdPrefix: prefix,
    keyIdLength: id.length,
    secretLength: secret.length,
    keyIdKind: prefix === null ? null : prefix.toUpperCase() === "AK" ? "live" : prefix.toUpperCase() === "PK" ? "paper" : "other",
    flags: {
      leadingOrTrailingWhitespace: id !== idT || secret !== secretT,
      innerWhitespace: /\s/.test(idT) || /\s/.test(secretT),
      quoteCharacters: QUOTES.test(id) || QUOTES.test(secret),
      newline: /[\r\n]/.test(both),
      nonAscii: /[^\x00-\x7f]/.test(both),
      looksSwapped: idT !== "" && secretT !== "" && (secretT.length < idT.length || idT.length >= 30),
      unusualLength: (idT !== "" && idT.length !== 20) || (secretT !== "" && secretT.length !== 40),
    },
  };
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
  return out.slice(0, 200);
}

async function callAlpaca(
  fetchImpl: DiagFetch,
  url: string,
  keyId: string,
  secretKey: string,
  redactions: string[],
): Promise<{ status: number; message: string | null } | { failure: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey, Accept: "application/json" },
      signal: controller.signal,
    });
    let message: string | null = null;
    if (res.status < 200 || res.status >= 300) {
      message = "(Alpaca sent no JSON message)";
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body?.message === "string") message = redact(body.message, redactions);
      } catch {
        // The data host answers a bad key with an HTML 401 page; the status is the answer.
      }
    }
    return { status: res.status, message };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") return { failure: "The call timed out." };
    // A header value with a newline or odd character cannot even be sent; say so without echoing it.
    if (e instanceof TypeError && /header|invalid/i.test(e.message)) return { failure: "The value contains characters that cannot be sent in an HTTP header." };
    return { failure: "The call could not be completed (network error)." };
  } finally {
    clearTimeout(timer);
  }
}

function barsUrl(): string {
  const url = new URL(`${ALPACA_DATA_BASE_URL}/v2/stocks/bars`);
  url.searchParams.set("symbols", "AAPL");
  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("limit", "1");
  url.searchParams.set("feed", "iex");
  return url.toString();
}

function feedSetting(env: Env): KeyDiagnostic["feedSetting"] {
  const raw = (env.ALPACA_DATA_FEED ?? "iex").trim().toLowerCase();
  return raw === "iex" || raw === "sip" ? raw : "invalid";
}

export function buildHints(pairs: CredentialReport[], tests: TestReport[]): string[] {
  const hints: string[] = [];
  const get = (pair: CredentialReport["pair"]) => pairs.find((p) => p.pair === pair);
  const t = (pair: CredentialReport["pair"], target: TestReport["target"]) => tests.find((x) => x.pair === pair && x.target === target);
  const accepted = (x: TestReport | undefined) => x?.ok === true;
  const rejected = (x: TestReport | undefined) => x !== undefined && !x.ok && (x.status === 401 || x.status === 403);

  const md = get("market-data");
  if (md && (!md.keyIdPresent || !md.secretPresent)) hints.push("The market-data variables ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not both set on this deployment.");
  for (const p of pairs) {
    if (!p.keyIdPresent && !p.secretPresent) continue;
    if (p.flags.quoteCharacters) hints.push(`${p.pair}: a value contains quote characters. Re-enter it without quotation marks.`);
    if (p.flags.leadingOrTrailingWhitespace || p.flags.newline) hints.push(`${p.pair}: a value has leading/trailing whitespace or a newline. Re-enter it with nothing around it.`);
    if (p.flags.nonAscii) hints.push(`${p.pair}: a value has a non-ASCII character (often a pasted invisible character). Type or re-copy it.`);
    if (p.flags.looksSwapped) hints.push(`${p.pair}: the key ID and secret look swapped or mispasted (lengths).`);
  }
  const mdBars = t("market-data", "data-bars");
  const liveBars = t("live", "data-bars");
  const liveAcct = t("live", "live-account");
  if (rejected(mdBars) && accepted(liveBars)) hints.push("Market-data pair is rejected but the live pair is accepted by the same data endpoint: the market-data variables hold a different or wrong pair. Copy the live pair into ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY (or fix those two values).");
  if (rejected(mdBars) && rejected(liveBars)) hints.push("Both pairs are rejected by the data endpoint: the keys themselves are not accepted by Alpaca (revoked, regenerated, or key ID and secret from different keys). Generate a new pair and copy the secret right away.");
  if (accepted(mdBars)) hints.push("The market-data pair is accepted by Alpaca from this deployment. If the page still errors, this is a different deployment than the one serving the page, or a transient issue: reload and check the deployment info.");
  if (md?.keyIdKind === "paper" && accepted(mdBars)) hints.push("The market-data key ID is a paper key (PK...). It works for data, but in live mode use the live pair so nothing depends on the paper account.");
  if (accepted(liveBars) && rejected(liveAcct)) hints.push("The live pair works for market data but the live trading account rejects it: it may be a paper pair stored in ALPACA_LIVE_*, or live trading is not enabled for that key.");
  return hints;
}

/** The whole report. Never throws; a failing step is reported, not raised. */
export async function runKeyDiagnostic(env: Env, fetchImpl: DiagFetch): Promise<KeyDiagnostic> {
  const pairs = PAIRS.map((p) => inspectPair(p.pair, p.keyIdVar, p.secretVar, env[p.keyIdVar], env[p.secretVar]));
  const trimmed = (name: string) => (env[name] ?? "").trim();

  const everyCredential = PAIRS.flatMap((p) => [trimmed(p.keyIdVar), trimmed(p.secretVar)]).filter(Boolean);
  const jobs: Array<Promise<TestReport>> = [];
  const schedule = (pair: CredentialReport["pair"], target: TestReport["target"], url: string) => {
    const def = PAIRS.find((p) => p.pair === pair)!;
    const id = trimmed(def.keyIdVar);
    const secret = trimmed(def.secretVar);
    if (!id || !secret) return;
    jobs.push(
      callAlpaca(fetchImpl, url, id, secret, everyCredential).then((r): TestReport =>
        "failure" in r
          ? { pair, target, ok: false, status: null, message: null, failure: r.failure }
          : { pair, target, ok: r.status >= 200 && r.status < 300, status: r.status, message: r.message, failure: null },
      ),
    );
  };
  // The app sends the trimmed values, so the tests do too.
  schedule("market-data", "data-bars", barsUrl());
  schedule("live", "data-bars", barsUrl());
  schedule("live", "live-account", `${ALPACA_LIVE_BASE_URL}/v2/account`);
  const tests = await Promise.all(jobs);

  const mdId = trimmed("ALPACA_API_KEY_ID");
  const mdSecret = trimmed("ALPACA_API_SECRET_KEY");
  const liveId = trimmed("ALPACA_LIVE_KEY_ID");
  const liveSecret = trimmed("ALPACA_LIVE_SECRET_KEY");
  return {
    ok: true,
    deployment: {
      vercelEnv: env.VERCEL_ENV ?? null,
      commit: env.VERCEL_GIT_COMMIT_SHA ? env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null,
      nodeEnv: env.NODE_ENV ?? null,
    },
    feedSetting: feedSetting(env),
    pairs,
    marketDataSameAsLive: mdId && liveId ? { keyId: mdId === liveId, secret: Boolean(mdSecret && liveSecret && mdSecret === liveSecret) } : null,
    tests,
    hints: buildHints(pairs, tests),
  };
}

/**
 * Who may call the diagnostic (it makes outbound calls to Alpaca, so a cross-site page must not trigger it).
 * A person opening the URL in the address bar sends Sec-Fetch-Site: none; the app's own pages send same-origin.
 * Cross-site / same-site are refused. With no Sec-Fetch-Site header only a matching Origin passes (fail closed).
 */
export function diagRequestAllowed(headers: { get(name: string): string | null }): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = headers.get("origin");
  if (origin === null) return false;
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim().toLowerCase();
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}
