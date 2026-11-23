import type { ReactNode } from "react";
import type { OptionType } from "@/lib/broker/options";
import type { CandidateList, ContractView, DeskSnapshot, ReadingView } from "@/lib/spyDesk";
import { MANUAL_BELOW_TARGET_LABEL, entryMode, sourceMode } from "@/lib/spyDesk";
import type { AutoLogEntry } from "@/lib/spyAutoTypes";
import type { Freshness } from "@/lib/spyDeskData";
import { gearPermit, type AnalyzerState } from "@/lib/spyAnalyzer";
import { GEAR_NAMES, TICKER, checkSide } from "@/lib/spyGear";
import { MONTHLY_PROFILE, type DeskProfile } from "@/lib/spyProfile";
import { clockText, dateTimeText, netVolumeWord, readingWhy, signedMoney, signedPercent, volumeText, decisionHeadline, money, netFlagText, netVolumeText, percent, price, signedDelta } from "@/lib/spyDeskFormat";

/**
 * Pure rendering of the SPY desk. No fetching, no decisions, no storage: it draws exactly what it is given and calls the
 * handlers it is handed. Everything here is DRY RUN: the ticket and Close change a saved record, never a broker account.
 */

export type DeskLoad = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; snapshot: DeskSnapshot };
export type TicketUi = { type: OptionType; symbol: string | null; ack: boolean };
export type CloseUi = { stage: "idle" | "confirm"; ack: boolean; offerUnpriced: boolean };
export type AutoUi = { ack: boolean };
export type Notice = { kind: "ok" | "error"; text: string };

