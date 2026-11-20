/**
 * CSRF defence in depth for state-changing routes behind the session cookie
 * (the cookie is already SameSite=Lax). A browser POST always carries Origin
 * and Sec-Fetch-Site; a request with neither, or with a foreign Origin, is refused.
 */
export function sameOriginRequest(headers: { get(name: string): string | null }): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = headers.get("origin");
  if (origin === null) return site === "same-origin";
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim().toLowerCase();
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}
