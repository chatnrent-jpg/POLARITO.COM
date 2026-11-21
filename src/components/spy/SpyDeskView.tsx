import type { ReactNode } from "react";
import type { OptionType } from "@/lib/broker/options";
import type { CandidateList, ContractView, DeskSnapshot, ReadingView } from "@/lib/spyDesk";
import { MANUAL_BELOW_TARGET_LABEL } from "@/lib/spyDesk";
import { dateTimeText, decisionHeadline, money, netFlagText, netVolumeText, percent, price, signedDelta } from "@/lib/spyDeskFormat";

/**
 * Pure rendering of the SPY desk. No fetching, no decisions, no storage: it draws exactly what it is given and calls the
 * handlers it is handed. Everything here is DRY RUN: the ticket and Close change a saved record, never a broker account.
 */

export type DeskLoad = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; snapshot: DeskSnapshot };
export type TicketUi = { type: OptionType; symbol: string | null; ack: boolean };
export type CloseUi = { stage: "idle" | "confirm"; ack: boolean; offerUnpriced: boolean };
export type Notice = { kind: "ok" | "error"; text: string };

export type DeskViewProps = {
  load: DeskLoad;
  busy: boolean;
  notice: Notice | null;
  ticket: TicketUi;
  close: CloseUi;
  onRefresh(): void;
  onTicketChange(next: Partial<TicketUi>): void;
  onSubmitTicket(): void;
  onCloseChange(next: Partial<CloseUi>): void;
  onSubmitClose(unpriced: boolean): void;
};

const card = "rounded-lg border border-zinc-800 bg-zinc-900/60 p-4";
const h2 = "mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400";
const btn = "rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40";

