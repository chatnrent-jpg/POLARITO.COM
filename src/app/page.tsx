import PageRefresher from "@/components/PageRefresher";
import PolarityDashboard from "@/components/PolarityDashboard";

export default function Home() {
  return (
    <main className="flex flex-1 bg-zinc-950 text-zinc-100">
      {/* Full reload every 5s — only mounted after Proxy lets an authenticated session through. */}
      <PageRefresher />
      <PolarityDashboard />
    </main>
  );
}
