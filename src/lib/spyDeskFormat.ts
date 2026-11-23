/** Display formatting for the SPY desk. Pure text helpers; no data fetching and no decisions. */

export const money = (n: number): string => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
export const price = (n: number | null): string => (n === null ? "n/a" : n.toFixed(2));
/** Dollars with the sign always shown ("+$305.00", "-$305.00"; zero is "$0.00"). */
export function signedMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n > 0 ? `+${abs}` : n < 0 ? `-${abs}` : abs;
}

/** A percentage with the sign always shown ("+3.39%", "-3.39%"; zero is "0.00%"). Input is already in percent. */
export function signedPercent(n: number): string {
  const abs = `${Math.abs(n).toFixed(2)}%`;
  return n > 0 ? `+${abs}` : n < 0 ? `-${abs}` : abs;
}

export const percent = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** The raw signed net volume in full shares, so it can be compared with the chart. */
export function netVolumeText(n: number | null): string {
  if (n === null) return "n/a";
  return `${n > 0 ? "+" : ""}${Math.round(n).toLocaleString("en-US")}`;
}

/** A plain share count (no sign), in full. */
export function volumeText(n: number | null): string {
  return n === null ? "n/a" : Math.round(n).toLocaleString("en-US");
}

export function netFlagText(flag: "zero" | "missing" | null): string | null {
  return flag === null ? null : `${flag.toUpperCase()} NET VOLUME: Neutral, no sign guessed`;
}

export function dateTimeText(iso: string | null): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "n/a";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function decisionHeadline(action: string): string {
  switch (action) {
    case "CALL":
      return "CALL (Drive)";
    case "PUT":
      return "PUT (Reverse)";
    case "STAND_ASIDE":
      return "NEUTRAL: TRADER DECIDES";
    case "DATA_UNAVAILABLE":
      return "DATA UNAVAILABLE: no decision";
    default:
      return "NO DECISION";
  }
}

export function signedDelta(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(3)}`;
}

/** Local wall-clock time, HH:MM:SS, for the "updated" stamp. */
export function clockText(iso: string | null): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "n/a";
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** The sign of a net volume in words, so the meaning never rests on colour alone. */
export function netVolumeWord(n: number | null): "positive" | "negative" | "zero" | "missing" {
  return n === null ? "missing" : n > 0 ? "positive" : n < 0 ? "negative" : "zero";
}

export type WhyInput = {
  name: string;
  status: "ok" | "unavailable";
  label: string;
  candle: "green" | "red" | "flat" | null;
  open: number | null;
  close: number | null;
  netVolume: number | null;
  match: "agree" | "disagree" | null;
  reason: string | null;
  wwv: { direction: "up" | "down"; waveVolume: number } | null;
};

/** One plain-English sentence for why a reading says what it says (candle colour against net volume, or against the WWV wave). */
export function readingWhy(r: WhyInput): string {
  if (r.status !== "ok") return `No trustworthy ${r.name} reading${r.reason ? `: ${r.reason}` : ""}. Nothing is assumed.`;
  const verdict = `${r.match === "agree" ? "they agree" : "they do not agree"}, so the reading is ${r.label}.`;
  if (r.wwv) {
    return `The latest daily candle is ${r.candle} (${price(r.open)} to ${price(r.close)}) and the current wave is ${r.wwv.direction.toUpperCase()} (${volumeText(r.wwv.waveVolume)} shares so far): ${verdict}`;
  }
  const word = netVolumeWord(r.netVolume);
  const net = r.netVolume === null ? "missing" : `${netVolumeText(r.netVolume)} (${word})`;
  return `The ${r.name} candle is ${r.candle} (${price(r.open)} to ${price(r.close)}) and its net volume is ${net}: ${verdict}`;
}
