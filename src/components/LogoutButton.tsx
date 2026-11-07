"use client";

import { logoutAction } from "@/app/actions/auth";

/** Clears the httpOnly session cookie via Server Action. */
export default function LogoutButton() {
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400 ring-1 ring-zinc-700 transition-colors hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
      >
        Sign out
      </button>
    </form>
  );
}
