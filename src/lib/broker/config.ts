/**
 * Paper-trading switches, read from the server environment. Fail-closed:
 *   - Trading needs POLARITO_PAPER_TRADING_ENABLED === "1" exactly.
 *   - POLARITO_BROKER_KILL stops all order placement. Anything other than an
 *     explicit "off" value ("", "0", "false", "no", "off") counts as KILLED.
 *   - Paper keys are separate variables, so live keys are never picked up.
 */
export type BrokerEnv = Readonly<Record<string, string | undefined>>;

export type PaperBrokerConfig = {
  enabled: boolean;
  killed: boolean;
  configured: boolean;
};

export type TradingGate =
  | { ok: true }
  | { ok: false; code: "KILLED" | "DISABLED" | "NOT_CONFIGURED"; error: string };

const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

export function paperBrokerConfig(env: BrokerEnv): PaperBrokerConfig {
  const killRaw = env.POLARITO_BROKER_KILL;
  return {
    enabled: env.POLARITO_PAPER_TRADING_ENABLED === "1",
    killed: killRaw !== undefined && !OFF_VALUES.has(killRaw.trim().toLowerCase()),
    configured: Boolean(env.ALPACA_PAPER_KEY_ID?.trim() && env.ALPACA_PAPER_SECRET_KEY?.trim()),
  };
}

export function paperCredentials(env: BrokerEnv): { keyId: string; secretKey: string } | null {
  const keyId = env.ALPACA_PAPER_KEY_ID?.trim();
  const secretKey = env.ALPACA_PAPER_SECRET_KEY?.trim();
  return keyId && secretKey ? { keyId, secretKey } : null;
}

/** The single gate every order passes through. Kill switch wins over everything. */
export function tradingGate(config: PaperBrokerConfig): TradingGate {
  if (config.killed) {
    return { ok: false, code: "KILLED", error: "Kill switch is on. No orders will be placed." };
  }
  if (!config.enabled) {
    return {
      ok: false,
      code: "DISABLED",
      error: "Paper trading is not enabled (set POLARITO_PAPER_TRADING_ENABLED=1).",
    };
  }
  if (!config.configured) {
    return { ok: false, code: "NOT_CONFIGURED", error: "Alpaca paper credentials are not configured." };
  }
  return { ok: true };
}
