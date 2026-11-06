"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  authIsConfigured,
  createSessionToken,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/sessionAuth";

export type LoginState =
  | { ok: true }
  | { ok: false; error: string }
  | undefined;

/**
 * Verify username/password against POLARITO_AUTH_* env vars and set the
 * httpOnly session cookie. Never echoes the password or secret back.
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  try {
    if (!authIsConfigured()) {
      return {
        ok: false,
        error:
          "Sign-in is not configured on this server. Set POLARITO_AUTH_USER, POLARITO_AUTH_PASSWORD, and POLARITO_AUTH_SECRET (see .env.example), then restart.",
      };
    }

    const username = String(formData.get("username") ?? "");
    const password = String(formData.get("password") ?? "");

    if (!username || !password) {
      return { ok: false, error: "Enter both username and password." };
    }

    if (!verifyPassword(username, password)) {
      return { ok: false, error: "Invalid username or password." };
    }

    const token = createSessionToken(username);
    if (!token) {
      return {
        ok: false,
        error: "Could not create a session. Check POLARITO_AUTH_SECRET and restart.",
      };
    }

    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, sessionCookieOptions());
  } catch (err) {
    console.error("loginAction failed:", err instanceof Error ? err.name : "unknown");
    return { ok: false, error: "Sign-in failed unexpectedly. Try again." };
  }

  redirect("/");
}

/** Clear the session cookie and send the visitor back to /login. */
export async function logoutAction(): Promise<void> {
  try {
    const jar = await cookies();
    jar.set(SESSION_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  } catch (err) {
    console.error("logoutAction failed:", err instanceof Error ? err.name : "unknown");
  }
  redirect("/login");
}
