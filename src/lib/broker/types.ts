/**
 * Broker boundary (server-side only). Everything returns a Result; nothing
 * throws across this boundary (Justice: explicit failure, never a false state).
 */
export type Result<T, C extends string = string> =
  | { ok: true; value: T }
  | { ok: false; code: C; error: string };

export type BrokerErrorCode =
  | "NETWORK"
  | "TIMEOUT"
  | "HTTP"
  | "MALFORMED"
  | "REJECTED";

export type PositionSide = "long" | "short";

export type BrokerAccount = {
  status: string;
  tradingBlocked: boolean;
  accountBlocked: boolean;
  equity: number;
  /** Equity at the previous session close; the base for the daily loss boundary. */
  lastEquity: number;
  cash: number;
  buyingPower: number;
  /** Live adapter only: Alpaca's `shorting_enabled`. Absent when the response did not carry a boolean. */
  shortingEnabled?: boolean;
  /** Live adapter only: Alpaca's buying-power multiplier (1 = cash account). */
  multiplier?: number;
};

export type BrokerPosition = {
  ticker: string;
  side: PositionSide;
  /** Always positive; the side carries the direction. */
  quantity: number;
  avgEntryPrice: number;
  /** Read-only display fields from Alpaca; present only when Alpaca sent a finite number. */
  currentPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
};

export type BrokerOrder = {
  id: string;
  clientOrderId: string;
  status: string;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  /** Read-only display fields from Alpaca; present only when Alpaca sent them. */
  filledQuantity?: number;
  filledAvgPrice?: number;
  submittedAt?: string;
  filledAt?: string;
};

/** Alpaca asset flags the live pick checks before sending an order. */
export type BrokerAsset = {
  symbol: string;
  status: string;
  tradable: boolean;
  shortable: boolean;
  /** Alpaca's `borrow_status`; `easy_to_borrow` is deprecated and not read. */
  borrowStatus: string | null;
};

export interface Broker {
  getAccount(): Promise<Result<BrokerAccount, BrokerErrorCode>>;
  getPositions(): Promise<Result<BrokerPosition[], BrokerErrorCode>>;
  /** ok(null) when no order carries that client id. */
  getOrderByClientId(clientOrderId: string): Promise<Result<BrokerOrder | null, BrokerErrorCode>>;
}

/** What the Auto OFF guard needs on top of the plain read-only broker. */
export interface LiveBroker extends Broker {
  /** ok(null) when Alpaca has no such asset. */
  getAsset(symbol: string): Promise<Result<BrokerAsset | null, BrokerErrorCode>>;
  /** Every order (any status) created after `afterIso`, oldest first. */
  listOrdersSince(afterIso: string): Promise<Result<BrokerOrder[], BrokerErrorCode>>;
  /** Every still-working order, any symbol. */
  listOpenOrders(): Promise<Result<BrokerOrder[], BrokerErrorCode>>;
}