function Badge({ tone, children }: { tone: "green" | "red" | "amber" | "zinc" | "rose"; children: ReactNode }) {
  const tones = {
    green: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
    red: "bg-red-500/15 text-red-300 ring-red-500/40",
    amber: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
    zinc: "bg-zinc-700/30 text-zinc-300 ring-zinc-600/50",
    rose: "bg-rose-500/15 text-rose-300 ring-rose-500/40",
  } as const;
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ring-1 ${tones[tone]}`}>{children}</span>;
}

const readingTone = (label: string): "green" | "red" | "amber" | "rose" => (label === "Drive" ? "green" : label === "Reverse" ? "red" : label === "Neutral" ? "amber" : "rose");

function ReadingsTable({ readings }: { readings: ReadingView[] }) {
  if (readings.length === 0) {
    return <p className="text-sm text-rose-300">Data unavailable: no reading could be computed. Nothing is assumed.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="text-xs uppercase text-zinc-500">
          <tr>
            <th className="py-1 pr-3">Timeframe</th>
            <th className="py-1 pr-3">Candle (open to close)</th>
            <th className="py-1 pr-3">Previous period close</th>
            <th className="py-1 pr-3 text-right">Raw net volume</th>
            <th className="py-1 pr-3">Match</th>
            <th className="py-1">Reading</th>
          </tr>
        </thead>
        <tbody>
          {readings.map((r) => (
            <tr key={r.timeframe} className={`border-t border-zinc-800 align-top ${r.isDecision ? "bg-zinc-800/40" : ""}`} data-testid={`reading-${r.timeframe}`}>
              <td className="py-2 pr-3 font-medium">
                {r.name}
                {r.isDecision ? <span className="ml-2 text-xs text-sky-300">decides</span> : null}
              </td>
              <td className="py-2 pr-3">
                {r.status === "ok" ? (
                  <span className={r.candle === "green" ? "text-emerald-300" : r.candle === "red" ? "text-red-300" : "text-zinc-300"}>
                    {r.candle} ({price(r.open)} to {price(r.close)})
                  </span>
                ) : (
                  <span className="text-zinc-500">n/a</span>
                )}
              </td>
              <td className="py-2 pr-3">{r.status === "ok" ? price(r.previousClose) : "n/a"}</td>
              <td className="py-2 pr-3 text-right font-mono">
                {netVolumeText(r.netVolume)}
                {r.netFlag ? <div className="text-xs font-sans font-semibold text-amber-300">[{netFlagText(r.netFlag)}]</div> : null}
              </td>
              <td className="py-2 pr-3">{r.match === "agree" ? "agree" : r.match === "disagree" ? <span className="text-amber-300">disagree</span> : "n/a"}</td>
              <td className="py-2">
                <Badge tone={readingTone(r.label)}>{r.label}</Badge>
                {r.status === "unavailable" && r.reason ? <div className="mt-1 max-w-xs text-xs text-rose-300">{r.reason}</div> : null}
                <div className="mt-1 text-xs text-zinc-500">since {r.periodStart ?? "n/a"}, as of {dateTimeText(r.asOf)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContractLine({ c }: { c: ContractView }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
      <div><dt className="text-xs text-zinc-500">Contract</dt><dd className="font-mono">{c.symbol}</dd></div>
      <div><dt className="text-xs text-zinc-500">Strike / expiry</dt><dd>{c.strike} / {c.expiration} ({c.daysToExpiry} days)</dd></div>
      <div><dt className="text-xs text-zinc-500">Delta</dt><dd>{signedDelta(c.delta)} ({c.deltaSource})</dd></div>
      <div><dt className="text-xs text-zinc-500">Bid / ask</dt><dd>{price(c.bid)} / {price(c.ask)} (spread {percent(c.spreadPct)})</dd></div>
      <div><dt className="text-xs text-zinc-500">Cost per contract (ask x 100)</dt><dd className="font-semibold">{money(c.costAtAsk)}</dd></div>
      <div><dt className="text-xs text-zinc-500">Quote time</dt><dd>{dateTimeText(c.quoteAt)}</dd></div>
    </dl>
  );
}

function EnginePick({ pick, rules }: { pick: DeskSnapshot["enginePick"]; rules: DeskSnapshot["rules"] }) {
  if (pick.status === "not-applicable") return <p className="text-sm text-zinc-400">{pick.reason}</p>;
  if (pick.status === "none") {
    return (
      <p className="text-sm text-amber-300">
        NO {pick.type.toUpperCase()} CONTRACT: {pick.reason}
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="engine-pick">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={pick.type === "call" ? "green" : "red"}>{pick.type.toUpperCase()}</Badge>
        {pick.fallbackLabel ? <Badge tone="amber">{pick.fallbackLabel}</Badge> : <Badge tone="zinc">|delta| at least {rules.primary.toFixed(2)}</Badge>}
      </div>
      <ContractLine c={pick.contract} />
      {pick.fallbackLabel ? (
        <p className="text-sm text-amber-200" data-testid="fallback-why">
          {pick.fallbackLabel}: the actual delta is {signedDelta(pick.contract.delta)}, below the {rules.primary.toFixed(2)} target. Why: {pick.fallbackReason}. The {rules.floor.toFixed(2)} floor is never crossed.
        </p>
      ) : null}
      <p className={`text-sm ${pick.affordable ? "text-zinc-300" : "text-zinc-400"}`}>
        {pick.affordable ? `Fits the ${money(pick.budget)} live account.` : `Not affordable on the ${money(pick.budget)} live account (short by ${money(pick.shortfall)}). Dry run only.`}
      </p>
    </div>
  );
}

function PositionCard({ props, snap }: { props: DeskViewProps; snap: DeskSnapshot }) {
  const pos = snap.position;
  if (pos.status === "unknown") {
    return <p className="text-sm text-rose-300" data-testid="position-unknown">Dry-run position unknown: {pos.reason} Nothing is assumed, so Close and the ticket are off.</p>;
  }
  if (pos.status === "none") return <p className="text-sm text-zinc-400" data-testid="position-none">No dry-run position held.</p>;
  const { close } = props;
  return (
    <div className="space-y-3" data-testid="position-held">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={pos.type === "call" ? "green" : "red"}>{pos.type.toUpperCase()}</Badge>
        <Badge tone="zinc">MANUAL, DRY RUN</Badge>
        {pos.belowTargetLabel ? <Badge tone="amber">{pos.belowTargetLabel}</Badge> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-zinc-500">Contract</dt><dd className="font-mono">{pos.symbol}</dd></div>
        <div><dt className="text-xs text-zinc-500">Strike / expiry</dt><dd>{pos.strike} / {pos.expiration}</dd></div>
        <div><dt className="text-xs text-zinc-500">Entry (ask) / delta</dt><dd>{price(pos.entryAsk)} / {signedDelta(pos.entryDelta)}</dd></div>
        <div><dt className="text-xs text-zinc-500">Entry cost / max loss</dt><dd>{money(pos.costUsd)}</dd></div>
        <div><dt className="text-xs text-zinc-500">Now (bid / ask)</dt><dd>{pos.quote ? `${price(pos.quote.bid)} / ${price(pos.quote.ask)}` : "no usable quote right now"}</dd></div>
        <div><dt className="text-xs text-zinc-500">Result if closed at the bid</dt><dd className={pos.quote ? (pos.quote.pnlUsd >= 0 ? "text-emerald-300" : "text-red-300") : "text-zinc-500"}>{pos.quote ? money(pos.quote.pnlUsd) : "unknown"}</dd></div>
      </dl>
      {close.stage === "idle" ? (
        <button type="button" className={`${btn} bg-zinc-700 text-zinc-100 hover:bg-zinc-600`} disabled={props.busy} onClick={() => props.onCloseChange({ stage: "confirm", ack: false })} data-testid="close-start">
          Close (dry run)
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-950/60 p-3" data-testid="close-confirm">
          <label className="flex items-start gap-2 text-sm text-zinc-200">
            <input type="checkbox" checked={close.ack} onChange={(e) => props.onCloseChange({ ack: e.target.checked })} className="mt-1" data-testid="close-ack" />
            <span>I understand this only closes the dry-run record. No order is sent to any broker.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${btn} bg-amber-600 text-black hover:bg-amber-500`} disabled={props.busy || !close.ack} onClick={() => props.onSubmitClose(false)} data-testid="close-submit">
              Close at the current bid (dry run)
            </button>
            {close.offerUnpriced ? (
              <button type="button" className={`${btn} bg-zinc-700 text-zinc-100 hover:bg-zinc-600`} disabled={props.busy || !close.ack} onClick={() => props.onSubmitClose(true)} data-testid="close-unpriced">
                Close without a price (result unknown)
              </button>
            ) : null}
            <button type="button" className={`${btn} text-zinc-300 hover:text-white`} disabled={props.busy} onClick={() => props.onCloseChange({ stage: "idle", ack: false, offerUnpriced: false })}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CandidateTable({ list, selected, onSelect, disabled, primary }: { list: CandidateList; selected: string | null; onSelect(symbol: string): void; disabled: boolean; primary: number }) {
  if (list.error && list.shown.length === 0) return <p className="text-sm text-rose-300">The {list.type} chain could not be read: {list.error}</p>;
  if (list.shown.length === 0) return <p className="text-sm text-amber-300">No {list.type} passes the rules right now. Nothing to choose.</p>;
  return (
    <div>
      <p className="mb-2 text-xs text-zinc-500">
        Expiry {list.expiration ?? "n/a"} (nearest listed, at least 365 days). {list.total > list.shown.length ? `Showing the ${list.shown.length} cheapest of ${list.total}.` : `${list.total} contracts.`} Cheapest first.
      </p>
      <div className="max-h-72 overflow-auto rounded border border-zinc-800">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="sticky top-0 bg-zinc-900 text-xs uppercase text-zinc-500">
            <tr><th className="p-2" /><th className="p-2">Strike</th><th className="p-2">Delta</th><th className="p-2">Bid / ask</th><th className="p-2">Spread</th><th className="p-2 text-right">Cost (ask x 100)</th><th className="p-2">Note</th></tr>
          </thead>
          <tbody>
            {list.shown.map((c) => (
              <tr key={c.symbol} className={`border-t border-zinc-800 ${selected === c.symbol ? "bg-sky-500/10" : ""}`}>
                <td className="p-2"><input type="radio" name="ticket-contract" value={c.symbol} checked={selected === c.symbol} disabled={disabled} onChange={() => onSelect(c.symbol)} aria-label={`Choose ${c.symbol}`} /></td>
                <td className="p-2">{c.strike}</td>
                <td className="p-2">{signedDelta(c.delta)}</td>
                <td className="p-2">{price(c.bid)} / {price(c.ask)}</td>
                <td className="p-2">{percent(c.spreadPct)}</td>
                <td className="p-2 text-right font-mono">{money(c.costAtAsk)}</td>
                <td className="p-2 text-xs text-amber-300">{c.belowTarget ? `below ${primary.toFixed(2)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TicketCard({ props, snap }: { props: DeskViewProps; snap: DeskSnapshot }) {
  const t = snap.ticket;
  const { ticket } = props;
  if (!t.open) {
    return (
      <p className="text-sm text-zinc-400" data-testid="ticket-closed">
        Manual ticket is off. {t.reason}
      </p>
    );
  }
  const list = ticket.type === "call" ? t.calls : t.puts;
  const chosen = list?.shown.find((c) => c.symbol === ticket.symbol) ?? null;
  return (
    <div className="space-y-3" data-testid="ticket-open">
      <p className="text-sm text-amber-200">NEUTRAL: TRADER DECIDES. Choose a call or a put and one contract from the rules-filtered chain. This records a dry-run position only.</p>
      <div className="flex gap-2" role="group" aria-label="Call or put">
        {(["call", "put"] as const).map((ty) => (
          <button key={ty} type="button" disabled={props.busy} aria-pressed={ticket.type === ty} onClick={() => props.onTicketChange({ type: ty, symbol: null })} className={`${btn} ${ticket.type === ty ? (ty === "call" ? "bg-emerald-600 text-white" : "bg-red-600 text-white") : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`} data-testid={`ticket-type-${ty}`}>
            {ty === "call" ? "Call" : "Put"}
          </button>
        ))}
      </div>
      {list ? <CandidateTable list={list} selected={ticket.symbol} onSelect={(symbol) => props.onTicketChange({ symbol })} disabled={props.busy} primary={snap.rules.primary} /> : null}
      {chosen ? (
        <div className="rounded-md border border-zinc-700 bg-zinc-950/60 p-3 text-sm" data-testid="ticket-summary">
          <div className="mb-1 font-semibold">DRY RUN: would buy 1 {chosen.type.toUpperCase()} {chosen.symbol} at the ask {price(chosen.ask)}, cost {money(chosen.costAtAsk)} (max loss = premium).</div>
          {chosen.belowTarget ? <div className="text-amber-300">{MANUAL_BELOW_TARGET_LABEL}: delta {signedDelta(chosen.delta)} is below the {snap.rules.primary.toFixed(2)} target.</div> : null}
          <label className="mt-2 flex items-start gap-2 text-zinc-200">
            <input type="checkbox" checked={ticket.ack} onChange={(e) => props.onTicketChange({ ack: e.target.checked })} className="mt-1" data-testid="ticket-ack" />
            <span>I understand this only records a dry-run position. No order is sent to any broker.</span>
          </label>
          <button type="button" className={`${btn} mt-3 bg-amber-600 text-black hover:bg-amber-500`} disabled={props.busy || !ticket.ack} onClick={props.onSubmitTicket} data-testid="ticket-submit">
            Record dry-run buy
          </button>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">Pick a contract to continue.</p>
      )}
    </div>
  );
}

function Journal({ entries }: { entries: DeskSnapshot["journal"] }) {
  if (entries.length === 0) return <p className="text-sm text-zinc-500">No manual dry-run actions recorded yet.</p>;
  return (
    <ul className="space-y-1 text-sm" data-testid="journal">
      {entries.map((e) => (
        <li key={e.id} className="border-t border-zinc-800 pt-1 text-zinc-300">
          <span className="text-xs text-zinc-500">{dateTimeText(e.at)}</span> {e.note}
        </li>
      ))}
    </ul>
  );
}

function Ready({ props, snap }: { props: DeskViewProps; snap: DeskSnapshot }) {
  const unavailable = snap.decision.action === "DATA_UNAVAILABLE" || snap.decision.action === "UNKNOWN";
  return (
    <>
      {unavailable ? (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200" role="alert" data-testid="data-unavailable">
          <strong>Data unavailable.</strong> {snap.decision.reason}. No decision is made, no contract is chosen and the ticket stays off. Nothing here is a guess.
        </div>
      ) : null}
      {!snap.store.available ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200" data-testid="store-warning">{snap.store.error}</div>
      ) : null}
      <section className={card} aria-labelledby="readings-h">
        <h2 id="readings-h" className={h2}>Four readings (period to date, SPY)</h2>
        <ReadingsTable readings={snap.readings} />
        <p className="mt-2 text-xs text-zinc-500">Net volume is the chart definition: the period&apos;s total daily volume, signed by the latest close versus the previous period&apos;s last close. A reading counts only when candle colour and net volume match.</p>
      </section>
      <section className={card} aria-labelledby="decision-h">
        <h2 id="decision-h" className={h2}>Decision ({snap.readings.find((r) => r.isDecision)?.name ?? snap.timeframe} timeframe)</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={snap.decision.action === "CALL" ? "green" : snap.decision.action === "PUT" ? "red" : snap.decision.action === "STAND_ASIDE" ? "amber" : "rose"}>{decisionHeadline(snap.decision.action)}</Badge>
        </div>
        <p className="mt-2 text-sm text-zinc-300" data-testid="decision-reason">{snap.decision.reason}</p>
      </section>
      <section className={card} aria-labelledby="pick-h">
        <h2 id="pick-h" className={h2}>Contract the engine would pick (preview, nothing is saved)</h2>
        <EnginePick pick={snap.enginePick} rules={snap.rules} />
      </section>
      <section className={card} aria-labelledby="pos-h">
        <h2 id="pos-h" className={h2}>Dry-run position</h2>
        <PositionCard props={props} snap={snap} />
      </section>
      <section className={card} aria-labelledby="ticket-h">
        <h2 id="ticket-h" className={h2}>Manual SPY option ticket (dry run)</h2>
        <TicketCard props={props} snap={snap} />
      </section>
      <section className={card} aria-labelledby="journal-h">
        <h2 id="journal-h" className={h2}>Manual journal</h2>
        <Journal entries={snap.journal} />
      </section>
      {snap.notes.length > 0 ? (
        <section className={card}>
          <h2 className={h2}>Notes</h2>
          <ul className="list-disc pl-5 text-sm text-amber-200">{snap.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      ) : null}
      <details className={card}>
        <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-zinc-400">Engine log (this preview)</summary>
        <ul className="mt-2 space-y-1 text-xs text-zinc-400">{snap.events.map((e, i) => <li key={`${e.at}-${i}`}><span className="text-zinc-500">[{e.kind}]</span> {e.message}</li>)}</ul>
      </details>
      <p className="text-xs text-zinc-500">
        Rules: nearest listed expiry of at least {snap.rules.minDays} days; |delta| at least {snap.rules.primary.toFixed(2)}, otherwise the cheapest usable contract down to a hard floor of {snap.rules.floor.toFixed(2)} (marked {snap.rules.fallbackLabel}). Calls on Drive, puts on Reverse, the trader decides on Neutral. Dry run: this page can never send an order.
      </p>
    </>
  );
}

export default function SpyDeskView(props: DeskViewProps) {
  const { load } = props;
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6 text-zinc-100" data-testid="spy-desk">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">SPY desk</h1>
          <p className="text-sm text-zinc-400">Long-timeframe SPY options. Read-only market data; manual actions change the dry-run record only.</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone="amber">DRY RUN: no orders can be sent</Badge>
          <button type="button" className={`${btn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`} disabled={props.busy} onClick={props.onRefresh} data-testid="refresh">
            {props.busy ? "Working..." : "Refresh"}
          </button>
        </div>
      </header>
      {props.notice ? (
        <div role="status" className={`rounded-lg border p-3 text-sm ${props.notice.kind === "ok" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-rose-500/40 bg-rose-500/10 text-rose-200"}`} data-testid="notice">
          {props.notice.text}
        </div>
      ) : null}
      {load.status === "loading" ? <p className="text-sm text-zinc-400" data-testid="loading">Loading SPY data...</p> : null}
      {load.status === "error" ? (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200" role="alert" data-testid="load-error">
          <strong>Data unavailable.</strong> {load.error}
        </div>
      ) : null}
      {load.status === "ready" ? (
        <>
          <p className="text-xs text-zinc-500">Data as of {dateTimeText(load.snapshot.generatedAt)}{load.snapshot.spot ? `; SPY last trade ${price(load.snapshot.spot.price)} at ${dateTimeText(load.snapshot.spot.at)} (${load.snapshot.spot.feed})` : "; SPY price unavailable"}.</p>
          <Ready props={props} snap={load.snapshot} />
        </>
      ) : null}
    </div>
  );
}