export type DeskViewProps = {
  /** Which desk is drawn (title, timeframe label). Default: the monthly desk. */
  profile?: DeskProfile;
  load: DeskLoad;
  busy: boolean;
  notice: Notice | null;
  ticket: TicketUi;
  close: CloseUi;
  autoUi: AutoUi;
  /** How fresh the data on screen is (the refresh machinery lives in the container; this only draws it). */
  fresh: Freshness;
  /** The Analyze (gear) state for the ticket; the logic lives in spyAnalyzer.ts. */
  analyzer: AnalyzerState;
  onAnalyze(): void;
  onRefresh(): void;
  onAutoChange(next: Partial<AutoUi>): void;
  onSubmitAuto(on: boolean): void;
  onTicketChange(next: Partial<TicketUi>): void;
  onSubmitTicket(): void;
  onCloseChange(next: Partial<CloseUi>): void;
  onSubmitClose(unpriced: boolean): void;
  /** The open/closed state of the "Audit log, manual ticket, journal and engine log" pocket. It lives in the container (like form state) so no refresh or re-render resets it. Absent: the pocket is closed and the browser keeps its own state. */
  pocket?: { open: boolean };
  onPocketChange?(open: boolean): void;
  /** The open/closed state of the "Four readings (period to date)" pocket. Same rule as the pocket above: it lives in the container, so no refresh resets it. Absent: closed, and the browser keeps its own state. */
  readingsPocket?: { open: boolean };
  onReadingsPocketChange?(open: boolean): void;
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

const readingTone = (label: string): "green" | "red" | "zinc" | "rose" => (label === "Drive" ? "green" : label === "Reverse" ? "red" : label === "Neutral" ? "zinc" : "rose");
const candleClass = (c: ReadingView["candle"]): string => (c === "green" ? "text-emerald-300" : c === "red" ? "text-red-300" : "text-zinc-300");

/** The resulting gear as a bold badge: the word is always there, the colour only backs it up. */
function GearBadge({ label, size = "md" }: { label: string; size?: "md" | "lg" }) {
  const tones = {
    green: "bg-emerald-500/20 text-emerald-200 ring-emerald-400",
    red: "bg-red-500/20 text-red-200 ring-red-400",
    zinc: "bg-zinc-600/30 text-zinc-100 ring-zinc-400",
    rose: "bg-rose-500/20 text-rose-200 ring-rose-400",
  } as const;
  return (
    <span className={`inline-block rounded-md px-3 py-1 font-extrabold uppercase tracking-wide ring-2 ${size === "lg" ? "text-xl" : "text-sm"} ${tones[readingTone(label)]}`} data-testid="gear-badge" data-gear={label}>
      {label}
    </span>
  );
}

function readingFrame(decides: boolean): string {
  return decides ? "border-2 border-sky-400 bg-zinc-900 ring-2 ring-sky-400/20" : "border border-zinc-800 bg-zinc-950/40";
}
function DecidesTag({ testid }: { testid: string }) {
  return <span className="rounded bg-sky-400 px-2 py-0.5 text-xs font-extrabold uppercase tracking-wide text-sky-950" data-testid={testid}>decides</span>;
}

function ReadingCard({ r }: { r: ReadingView }) {
  const dim = "text-zinc-400";
  const val = r.isDecision ? "text-zinc-50" : "text-zinc-200";
  const word = netVolumeWord(r.netVolume);
  const netClass = word === "positive" ? "text-emerald-300" : word === "negative" ? "text-red-300" : "text-zinc-300";
  return (
    <li className={`list-none rounded-lg p-3 ${readingFrame(r.isDecision)}`} data-testid={`reading-${r.timeframe}`} data-decides={r.isDecision ? "true" : "false"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={`text-base font-bold ${r.isDecision ? "text-zinc-50" : "text-zinc-300"}`}>{r.name}</h3>
          {r.isDecision ? <DecidesTag testid={`decides-${r.timeframe}`} /> : null}
        </div>
        <GearBadge label={r.label} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <dt className={`text-xs uppercase tracking-wide ${dim}`}>Candle (open to close)</dt>
          <dd className="mt-0.5 break-words text-sm font-semibold">
            {r.status === "ok" ? <span className={candleClass(r.candle)}>{r.candle} ({price(r.open)} to {price(r.close)})</span> : <span className="text-zinc-400">n/a</span>}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className={`text-xs uppercase tracking-wide ${dim}`}>Previous period close</dt>
          <dd className={`mt-0.5 text-sm font-semibold ${val}`}>{r.status === "ok" ? price(r.previousClose) : "n/a"}</dd>
        </div>
        <div className="min-w-0">
          <dt className={`text-xs uppercase tracking-wide ${dim}`}>Raw net volume</dt>
          <dd className={`mt-0.5 text-sm font-semibold ${netClass}`} data-testid={`net-${r.timeframe}`}>
            <span className="font-mono">{netVolumeText(r.netVolume)}</span> {r.netVolume === null ? null : <span>({word})</span>}
            {r.netFlag ? <div className="text-xs font-semibold text-amber-300">[{netFlagText(r.netFlag)}]</div> : null}
          </dd>
        </div>
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <dt className={`text-xs uppercase tracking-wide ${dim}`}>Match</dt>
          <dd className={`mt-0.5 text-sm font-semibold ${r.match === "disagree" ? "text-amber-300" : val}`}>{r.match === "agree" ? "agree" : r.match === "disagree" ? "disagree" : "n/a"}</dd>
        </div>
      </dl>
      {r.status === "unavailable" && r.reason ? <p className="mt-2 text-sm text-rose-300">{r.reason}</p> : null}
      <p className="mt-2 text-xs text-zinc-400">{r.timeframe === "1D" ? "session" : "since"} {r.periodStart ?? "n/a"}, as of {dateTimeText(r.asOf)}</p>
      {r.status === "ok" && r.inProgress ? <p className="mt-1 text-xs font-semibold text-amber-300" data-testid={`in-progress-${r.timeframe}`}>session in progress: includes today&apos;s partial day, can change until the close</p> : null}
    </li>
  );
}

function ReadingsTable({ readings }: { readings: ReadingView[] }) {
  if (readings.length === 0) {
    return <p className="text-sm text-rose-300">Data unavailable: no reading could be computed. Nothing is assumed.</p>;
  }
  return (
    <ul className="grid grid-cols-1 gap-3" data-testid="readings-list">
      {readings.map((r) => <ReadingCard key={r.timeframe} r={r} />)}
    </ul>
  );
}

const waveTone = (d: "up" | "down"): string => (d === "up" ? "text-emerald-300" : "text-red-300");

/** The daily WWV reading: wave direction, wave volume so far, previous wave volume, candle colour and the bar it is based on. */
function WwvTable({ readings }: { readings: ReadingView[] }) {
  const r = readings.find((x) => x.timeframe === "D");
  if (!r) return <p className="text-sm text-rose-300">Data unavailable: no reading could be computed. Nothing is assumed.</p>;
  const w = r.status === "ok" ? r.wwv : null;
  const label = "text-xs uppercase tracking-wide text-zinc-400";
  return (
    <div className="rounded-lg border-2 border-sky-400 bg-zinc-900 p-3 ring-2 ring-sky-400/20" data-testid="wwv-table">
      <div data-testid="reading-D" data-decides="true">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-zinc-50">{r.name}</h3>
            <DecidesTag testid="decides-D" />
          </div>
          <GearBadge label={r.label} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <div className="min-w-0" data-testid="wwv-direction">
            <dt className={label}>Current wave</dt>
            <dd className="mt-0.5 text-sm font-semibold">
              {w ? (
                <>
                  <span className={waveTone(w.direction)}>{w.direction === "up" ? "UP wave" : "DOWN wave"}</span>
                  <div className="text-xs font-normal text-zinc-400">{w.waveBars} {w.waveBars === 1 ? "bar" : "bars"}, since {w.waveStart}</div>
                </>
              ) : (
                <span className="text-zinc-400">n/a</span>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className={label}>Wave volume so far</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold text-zinc-50" data-testid="wwv-volume">{w ? volumeText(w.waveVolume) : "n/a"}</dd>
          </div>
          <div className="min-w-0">
            <dt className={label}>Previous wave volume</dt>
            <dd className="mt-0.5 text-sm font-semibold" data-testid="wwv-previous">
              {w?.previous ? (
                <>
                  <span className={`font-mono ${waveTone(w.previous.direction)}`}>{volumeText(w.previous.volume)}</span>
                  <div className="text-xs font-normal text-zinc-400">{w.previous.direction} wave, {w.previous.start} to {w.previous.end}</div>
                </>
              ) : (
                <span className="text-xs font-normal text-zinc-400">{w ? (w.previousNote ?? "n/a") : "n/a"}</span>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className={label}>Latest daily candle</dt>
            <dd className="mt-0.5 break-words text-sm font-semibold" data-testid="wwv-candle">
              {r.status === "ok" ? <span className={candleClass(r.candle)}>{r.candle} ({price(r.open)} to {price(r.close)})</span> : <span className="text-zinc-400">n/a</span>}
            </dd>
          </div>
          <div className="col-span-2 min-w-0 sm:col-span-4">
            <dt className={label}>Match</dt>
            <dd className={`mt-0.5 text-sm font-semibold ${r.match === "disagree" ? "text-amber-300" : "text-zinc-50"}`}>{r.match === "agree" ? "agree" : r.match === "disagree" ? "disagree" : "n/a"}</dd>
          </div>
        </dl>
        {r.reason ? <p className={`mt-2 text-sm ${r.status === "ok" ? "text-amber-300" : "text-rose-300"}`}>{r.reason}</p> : null}
        <p className="mt-2 text-xs text-zinc-400" data-testid="wwv-asof">
          {w ? `daily bar ${w.barDate}${w.inProgress ? " (session in progress, can still change)" : " (final)"}, ` : ""}as of {dateTimeText(r.asOf)}
        </p>
      </div>
    </div>
  );
}

function ContractLine({ c }: { c: ContractView }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
      <div className="col-span-2 sm:col-span-1"><dt className="text-xs text-zinc-400">Contract</dt><dd className="break-all font-mono">{c.symbol}</dd></div>
      <div><dt className="text-xs text-zinc-400">Strike / expiry</dt><dd>{c.strike} / {c.expiration} ({c.daysToExpiry} days)</dd></div>
      <div><dt className="text-xs text-zinc-400">Delta</dt><dd>{signedDelta(c.delta)} ({c.deltaSource})</dd></div>
      <div><dt className="text-xs text-zinc-400">Bid / ask</dt><dd>{price(c.bid)} / {price(c.ask)} (spread {percent(c.spreadPct)})</dd></div>
      <div><dt className="text-xs text-zinc-400">Cost per contract (ask x 100)</dt><dd className="font-semibold">{money(c.costAtAsk)}</dd></div>
      <div><dt className="text-xs text-zinc-400">Quote time</dt><dd>{dateTimeText(c.quoteAt)}</dd></div>
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

const gridLabel = "text-xs font-medium uppercase tracking-wide text-zinc-400";
const gridValue = "mt-0.5 text-base font-semibold text-zinc-50";

/** The Close (dry run) button and its confirm box. Its state lives in the container, so a refresh never resets an open box. */
function CloseControls({ props }: { props: DeskViewProps }) {
  const { close } = props;
  if (close.stage === "idle") {
    return (
      <button type="button" className={`${btn} w-full rounded-lg bg-amber-500 px-5 py-3 text-base font-bold text-black hover:bg-amber-400 sm:w-auto`} disabled={props.busy} onClick={() => props.onCloseChange({ stage: "confirm", ack: false })} data-testid="close-start">
        Close (dry run)
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-amber-500/60 bg-zinc-950/70 p-3" data-testid="close-confirm">
      <label className="flex items-start gap-2 text-sm text-zinc-100">
        <input type="checkbox" checked={close.ack} onChange={(e) => props.onCloseChange({ ack: e.target.checked })} className="mt-1" data-testid="close-ack" />
        <span>I understand this only closes the dry-run record. No order is sent to any broker.</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${btn} bg-amber-500 text-black hover:bg-amber-400`} disabled={props.busy || !close.ack} onClick={() => props.onSubmitClose(false)} data-testid="close-submit">
          Close at the current bid (dry run)
        </button>
        {close.offerUnpriced ? (
          <button type="button" className={`${btn} bg-zinc-700 text-zinc-100 hover:bg-zinc-600`} disabled={props.busy || !close.ack} onClick={() => props.onSubmitClose(true)} data-testid="close-unpriced">
            Close without a price (result unknown)
          </button>
        ) : null}
        <button type="button" className={`${btn} text-zinc-200 hover:text-white`} disabled={props.busy} onClick={() => props.onCloseChange({ stage: "idle", ack: false, offerUnpriced: false })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type HeldPosition = Extract<DeskSnapshot["position"], { status: "held" }>;

/** The result if closed at the bid: the largest thing on the card. Sign and word as well as colour, so it never relies on colour alone. */
function PositionResult({ pos }: { pos: HeldPosition }) {
  if (!pos.quote) {
    return (
      <div data-testid="position-pnl" data-state="unknown">
        <div className="text-4xl font-extrabold leading-tight text-zinc-300 sm:text-5xl">Result unknown</div>
        <div className="mt-1 text-sm text-zinc-300">No usable quote right now, so there is no result if closed at the bid.</div>
      </div>
    );
  }
  const pnl = pos.quote.pnlUsd;
  const state = pnl > 0 ? "gain" : pnl < 0 ? "loss" : "even";
  const tone = state === "gain" ? "text-emerald-300" : state === "loss" ? "text-red-300" : "text-zinc-100";
  const pct = pos.costUsd > 0 ? (pnl / pos.costUsd) * 100 : null;
  return (
    <div data-testid="position-pnl" data-state={state}>
      <div className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 font-extrabold leading-tight ${tone}`}>
        <span className="text-4xl sm:text-6xl" data-testid="pnl-usd">{signedMoney(pnl)}</span>
        <span className="text-2xl sm:text-4xl" data-testid="pnl-pct">{pct === null ? "n/a" : signedPercent(pct)}</span>
        <span className="text-base font-bold uppercase tracking-wide sm:text-lg" data-testid="pnl-word">{state === "gain" ? "gain" : state === "loss" ? "loss" : "break-even"}</span>
      </div>
      <div className="mt-1 text-sm font-medium text-zinc-200">if closed at the bid ({price(pos.quote.bid)}), as % of the {money(pos.costUsd)} entry cost</div>
    </div>
  );
}

/** The open dry-run position, first thing on the page: bordered, accented, with the result as the largest element and Close right under it. */
function PositionHero({ props, pos }: { props: DeskViewProps; pos: HeldPosition }) {
  return (
    <section className="rounded-xl border-2 border-sky-400 bg-zinc-900 p-4 shadow-lg shadow-sky-950/50 ring-4 ring-sky-400/20 sm:p-6" aria-labelledby="pos-h" data-testid="position-held">
      <div className="-mx-4 -mt-4 mb-4 rounded-t-[10px] bg-sky-400 px-4 py-1.5 text-sm font-extrabold uppercase tracking-widest text-sky-950 sm:-mx-6 sm:-mt-6 sm:px-6">
        <h2 id="pos-h">Open dry-run position</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-lg px-4 py-1 text-2xl font-extrabold tracking-wide ring-2 ${pos.type === "call" ? "bg-emerald-500/20 text-emerald-200 ring-emerald-400" : "bg-red-500/20 text-red-200 ring-red-400"}`} data-testid="position-side">
          {pos.type.toUpperCase()}
        </span>
        <Badge tone={pos.source === "auto" ? "green" : "zinc"}>{sourceMode(pos.source)}</Badge>
        <Badge tone="amber">DRY RUN</Badge>
        {pos.belowTargetLabel ? <Badge tone="amber">{pos.belowTargetLabel}</Badge> : null}
      </div>
      <div className="mt-4 rounded-lg bg-zinc-950/70 p-4">
        <PositionResult pos={pos} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3" data-testid="position-grid">
        <div className="col-span-2 sm:col-span-1"><dt className={gridLabel}>Contract</dt><dd className={`${gridValue} break-all font-mono`}>{pos.symbol}</dd></div>
        <div><dt className={gridLabel}>Strike / expiry</dt><dd className={gridValue}>{pos.strike} / {pos.expiration}</dd></div>
        <div><dt className={gridLabel}>Entry (ask) / delta</dt><dd className={gridValue}>{price(pos.entryAsk)} / {signedDelta(pos.entryDelta)}</dd></div>
        <div><dt className={gridLabel}>Entry cost / max loss</dt><dd className={gridValue}>{money(pos.costUsd)}</dd></div>
        <div>
          <dt className={gridLabel}>Now (bid / ask)</dt>
          <dd className={gridValue}>{pos.quote ? `${price(pos.quote.bid)} / ${price(pos.quote.ask)}` : "no usable quote right now"}</dd>
        </div>
        <div>
          <dt className={gridLabel}>Quote time</dt>
          <dd className={gridValue} data-testid="quote-time">{pos.quote ? `quote made ${dateTimeText(pos.quote.quoteAt)}` : "n/a"}</dd>
        </div>
      </dl>
      <div className="mt-5" data-testid="position-close">
        <CloseControls props={props} />
      </div>
    </section>
  );
}

function PositionCard({ snap }: { snap: DeskSnapshot }) {
  const pos = snap.position;
  if (pos.status === "unknown") {
    return <p className="text-sm text-rose-300" data-testid="position-unknown">Dry-run position unknown: {pos.reason} Nothing is assumed, so Close and the ticket are off.</p>;
  }
  return <p className="text-sm text-zinc-400" data-testid="position-none">No dry-run position held.</p>;
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

function GearCard({ props, snap }: { props: DeskViewProps; snap: DeskSnapshot }) {
  const { analyzer } = props;
  const a = analyzer.analysis;
  const permit = gearPermit({ analyzer, liveAction: snap.decision.action, liveFreshness: props.fresh.state });
  return (
    <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-950/60 p-3" data-testid="analyze-card">
      <p className="text-xs text-zinc-400">Analyze loads the daily bars and the gear for this ticker, and the order below uses it.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-zinc-300">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">Ticker</span>
          <input type="text" value={TICKER} readOnly aria-readonly="true" className="w-24 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-zinc-200" data-testid="ticker-input" />
        </label>
        <button type="button" className={`${btn} bg-sky-600 text-white hover:bg-sky-500`} disabled={props.busy || analyzer.status === "loading"} onClick={props.onAnalyze} data-testid="analyze-button">
          {analyzer.status === "loading" ? "Analyzing..." : "Analyze"}
        </button>
      </div>
      {a ? (
        <div className="text-sm" data-testid="gear-card" data-gear={a.gear}>
          <div>
            Gear: <strong data-testid="gear-name">{GEAR_NAMES[a.gear]}</strong> <Badge tone={a.gear === "DRIVE" ? "green" : a.gear === "REVERSE" ? "red" : "amber"}>{a.gear === "DRIVE" ? "CALL only" : a.gear === "REVERSE" ? "PUT only" : "trader decides"}</Badge>
          </div>
          <div className="text-zinc-300" data-testid="gear-netvol">
            {a.reading.wwv
              ? `${a.timeframeName}: ${a.reading.wwv.direction}-wave volume ${volumeText(a.reading.wwv.waveVolume)} shares since ${a.reading.wwv.waveStart}, candle ${a.reading.candle ?? "n/a"}, daily bar ${a.reading.wwv.barDate}${a.reading.wwv.inProgress ? " (in progress)" : ""}, ${a.bars} daily bars`
              : `${a.timeframeName} net volume ${netVolumeText(a.reading.netVolume)} shares (raw)${a.reading.inProgress ? ", session in progress" : ""}, ${a.bars} daily bars`}
          </div>
          <div className="text-xs text-zinc-500" data-testid="gear-asof">
            as of {dateTimeText(a.reading.asOf)}, analyzed {clockText(a.generatedAt)}
          </div>
        </div>
      ) : null}
      {analyzer.gearChange ? (
        <p className="text-sm text-amber-300" role="alert" data-testid="gear-warning">
          WARNING: the gear changed from {GEAR_NAMES[analyzer.gearChange.from]} to {GEAR_NAMES[analyzer.gearChange.to]} at {clockText(analyzer.gearChange.at)}. The gear was loaded again and the side is checked again. The acknowledgement was cleared.
        </p>
      ) : null}
      {analyzer.status === "error" ? (
        <p className="text-sm text-rose-300" role="alert" data-testid="gear-error">
          {analyzer.error}
        </p>
      ) : null}
      {!permit.ready ? (
        <p className="text-sm text-zinc-300" data-testid="ticket-disabled">
          {permit.message}
        </p>
      ) : null}
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
  const input = { analyzer: props.analyzer, liveAction: snap.decision.action, liveFreshness: props.fresh.state };
  const permit = gearPermit(input);
  const check = permit.ready ? checkSide(permit.gear, ticket.type) : null;
  const usable = permit.ready && check !== null && check.allowed;
  const list = usable ? (ticket.type === "call" ? t.calls : t.puts) : null;
  const chosen = list?.shown.find((c) => c.symbol === ticket.symbol) ?? null;
  return (
    <div className="space-y-3" data-testid="ticket-open">
      <GearCard props={props} snap={snap} />
      <p className="text-sm text-amber-200" data-testid="ticket-intro">
        Select Call or Put. It will be checked against the active gear immediately. Then choose one contract from the rules-filtered chain. This records a MANUAL dry-run position only, labelled MANUAL.
      </p>
      <div className="flex gap-2" role="group" aria-label="Call or put">
        {(["call", "put"] as const).map((ty) => (
          <button key={ty} type="button" disabled={props.busy || !permit.ready} aria-pressed={ticket.type === ty} onClick={() => props.onTicketChange({ type: ty, symbol: null })} className={`${btn} ${ticket.type === ty ? (ty === "call" ? "bg-emerald-600 text-white" : "bg-red-600 text-white") : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`} data-testid={`ticket-type-${ty}`}>
            {ty === "call" ? "Call" : "Put"}
          </button>
        ))}
      </div>
      {check ? (
        <p className={`text-sm ${check.allowed ? "text-emerald-300" : "text-rose-300"}`} role={check.allowed ? undefined : "alert"} data-testid={check.allowed ? "side-ok" : "side-blocked"}>
          {check.message}
        </p>
      ) : null}
      {list ? <CandidateTable list={list} selected={ticket.symbol} onSelect={(symbol) => props.onTicketChange({ symbol })} disabled={props.busy} primary={snap.rules.primary} /> : null}
      {chosen ? (
        <div className="rounded-md border border-zinc-700 bg-zinc-950/60 p-3 text-sm" data-testid="ticket-summary">
          <div className="mb-1 font-semibold">MANUAL, DRY RUN: would buy 1 {chosen.type.toUpperCase()} {chosen.symbol} at the ask {price(chosen.ask)}, cost {money(chosen.costAtAsk)} (max loss = premium).</div>
          {chosen.belowTarget ? <div className="text-amber-300">{MANUAL_BELOW_TARGET_LABEL}: delta {signedDelta(chosen.delta)} is below the {snap.rules.primary.toFixed(2)} target.</div> : null}
          <label className="mt-2 flex items-start gap-2 text-zinc-200">
            <input type="checkbox" checked={ticket.ack} onChange={(e) => props.onTicketChange({ ack: e.target.checked })} className="mt-1" data-testid="ticket-ack" />
            <span>I understand this only records a dry-run position. No order is sent to any broker.</span>
          </label>
          <button type="button" className={`${btn} mt-3 bg-amber-600 text-black hover:bg-amber-500`} disabled={props.busy || !ticket.ack || !usable} onClick={props.onSubmitTicket} data-testid="ticket-submit">
            Record dry-run buy
          </button>
        </div>
      ) : usable ? (
        <p className="text-xs text-zinc-500">Pick a contract to continue.</p>
      ) : null}
    </div>
  );
}

function Journal({ entries }: { entries: DeskSnapshot["journal"] }) {
  if (entries.length === 0) return <p className="text-sm text-zinc-500">No dry-run trades recorded yet.</p>;
  return (
    <ul className="space-y-1 text-sm" data-testid="journal">
      {entries.map((e) => (
        <li key={e.id} className="border-t border-zinc-800 pt-1 text-zinc-300">
          <span className="mr-1"><Badge tone={entryMode(e.kind) === "AUTO" ? "green" : "zinc"}>{entryMode(e.kind)}</Badge></span>
          <span className="text-xs text-zinc-500">{dateTimeText(e.at)}</span> {e.note}
        </li>
      ))}
    </ul>
  );
}

const outcomeTone = (o: AutoLogEntry["outcome"]): "green" | "red" | "amber" | "zinc" | "rose" =>
  o === "opened" || o === "closed-and-opened" || o === "closed" ? "green" : o === "refused" || o === "error" ? "rose" : o === "neutral" || o === "no-action" || o === "off" ? "amber" : "zinc";

function AutoLog({ a }: { a: DeskSnapshot["auto"] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Auto audit log (every decision, newest first)</h3>
      {a.logError ? <p className="text-sm text-rose-300">The audit log could not be read: {a.logError}</p> : null}
      {a.log.length === 0 && !a.logError ? (
        <p className="text-sm text-zinc-500" data-testid="auto-log-empty">No Auto decisions yet.</p>
      ) : (
        <ul className="space-y-1 text-sm" data-testid="auto-log">
          {a.log.map((e) => (
            <li key={e.id} className="border-t border-zinc-800 pt-1 text-zinc-300">
              <span className="mr-1"><Badge tone={outcomeTone(e.outcome)}>{e.outcome.toUpperCase()}</Badge></span>
              <span className="text-xs text-zinc-500">{dateTimeText(e.at)}{e.reading ? `, reading ${e.reading}` : ""}</span> {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Auto switch as a picture: OFF and ON both readable, the current side filled (strong green for ON, quiet grey for OFF). Read-only; the controls below change it. */
function AutoSwitchGraphic({ on }: { on: boolean }) {
  return (
    <span className="inline-flex h-14 w-36 shrink-0 select-none overflow-hidden rounded-full border-2 border-zinc-600 text-base font-extrabold tracking-wide" role="img" aria-label={`Auto switch: ${on ? "ON" : "OFF"}`} data-testid="auto-switch-graphic" data-on={on ? "true" : "false"}>
      <span className={`flex w-1/2 items-center justify-center ${on ? "text-zinc-500" : "bg-zinc-600 text-zinc-100"}`}>OFF</span>
      <span className={`flex w-1/2 items-center justify-center ${on ? "bg-emerald-500 text-emerald-950" : "text-zinc-500"}`}>ON</span>
    </span>
  );
}

function AutoCard({ props, snap, hideLog = false }: { props: DeskViewProps; snap: DeskSnapshot; hideLog?: boolean }) {
  const a = snap.auto;
  const big = "min-h-12 w-full px-6 py-3 text-base font-bold sm:w-auto";
  return (
    <div className="space-y-3" data-testid="auto-card" data-auto={a.on ? "on" : "off"}>
      <div
        role="group"
        aria-labelledby="auto-state"
        className={`flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border-2 p-3 ${a.on ? "border-emerald-400 bg-emerald-500/10" : "border-zinc-700 bg-zinc-950/50"}`}
        data-testid="auto-switch"
      >
        <AutoSwitchGraphic on={a.on} />
        <div className="min-w-0 space-y-1">
          <div id="auto-state" role="status" className={`text-2xl font-extrabold ${a.on ? "text-emerald-300" : "text-zinc-300"}`} data-testid="auto-state">{a.on ? "Auto is ON" : "Auto is OFF"}</div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={a.on ? "green" : "zinc"}>{a.on ? "AUTO ON" : "AUTO OFF"}</Badge>
            <span className="text-xs text-zinc-400">{a.reason}{a.at ? ` Last changed ${dateTimeText(a.at)}.` : ""}</span>
          </div>
        </div>
      </div>
      <p className="text-sm text-zinc-300">
        When ON, a scheduled run ({a.schedule}) opens a call on Drive or a put on Reverse when no position is held, and when the reading turns opposite to a position Auto opened it closes at the bid and opens the other side. Neutral: no action, you decide. It never touches a MANUAL position. Practice record only; no order is ever sent.
      </p>
      {!a.available ? (
        <p className="text-sm text-amber-300" data-testid="auto-unavailable">Auto cannot be switched: {a.reason}</p>
      ) : a.on ? (
        <button type="button" className={`${btn} ${big} border-2 border-zinc-500 bg-zinc-800 text-zinc-50 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400`} disabled={props.busy} onClick={() => props.onSubmitAuto(false)} data-testid="auto-off">
          Turn Auto OFF
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-950/60 p-3">
          <label className="flex min-h-11 items-start gap-3 text-sm text-zinc-200">
            <input type="checkbox" checked={props.autoUi.ack} onChange={(e) => props.onAutoChange({ ack: e.target.checked })} className="mt-1 h-5 w-5 shrink-0" data-testid="auto-ack" />
            <span>I understand Auto only records practice trades by itself. No order is sent to any broker.</span>
          </label>
          <button type="button" className={`${btn} ${big} bg-emerald-500 text-emerald-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400`} disabled={props.busy || !props.autoUi.ack} onClick={() => props.onSubmitAuto(true)} data-testid="auto-on">
            Turn Auto ON
          </button>
        </div>
      )}
      {hideLog ? null : <AutoLog a={a} />}
    </div>
  );
}

type DecisionLook = { big: string; frame: string; bar: string; badge: string; gear: string | null; gearLine: string };
function decisionLook(action: DeskSnapshot["decision"]["action"]): DecisionLook {
  switch (action) {
    case "CALL":
      return { big: "CALL", frame: "border-emerald-400 ring-emerald-400/20", bar: "bg-emerald-400 text-emerald-950", badge: "bg-emerald-500/20 text-emerald-200 ring-emerald-400", gear: "Drive", gearLine: "Calls only." };
    case "PUT":
      return { big: "PUT", frame: "border-red-400 ring-red-400/20", bar: "bg-red-400 text-red-950", badge: "bg-red-500/20 text-red-200 ring-red-400", gear: "Reverse", gearLine: "Puts only." };
    case "STAND_ASIDE":
      return { big: "NEUTRAL", frame: "border-zinc-400 ring-zinc-400/20", bar: "bg-zinc-300 text-zinc-900", badge: "bg-zinc-600/30 text-zinc-100 ring-zinc-400", gear: "Neutral", gearLine: "The trader decides." };
    case "DATA_UNAVAILABLE":
      return { big: "NO DATA", frame: "border-rose-400 ring-rose-400/20", bar: "bg-rose-400 text-rose-950", badge: "bg-rose-500/20 text-rose-200 ring-rose-400", gear: null, gearLine: "No decision is made." };
    default:
      return { big: "UNKNOWN", frame: "border-rose-400 ring-rose-400/20", bar: "bg-rose-400 text-rose-950", badge: "bg-rose-500/20 text-rose-200 ring-rose-400", gear: null, gearLine: "No decision is made." };
  }
}

const pocketHint = (snap: DeskSnapshot): string => {
  const p = snap.position;
  const position = p.status === "held" ? `dry-run position HELD (${p.type.toUpperCase()} ${p.strike})` : p.status === "none" ? "no dry-run position held" : "dry-run position unknown";
  const n = (count: number, what: string) => `${count} ${what} ${count === 1 ? "entry" : "entries"}`;
  return `${n(snap.auto.log.length, "audit")}, ${n(snap.journal.length, "journal")}, ${position}`;
};

/**
 * One collapsible pocket (closed by default) for the secondary parts of the page: the Auto audit log, the manual ticket, the journal,
 * the engine log and the rules line. The decision, readings, position card and Close button stay outside it. Native details/summary, so the
 * keyboard (Tab, Enter, Space) and screen readers work without script. Its open/closed state is owned by the container (props.pocket), so a
 * refresh or re-render never resets it; nothing here ever closes it by itself.
 */
function Pocket({ props, snap, children }: { props: DeskViewProps; snap: DeskSnapshot; children: ReactNode }) {
  const controlled = props.pocket !== undefined;
  return (
    <details
      className="group rounded-lg border-2 border-zinc-700 bg-zinc-900/60"
      data-testid="desk-pocket"
      data-open={controlled ? (props.pocket?.open ? "true" : "false") : undefined}
      {...(controlled ? { open: props.pocket?.open === true } : {})}
      onToggle={(e) => props.onPocketChange?.(e.currentTarget.open)}
    >
      <summary
        className="flex min-h-16 cursor-pointer list-none items-center gap-3 rounded-lg p-4 text-zinc-100 hover:bg-zinc-800/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 [&::-webkit-details-marker]:hidden"
        data-testid="desk-pocket-summary"
      >
        <svg className="h-6 w-6 shrink-0 text-sky-300 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-testid="desk-pocket-chevron">
          <path d="M9 5l7 7-7 7" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-bold">Audit log, manual ticket, journal and engine log</span>
          <span className="block text-sm text-zinc-400" data-testid="desk-pocket-hint">{pocketHint(snap)}</span>
        </span>
        <span className="shrink-0 rounded-md bg-zinc-800 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-200 ring-1 ring-zinc-600">
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <div className="space-y-4 border-t border-zinc-800 p-4" data-testid="desk-pocket-body">{children}</div>
    </details>
  );
}

/** "Monthly Reverse, Quarterly Reverse, 6-month Reverse, Yearly Drive": the four gears in one line, so a closed pocket still says what is inside. */
const readingsHint = (readings: ReadingView[]): string => (readings.length === 0 ? "no reading available" : readings.map((r) => `${r.name} ${r.label}`).join(", "));

/**
 * The second pocket (closed by default): the four period-to-date readings and their net-volume definition. It is its own pocket, never nested
 * in the audit pocket, and the decision and the decider's own reading stay outside it. Native details/summary, so Tab, Enter and Space work
 * without script. Its open/closed state is owned by the container (props.readingsPocket); nothing here ever closes it by itself.
 */
function ReadingsPocket({ props, readings, children }: { props: DeskViewProps; readings: ReadingView[]; children: ReactNode }) {
  const controlled = props.readingsPocket !== undefined;
  return (
    <details
      className="group rounded-lg border-2 border-zinc-700 bg-zinc-900/60"
      data-testid="readings-pocket"
      data-open={controlled ? (props.readingsPocket?.open ? "true" : "false") : undefined}
      {...(controlled ? { open: props.readingsPocket?.open === true } : {})}
      onToggle={(e) => props.onReadingsPocketChange?.(e.currentTarget.open)}
    >
      <summary
        className="flex min-h-16 cursor-pointer list-none items-center gap-3 rounded-lg p-4 text-zinc-100 hover:bg-zinc-800/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 [&::-webkit-details-marker]:hidden"
        data-testid="readings-pocket-summary"
      >
        <svg className="h-6 w-6 shrink-0 text-sky-300 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-testid="readings-pocket-chevron">
          <path d="M9 5l7 7-7 7" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-bold">Four readings (period to date)</span>
          <span className="block text-sm text-zinc-400" data-testid="readings-pocket-hint">{readingsHint(readings)}</span>
        </span>
        <span className="shrink-0 rounded-md bg-zinc-800 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-200 ring-1 ring-zinc-600">
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <div className="space-y-4 border-t border-zinc-800 p-4" data-testid="readings-pocket-body">{children}</div>
    </details>
  );
}

/** The decision, drawn as the page's second hero: the side, the gear, the plain-English why and the contract the engine would pick. */
function DecisionHero({ snap }: { snap: DeskSnapshot }) {
  const d = snap.decision;
  const look = decisionLook(d.action);
  const dec = snap.readings.find((r) => r.isDecision) ?? null;
  const inProgress = dec !== null && dec.status === "ok" && (dec.inProgress || dec.wwv?.inProgress === true);
  return (
    <section className={`rounded-xl border-2 bg-zinc-900 p-4 shadow-lg ring-4 sm:p-6 ${look.frame}`} aria-labelledby="decision-h" data-testid="decision-card" data-action={d.action}>
      <div className={`-mx-4 -mt-4 mb-4 rounded-t-[10px] px-4 py-1.5 text-sm font-extrabold uppercase tracking-widest sm:-mx-6 sm:-mt-6 sm:px-6 ${look.bar}`}>
        <h2 id="decision-h">Decision ({dec?.name ?? snap.timeframe} timeframe)</h2>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className={`rounded-xl px-5 py-1 text-5xl font-black tracking-wide ring-4 sm:text-7xl ${look.badge}`} data-testid="decision-badge">{look.big}</span>
        <div>
          <div className="text-lg font-bold text-zinc-50" data-testid="decision-headline">{decisionHeadline(d.action)}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-200" data-testid="decision-gear">
            {look.gear ? <><span>Gear:</span> <GearBadge label={look.gear} /></> : <span>Gear: unavailable.</span>} <span>{look.gearLine}</span>
          </div>
        </div>
      </div>
      <p className="mt-4 text-base font-medium text-zinc-100" data-testid="decision-why">
        {dec ? readingWhy(dec) : `No trustworthy reading for the ${snap.timeframe} timeframe. Nothing is assumed.`}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-300" data-testid="decision-asof">
        <span>as of {dateTimeText(dec?.asOf ?? null)}</span>
        {inProgress ? <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-200 ring-1 ring-amber-400" data-testid="decision-in-progress">session in progress: can change until the close</span> : null}
      </p>
      <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-950/60 p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Contract the engine would pick (preview, nothing is saved)</h3>
        <EnginePick pick={snap.enginePick} rules={snap.rules} />
      </div>
      <p className="mt-3 text-xs text-zinc-400" data-testid="decision-reason">{d.reason}</p>
    </section>
  );
}

function Ready({ props, snap }: { props: DeskViewProps; snap: DeskSnapshot }) {
  const unavailable = snap.decision.action === "DATA_UNAVAILABLE" || snap.decision.action === "UNKNOWN";
  return (
    <>
      {snap.position.status === "held" ? <PositionHero props={props} pos={snap.position} /> : null}
      <section className={card} aria-labelledby="auto-h">
        <h2 id="auto-h" className={h2}>Auto (practice trader)</h2>
        <AutoCard props={props} snap={snap} hideLog />
      </section>
      <DecisionHero snap={snap} />
      {snap.auto.banner ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200" role="status" data-testid="neutral-banner">
          {snap.auto.banner}
        </div>
      ) : null}
      {unavailable ? (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200" role="alert" data-testid="data-unavailable">
          <strong>Data unavailable.</strong> {snap.decision.reason}. No decision is made, no contract is chosen and the ticket stays off. Nothing here is a guess.
        </div>
      ) : null}
      {!snap.store.available ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200" data-testid="store-warning">{snap.store.error}</div>
      ) : null}
      {snap.timeframe !== "D" && snap.readings.some((r) => r.timeframe === "1D") ? (
        <section className={card} aria-labelledby="daily-h" data-testid="daily-reading">
          <h2 id="daily-h" className={h2}>Daily reading (today, SPY)</h2>
          <ReadingsTable readings={snap.readings.filter((r) => r.timeframe === "1D")} />
          <p className="mt-2 text-xs text-zinc-400">Daily net volume is the same chart definition on one day: the candle is today&apos;s open to the latest close, net volume is today&apos;s total volume signed by the latest close against the previous trading day&apos;s close, and the reading counts only when candle colour and net volume agree. During the session it uses the partial day (labelled session in progress); after the close it is final.</p>
        </section>
      ) : null}
      {snap.timeframe === "D" ? (
        <section className={card} aria-labelledby="readings-h">
          <h2 id="readings-h" className={h2}>Daily Weis Wave Volume (WWV, setting 1, SPY)</h2>
          <WwvTable readings={snap.readings} />
          <p className="mt-2 text-xs text-zinc-500">A wave is a run of daily bars closing the same way against the previous close (an equal close continues the wave); its volume restarts at each turn and the turning bar belongs to the new wave. A reading counts only when the latest candle colour and the current wave agree: green candle with an up wave is Drive, red candle with a down wave is Reverse, otherwise Neutral.</p>
        </section>
      ) : (
        <ReadingsPocket props={props} readings={snap.readings.filter((r) => r.timeframe !== "1D")}>
          <section className={card} aria-labelledby="readings-h">
            <h2 id="readings-h" className={h2}>Four readings (period to date, SPY)</h2>
            <ReadingsTable readings={snap.readings.filter((r) => r.timeframe !== "1D")} />
            <p className="mt-2 text-xs text-zinc-500">Net volume is the chart definition: the period&apos;s total daily volume, signed by the latest close versus the previous period&apos;s last close. A reading counts only when candle colour and net volume match.</p>
          </section>
        </ReadingsPocket>
      )}
      {snap.timeframe === "D" && snap.contextReadings && snap.contextReadings.length > 0 ? (
        <ReadingsPocket props={props} readings={snap.contextReadings}>
          <section className={card} aria-labelledby="context-readings-h" data-testid="context-readings">
            <h2 id="context-readings-h" className={h2}>Four readings (period to date, SPY)</h2>
            <ReadingsTable readings={snap.contextReadings} />
            <p className="mt-2 text-xs text-zinc-500">Net volume is the chart definition: the period&apos;s total daily volume, signed by the latest close versus the previous period&apos;s last close. A reading counts only when candle colour and net volume match. Context only: on this desk the decision is the daily Weis Wave Volume above; these readings do not decide, choose the contract, drive Auto or gate the ticket.</p>
          </section>
        </ReadingsPocket>
      ) : null}
      {snap.position.status !== "held" ? (
        <section className={card} aria-labelledby="pos-h">
          <h2 id="pos-h" className={h2}>Dry-run position</h2>
          <PositionCard snap={snap} />
        </section>
      ) : null}
      {snap.notes.length > 0 ? (
        <section className={card}>
          <h2 className={h2}>Notes</h2>
          <ul className="list-disc pl-5 text-sm text-amber-200">{snap.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      ) : null}
      <Pocket props={props} snap={snap}>
        <section className={card} data-testid="audit-log-section">
          <AutoLog a={snap.auto} />
        </section>
        <section className={card} aria-labelledby="ticket-h">
          <h2 id="ticket-h" className={h2}>Manual SPY option ticket (dry run)</h2>
          <TicketCard props={props} snap={snap} />
        </section>
        <section className={card} aria-labelledby="journal-h">
          <h2 id="journal-h" className={h2}>Trade journal (AUTO and MANUAL)</h2>
          <Journal entries={snap.journal} />
        </section>
        <details className={card}>
          <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-zinc-400">Engine log (this preview)</summary>
          <ul className="mt-2 space-y-1 text-xs text-zinc-400">{snap.events.map((e, i) => <li key={`${e.at}-${i}`}><span className="text-zinc-500">[{e.kind}]</span> {e.message}</li>)}</ul>
        </details>
        <p className="text-xs text-zinc-500" data-testid="rules-footer">
          Rules: nearest listed expiry of at least {snap.rules.minDays} days; |delta| at least {snap.rules.primary.toFixed(2)}, otherwise the cheapest usable contract down to a hard floor of {snap.rules.floor.toFixed(2)} (marked {snap.rules.fallbackLabel}). Calls on Drive, puts on Reverse, the trader decides on Neutral. Dry run: this page can never send an order.
        </p>
      </Pocket>
    </>
  );
}

function FreshnessBar({ fresh, hasData }: { fresh: Freshness; hasData: boolean }) {
  if (!hasData) return null;
  const stamp = clockText(fresh.updatedAt);
  return (
    <div className="space-y-1" data-testid="freshness" data-state={fresh.state}>
      {fresh.state === "stale" ? (
        <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 p-3 text-sm text-rose-200" role="alert" data-testid="refresh-error">
          <strong>Refresh problem, NOT current.</strong> {fresh.lightError ?? "The last update is too old."} The numbers below are from {stamp} and may have changed.
          {fresh.retryInMs !== null ? ` Trying again in about ${Math.max(1, Math.round(fresh.retryInMs / 1000))} s.` : " Trying again."}
        </div>
      ) : fresh.state === "paused" ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200" data-testid="refresh-paused">
          Paused while this tab is hidden. Last update {stamp}. It refreshes again as soon as you come back.
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-emerald-300" data-testid="refresh-live">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
          Live: updated {stamp}
          <span className="text-xs text-zinc-500">(position, Auto, journal and readings every 5 s; the option chain every 45 s, last read {clockText(fresh.chainAt)})</span>
        </p>
      )}
      {fresh.throttled ? <p className="text-xs text-amber-300" data-testid="refresh-throttled">Waiting: the refresh limit per minute is reached, the next update comes shortly.</p> : null}
      {fresh.heavyError ? (
        <p className="text-xs text-amber-300" data-testid="chain-error">Option chain refresh failed ({fresh.heavyError}). The contract list and preview are from {clockText(fresh.chainAt)}.</p>
      ) : fresh.chainUpdating ? (
        <p className="text-xs text-zinc-400" data-testid="chain-updating">Contract preview and ticket list are updating.</p>
      ) : null}
    </div>
  );
}

export default function SpyDeskView(props: DeskViewProps) {
  const { load } = props;
  const profile = props.profile ?? MONTHLY_PROFILE;
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6 text-zinc-100" data-testid="spy-desk" data-profile={profile.id}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold" data-testid="desk-title">
            {profile.title}
            {profile.timeframeLabel ? <Badge tone="zinc">{profile.timeframeLabel}</Badge> : null}
          </h1>
          <p className="text-sm text-zinc-400">{profile.fixedTimeframe === "D" ? "SPY options decided by the daily Weis Wave Volume. Its own practice record, journal, Auto switch and log. " : "Long-timeframe SPY options. "}Read-only market data; Auto and manual actions change the dry-run record only.</p>
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
          <FreshnessBar fresh={props.fresh} hasData />
          <div className={props.fresh.state === "stale" ? "space-y-4 opacity-60" : "space-y-4"} data-testid="desk-body">
            <Ready props={props} snap={load.snapshot} />
          </div>
        </>
      ) : null}
    </div>
  );
}
