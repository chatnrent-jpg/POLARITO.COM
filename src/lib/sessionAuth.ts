/**
 * Single-user login gate for Polarito (Node / next start / Vercel).
 *
 * Credentials and signing secret come ONLY from server env:
 *   POLARITO_AUTH_USER
 *   POLARITO_AUTH_PASSWORD
 *   POLARITO_AUTH_SECRET   (random string, >= 16 chars; use openssl rand -hex 32)
 *
 * Fail-closed: missing env, bad cookie, or expired session => not authenticated.
 * This module is shared by the Proxy gate and the login Server Action.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "polarito_session";

/** Session lifetime after a successful login. */
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

type SessionPayload = {
  u: string;
  exp: number; // unix seconds
};

function authSecret(): string | null {
  const secret = process.env.POLARITO_AUTH_SECRET?.trim() ?? "";
  return secret.length >= 16 ? secret : null;
}

/** Expected username/password from env, or null if sign-in is not configured. */
export function configuredCredentials(): { user: string; password: string } | null {
  const user = process.env.POLARITO_AUTH_USER?.trim() ?? "";
  // Password: keep exact env value (only reject empty). Do not trim — spaces may be intentional.
  const password = process.env.POLARITO_AUTH_PASSWORD ?? "";
  if (!user || password.length === 0) return null;
  if (!authSecret()) return null;
  return { user, password };
}

export function authIsConfigured(): boolean {
  return configuredCredentials() !== null;
}

/** Constant-time string compare. Different lengths => false (no early content leak). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Buffer | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}

function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body, "utf8").digest());
}

export function createSessionToken(username: string, nowSec = Math.floor(Date.now() / 1000)): string | null {
  const secret = authSecret();
  if (!secret) return null;
  const payload: SessionPayload = {
    u: username,
    exp: nowSec + SESSION_MAX_AGE_SEC,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a session cookie value. Returns the username when valid, otherwise null.
 * Safe to call from Proxy (Node runtime) and Server Actions.
 */
export function verifySessionToken(
  token: string | undefined | null,
  nowSec = Math.floor(Date.now() / 1000),
): string | null {
  if (!token) return null;
  const secret = authSecret();
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = sign(body, secret);
  if (!safeEqual(sig, expected)) return null;

  const raw = fromB64url(body);
  if (!raw) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(raw.toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.u !== "string" || typeof payload.exp !== "number") return null;
  if (!Number.isFinite(payload.exp) || payload.exp < nowSec) return null;

  const creds = configuredCredentials();
  if (!creds) return null;
  if (!safeEqual(payload.u, creds.user)) return null;

  return payload.u;
}

export function verifyPassword(username: string, password: string): boolean {
  const creds = configuredCredentials();
  if (!creds) return false;
  return safeEqual(username, creds.user) && safeEqual(password, creds.password);
}

export function sessionCookieOptions(maxAgeSec = SESSION_MAX_AGE_SEC) {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSec,
  };
}
