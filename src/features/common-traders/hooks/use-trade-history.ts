import { useQuery } from "@tanstack/react-query";
import type { ChainId } from "@/types/chain";
import type { TradeHistoryResponse } from "@/types/traders";

export interface TradeHistoryInput {
  walletAddress: string;
  tokens: {
    chain: ChainId;
    address: string;
    symbol: string;
    currentBalance: number;
    priceUsd: number | null;
  }[];
}

async function fetchTradeHistory(
  input: TradeHistoryInput
): Promise<TradeHistoryResponse> {
  const res = await fetch("/api/traders/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to fetch trade history");
  }
  return res.json();
}

export function useTradeHistory(input: TradeHistoryInput | null) {
  return useQuery({
    queryKey: ["trade-history", input?.walletAddress],
    queryFn: () => fetchTradeHistory(input!),
    enabled: !!input,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
