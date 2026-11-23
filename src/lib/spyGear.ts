/**
 * The "gear" of the SPY desk and the one rule that hangs on it, shared by the browser (to show the check at once) and by
 * the server (which recomputes the gear itself and never trusts the browser): the decision timeframe's polarity reading (Daily by default, Monthly when selected) decides which
 * side a MANUAL ticket may open.
 *
 *   Drive    only a Call may be opened; a Put is blocked
 *   Reverse  only a Put may be opened; a Call is blocked
 *   Neutral  no new position at all: both sides are blocked (the market goes nowhere on Neutral)
 *
 * Pure: no I/O, no clock, no imports from the desk logic (the desk imports this file). Applies to opening only: Close is
 * never gated by the gear, so a held position can always be closed, on Neutral too.
 */
import type { OptionType } from "@/lib/broker/options";

export const TICKER = "SPY";
export type Gear = "DRIVE" | "NEUTRAL" | "REVERSE";

export const GEARS: readonly Gear[] = ["DRIVE", "NEUTRAL", "REVERSE"];
export const GEAR_NAMES: Record<Gear, string> = { DRIVE: "Drive", NEUTRAL: "Neutral", REVERSE: "Reverse" };
export const isGear = (v: unknown): v is Gear => v === "DRIVE" || v === "NEUTRAL" || v === "REVERSE";

/** The engine's decision action as a gear; anything else (data unavailable, unknown) is no gear at all. */
export function gearFromAction(action: unknown): Gear | null {
  return action === "CALL" ? "DRIVE" : action === "PUT" ? "REVERSE" : action === "STAND_ASIDE" ? "NEUTRAL" : null;
}

export type SideCheck = { allowed: boolean; message: string };

const SIDE_NAME: Record<OptionType, string> = { call: "Call", put: "Put" };

export function checkSide(gear: Gear, type: OptionType): SideCheck {
  const side = SIDE_NAME[type];
  if (gear === "NEUTRAL") return { allowed: false, message: `${side} is blocked: the gear is Neutral, so no new position can be opened (the market goes nowhere on Neutral). Closing a held position still works. This holds until the gear changes.` };
  const only: OptionType = gear === "DRIVE" ? "call" : "put";
  if (type === only) return { allowed: true, message: `${side} is allowed: it is the ${GEAR_NAMES[gear]} side.` };
  return {
    allowed: false,
    message: `${side} is blocked: the gear is ${GEAR_NAMES[gear]}, so only a ${SIDE_NAME[only]} can be opened. This holds until the gear changes.`,
  };
}

/** Both sides at once, as the Analyze answer carries them. */
export const allowedSides = (gear: Gear): { call: boolean; put: boolean } => ({ call: checkSide(gear, "call").allowed, put: checkSide(gear, "put").allowed });
