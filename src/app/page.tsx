import { Suspense } from "react";
import { connection } from "next/server";
import LiveModeProvider from "@/components/LiveModeProvider";
import PolarityDashboard from "@/components/PolarityDashboard";
import { liveOptedIn } from "@/lib/broker/liveConfig";

/**
 * POLARITO_LIVE_ACCOUNT=1 decides, on the server, whether the account displays read the live Alpaca account
 * or today's simulated accounts. Without it the page is exactly the simulated dashboard and nothing live is fetched.
 */
async function Dashboard() {
  await connection();
  return (
    <LiveModeProvider optIn={liveOptedIn(process.env)}>
      <PolarityDashboard />
    </LiveModeProvider>
  );
}

export default function Home() {
  return (
    <main className="flex flex-1 bg-zinc-950 text-zinc-100">
      <Suspense fallback={null}>
        <Dashboard />
      </Suspense>
    </main>
  );
}
