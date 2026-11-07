import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/sessionAuth";

/**
 * Gate every app + API request behind a valid Polarito session cookie.
 * Public: /login (and its Server Actions), Next static assets, favicon.
 * Fail-closed: missing/invalid cookie => redirect to /login (pages) or 401 (API).
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static assets and the login page itself stay reachable without a session.
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  ) {
    // Already signed in? Send them to the app instead of showing the form again.
    if (pathname.startsWith("/login")) {
      const user = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
      if (user) {
        return NextResponse.redirect(new URL("/", request.url));
      }
    }
    return NextResponse.next();
  }

  const user = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (user) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, code: "UNAUTHORIZED", error: "Sign in required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    /*
     * Match all paths except Next internals and common static file extensions.
     * /login is handled inside the proxy (allow + bounce if already signed in).
     */
    "/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|gif|svg|webp|txt|xml|webmanifest)$).*)",
  ],
};
