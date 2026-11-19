/**
 * Auth for scheduled jobs. Routes under CRON_PATH_PREFIX skip the browser
 * session gate (src/proxy.ts) because a scheduler has no cookie, so each of
 * them MUST call `cronAuthorized` itself.
 *
 * Fail-closed: no secret configured, or a secret that is too short to be a
 * real one, means NOBODY is authorized. Comparison is constant-time.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const CRON_PATH_PREFIX = "/api/cron/";
export const MIN_CRON_SECRET_LENGTH = 16;

const digest = (s: string) => createHash("sha256").update(s).digest();

export function cronAuthorized(
  authorizationHeader: string | null | undefined,
  secret: string | undefined,
): boolean {
  try {
    const expected = (secret ?? "").trim();
    if (expected.length < MIN_CRON_SECRET_LENGTH) return false;
    const header = authorizationHeader ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    return timingSafeEqual(digest(match[1]), digest(expected));
  } catch {
    return false;
  }
}
