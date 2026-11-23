/**
 * A desk "profile": everything that differs between the two SPY desks, in one small object, so the desk code is shared and
 * nothing is copied. Plain data (safe to hand to a client component), no I/O.
 *
 *   monthly  /spy       decision from the Daily net volume reading by default (SPY_DECISION_TIMEFRAME: 1D default, or M, Q, H, Y period-to-date)
 *   wwv      /spy-wwv   decision from the daily Weis Wave Volume reading (wwv.ts), setting fixed at 1
 *
 * ISOLATION: each desk has its own practice position and journal, Auto switch, audit log and run lock because every key it
 * writes goes through `scopeKey`, which moves the shared key names under the profile's own prefix. The two prefixes can never
 * produce the same key, and a key that does not start with the shared base prefix is refused (never written unscoped).
 */
import type { DeskTimeframe } from "@/lib/deskReadings";
import { AUTO_SCHEDULE_TEXT } from "@/lib/spyAutoTypes";

export type DeskProfileId = "monthly" | "wwv";

export type DeskProfile = Readonly<{
  id: DeskProfileId;
  /** Page heading and browser title. */
  title: string;
  /** Shown next to the title; null for the monthly desk (its timeframe comes from the settings). */
  timeframeLabel: string | null;
  pagePath: string;
  /** API routes live at `${apiBase}/{desk,live,analyze,ticket,close,auto,auto-run}`. */
  apiBase: string;
  /** The key-value prefix of this desk (see scopeKey). */
  keyPrefix: string;
  /** The decision timeframe this desk is fixed to, or null when the settings choose it. */
  fixedTimeframe: DeskTimeframe | null;
  /** What the Auto card says about when it runs. */
  scheduleText: string;
  /** Short name used in server messages. */
  label: string;
}>;

/** The key names the desk modules use; every profile moves them under its own prefix. */
export const BASE_KEY_PREFIX = "polarito:spy:";

export const MONTHLY_PROFILE: DeskProfile = Object.freeze({
  id: "monthly",
  title: "SPY desk",
  timeframeLabel: null,
  pagePath: "/spy",
  apiBase: "/api/spy",
  keyPrefix: BASE_KEY_PREFIX,
  fixedTimeframe: null,
  scheduleText: AUTO_SCHEDULE_TEXT,
  label: "SPY desk",
});

export const WWV_PROFILE: DeskProfile = Object.freeze({
  id: "wwv",
  title: "SPY DESK WWV",
  timeframeLabel: "Daily, WWV",
  pagePath: "/spy-wwv",
  apiBase: "/api/spy-wwv",
  keyPrefix: "polarito:spy-wwv:",
  fixedTimeframe: "D",
  scheduleText: "Once per weekday after the close (cron at 21:30 UTC, with a 22:30 UTC retry if the first run could not decide; it only acts from 16:15 ET, when the daily bar is final). Daily WWV can change every day, so Auto looks once a day, never during the session.",
  label: "SPY DESK WWV",
});

export const PROFILES: readonly DeskProfile[] = Object.freeze([MONTHLY_PROFILE, WWV_PROFILE]);

/** The profile's own key for a shared key name; throws on a key that is not one of the shared names (nothing is written unscoped). */
export function scopeKey(profile: DeskProfile, key: string): string {
  if (!key.startsWith(BASE_KEY_PREFIX)) throw new Error("Refusing a key outside the SPY desk key space.");
  return profile.keyPrefix + key.slice(BASE_KEY_PREFIX.length);
}

/** The URL of one of this desk's API routes. */
export const apiPath = (profile: DeskProfile, name: "desk" | "live" | "analyze" | "ticket" | "close" | "auto"): string => `${profile.apiBase}/${name}`;
