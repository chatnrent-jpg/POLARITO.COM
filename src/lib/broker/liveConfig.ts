/**
 * Live-cash switches, read from the server environment. Everything here is OFF
 * unless a variable is set to exactly "1"; with none of them set the app never
 * builds a live broker, never reads the ALPACA_LIVE_* keys and never contacts
 * the live host.
 *
 *   POLARITO_LIVE_ACCOUNT=1          opt in to the live account (keys + live URL). Read-only on its own.
 *   POLARITO_LIVE_TRADING_ENABLED=1  also allow real orders. Anything else = observe only.
 *   POLARITO_BROKER_KILL             the shared kill switch; it stops live orders too.
 *
 * Live keys are separate variables (ALPACA_LIVE_KEY_ID / ALPACA_LIVE_SECRET_KEY);
 * the paper keys are never used for live and the live keys are never used for paper.
 */
import { AlpacaPaperBroker } from "@/lib/broker/alpacaPaper";
import { paperBrokerConfig, type BrokerEnv, type PaperBrokerConfig } from "@/lib/broker/config";
import type { LiveBroker } from "@/lib/broker/types";

export const liveOptedIn = (env: BrokerEnv): boolean => env.POLARITO_LIVE_ACCOUNT === "1";

export function liveCredentials(env: BrokerEnv): { keyId: string; secretKey: string } | null {
  const keyId = env.ALPACA_LIVE_KEY_ID?.trim();
  const secretKey = env.ALPACA_LIVE_SECRET_KEY?.trim();
  return keyId && secretKey ? { keyId, secretKey } : null;
}

/** Same shape as the paper config so the shared executor gate works unchanged. */
export function liveBrokerConfig(env: BrokerEnv): PaperBrokerConfig {
  return {
    enabled: env.POLARITO_LIVE_TRADING_ENABLED === "1",
    killed: paperBrokerConfig(env).killed,
    configured: liveCredentials(env) !== null,
  };
}

/** null unless the live opt-in is on AND the live keys exist. */
export function createLiveBroker(env: BrokerEnv): LiveBroker | null {
  if (!liveOptedIn(env)) return null;
  const creds = liveCredentials(env);
  if (!creds) return null;
  return new AlpacaPaperBroker({ ...creds, target: "live" });
}
