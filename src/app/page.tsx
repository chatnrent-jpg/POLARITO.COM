import { Suspense } from "react";
import LiveBrokerGate from "@/components/LiveBrokerGate";
import PolarityDashboard from "@/components/PolarityDashboard";

export default function Home() {
  return (
    <main className="flex flex-1 bg-zinc-950 text-zinc-100">
      <PolarityDashboard />
      <Suspense fallback={null}>
        <LiveBrokerGate />
      </Suspense>
    </main>
  );
}
