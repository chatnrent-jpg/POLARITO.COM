import { daysBetween, type OptionType } from "../../src/lib/broker/options";
import { tradingDaysBetween } from "../../src/lib/marketCalendar";
import { bsDelta, bsPrice, eligibleContracts, pickDeepItm, type ChainRow } from "../../src/lib/optionsSelect";
import type { Bar } from "../../src/lib/polarity";
import type { DeskDeps } from "../../src/lib/spyDesk";
import type { SideReport } from "../../src/lib/spyChain";

export const SPOT = 690;
export const TODAY = "2026-11-03";
export const T0 = new Date("2026-11-03T21:30:00Z");
export const LISTED = ["2027-06-17", "2027-11-05", "2027-11-19", "2028-01-21"];
export const CALL_STRIKES = [550, 600, 640, 670, 690];
export const PUT_STRIKES = [690, 800, 850, 900, 1000];

const occ = (exp: string, type: OptionType, strike: number) => `SPY${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${type === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;

export function row(type: OptionType, exp: string, strike: number, today = TODAY): ChainRow {
  const years = daysBetween(today, exp) / 365;
  const mid = bsPrice(type, SPOT, strike, years, 0.25);
  const ask = Number((mid * 1.002).toFixed(2));
  const bid = Number((mid * 0.998).toFixed(2));
  return {
    symbol: occ(exp, type, strike), type, strike, expiration: exp, bid, ask, mid, spreadPct: (ask - bid) / mid, quoteAt: `${today}T20:00:00Z`,
    delta: bsDelta(type, SPOT, strike, years, 0.25), deltaSource: "black-scholes", iv: 0.25, ivSource: "solved",
    costAtAsk: ask * 100, costAtMid: mid * 100, intrinsicPerShare: 0, extrinsicPerShare: 0,
  };
}

export function side(type: OptionType, strikes?: number[], listed: string[] = LISTED, error: string | null = null): SideReport {
  const ks = strikes ?? (type === "call" ? CALL_STRIKES : PUT_STRIKES);
  const rows: ChainRow[] = [];
  for (const exp of listed) for (const k of ks) rows.push(row(type, exp, k));
  const pick = pickDeepItm(rows, listed, type, TODAY);
  const eligible = eligibleContracts(rows, listed, type, TODAY).rows;
  return { type, listedExpirations: listed, pick, ladder: [], eligible, highestAbsDelta: null, window: { low: 0, high: 0 }, strikesRead: { count: rows.length, min: null, max: null }, later: [], rowsBuilt: rows.length, rejected: {}, error };
}

type Day = { open: number; close: number; volume: number };
export type Scenario = { daily: Bar[] };

/** Calm history to 2026-10-30 (every close 100 = the previous month's last close), then 2026-11-02 and 2026-11-03 as given. */
function bars(nov: [Day, Day]): Scenario {
  const daily: Bar[] = tradingDaysBetween("2025-11-03", "2026-10-30").map((date) => ({ date, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
  const mk = (date: string, d: Day): Bar => ({ date, open: d.open, close: d.close, volume: d.volume, high: Math.max(d.open, d.close) + 0.1, low: Math.min(d.open, d.close) - 0.1 });
  daily.push(mk("2026-11-02", nov[0]), mk("2026-11-03", nov[1]));
  return { daily };
}
export const DRIVE = bars([{ open: 100, close: 101, volume: 100 }, { open: 101, close: 103, volume: 100 }]);
export const REVERSE = bars([{ open: 100, close: 98, volume: 100 }, { open: 98, close: 95, volume: 100 }]);
export const NEUTRAL = bars([{ open: 95, close: 96, volume: 300 }, { open: 96, close: 99, volume: 100 }]);

export type Calls = { daily: number; spot: number; sides: OptionType[]; held: number };
export type DepOpts = { now?: Date; calls?: Calls; dailyFails?: boolean; spotFails?: boolean; heldQuote?: boolean; putStrikes?: number[]; callStrikes?: number[]; sideError?: string };

export function makeDeps(sc: Scenario, o: DepOpts = {}): DeskDeps {
  const now = o.now ?? T0;
  const calls = o.calls ?? { daily: 0, spot: 0, sides: [], held: 0 };
  return {
    now: () => now,
    loadDaily: async () => { calls.daily++; return o.dailyFails ? { ok: false, code: "NETWORK", error: "bars down" } : { ok: true, value: sc.daily }; },
    readSpot: async () => { calls.spot++; return o.spotFails ? { ok: false, code: "NETWORK", error: "spot down" } : { ok: true, value: { price: SPOT, at: now.toISOString(), feed: "iex" } }; },
    readSide: async (type) => { calls.sides.push(type); return side(type, type === "call" ? o.callStrikes : o.putStrikes, LISTED, o.sideError ?? null); },
    readHeld: async (p) => { calls.held++; return o.heldQuote === false ? null : row(p.type, p.expiration, p.strike); },
  };
}
