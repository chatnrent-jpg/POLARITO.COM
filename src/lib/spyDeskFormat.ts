/** Display formatting for the SPY desk. Pure text helpers; no data fetching and no decisions. */

export const money = (n: number): string => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
export const price = (n: number | null): string => (n === null ? "n/a" : n.toFixed(2));
export const percent = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** The raw signed net volume in full shares, so it can be compared with the chart. */
export function netVolumeText(n: number | null): string {
  if (n === null) return "n/a";
  return `${n > 0 ? "+" : ""}${Math.round(n).toLocaleString("en-US")}`;
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
