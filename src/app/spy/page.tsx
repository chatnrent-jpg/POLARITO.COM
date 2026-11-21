import { Suspense } from "react";
import { connection } from "next/server";
import LogoutButton from "@/components/LogoutButton";
import SpyDesk from "@/components/spy/SpyDesk";
import { deskEnabled } from "@/lib/spyDesk";

export const metadata = { title: "Polarito: SPY desk (dry run)" };

/**
 * The SPY desk page. Off by default: it renders only a notice unless the server has POLARITO_SPY_DESK=1.
 * The page itself holds no data and no logic; SpyDesk (client) loads /api/spy/desk and draws it.
 */
async function Desk() {
  await connection();
  if (!deskEnabled(process.env)) {
    return (
      <div className="mx-auto max-w-xl p-8 text-zinc-300" data-testid="desk-off">
        <h1 className="mb-2 text-xl font-semibold text-zinc-100">SPY desk is switched off</h1>
        <p className="text-sm">This page is off by default. It is turned on by the server setting POLARITO_SPY_DESK=1. It is dry run only and can never send an order.</p>
      </div>
    );
  }
  return <SpyDesk />;
}

export default function SpyPage() {
  return (
    <main className="flex flex-1 flex-col bg-zinc-950 text-zinc-100">
      <div className="flex justify-end px-4 pt-3 sm:px-6">
        <LogoutButton />
      </div>
      <Suspense fallback={null}>
        <Desk />
      </Suspense>
    </main>
  );
}
