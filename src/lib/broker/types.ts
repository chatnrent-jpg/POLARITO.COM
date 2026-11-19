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
  cash: number;
  buyingPower: number;
};

export type BrokerPosition = {
  ticker: string;
  side: PositionSide;
  /** Always positive; the side carries the direction. */
  quantity: number;
  avgEntryPrice: number;
};

export type BrokerOrder = {
  id: string;
  clientOrderId: string;
  status: string;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
};

export type MarketOrderRequest = {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  clientOrderId: string;
  timeInForce: "day" | "opg";
};

export interface Broker {
  getAccount(): Promise<Result<BrokerAccount, BrokerErrorCode>>;
  getPositions(): Promise<Result<BrokerPosition[], BrokerErrorCode>>;
  /** ok(null) when no order carries that client id. */
  getOrderByClientId(clientOrderId: string): Promise<Result<BrokerOrder | null, BrokerErrorCode>>;
  submitMarketOrder(req: MarketOrderRequest): Promise<Result<BrokerOrder, BrokerErrorCode>>;
}

/** What the strategy wants done. Closes always flatten the broker's ACTUAL quantity. */
export type OrderIntent = {
  action: "enter" | "close";
  ticker: string;
  /** The position side being entered or closed. */
  side: PositionSide;
  /** Shares to enter. Ignored for closes. */
  quantity: number;
  /** Session date (YYYY-MM-DD) of the signal bar. Part of the idempotency key. */
  signalDate: string;
  timeInForce?: "day" | "opg";
};
