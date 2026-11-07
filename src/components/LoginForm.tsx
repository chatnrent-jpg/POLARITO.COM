"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/app/actions/auth";

const initial: LoginState = undefined;

/**
 * Sign-in form. Matches the Polarito dashboard chrome (zinc field + light CTA).
 * Credentials are checked only on the server against POLARITO_AUTH_* env vars.
 */
export default function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initial);

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="username" className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Username
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          required
          disabled={pending}
          className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:opacity-50"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:opacity-50"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-opacity hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:cursor-wait disabled:opacity-40"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>

      {state && !state.ok && (
        <p
          role="alert"
          className="rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm font-medium text-red-200"
        >
          {state.error}
        </p>
      )}
    </form>
  );
}
