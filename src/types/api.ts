import type { ChainId } from "./chain";

export interface ApiResponse<T> {
  data: T;
  chain: ChainId;
  timestamp: number;
  cached: boolean;
}

export interface ApiError {
  error: string;
  code:
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "INVALID_ADDRESS"
    | "CHAIN_ERROR"
    | "UNKNOWN";
  chain?: ChainId;
}
