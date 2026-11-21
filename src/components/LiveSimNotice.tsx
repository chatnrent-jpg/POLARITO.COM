"use client";

import { useLiveMode } from "@/components/LiveModeProvider";

/**
 * Footer-style notice at the very bottom of the page, shown only while live is on (render only: it reads the
 * shared live mode and holds no logic). It replaces the old "Auto · Simulation paused" block that sat near the top.
 */
export default function LiveSimNotice() {
  const { mode } = useLiveMode();
  if (mode.kind === "sim") return null;
  return (
    <section
      aria-label="Auto simulation (paused)"
      className="flex w-full max-w-5xl flex-col gap-1 rounded-2xl border border-zinc-700 bg-zinc-900/60 p-5 sm:p-6"
    >
      <h2 className="text-lg font-bold uppercase tracking-wider text-white">Auto · Simulation paused</h2>
      <p className="text-sm text-slate-400">
        The live account is on, so the browser simulation does not run and nothing is written to the simulated
        ledger. Live Auto is the switch in the LIVE account block of the order ticket card.
      </p>
    </section>
  );
}
