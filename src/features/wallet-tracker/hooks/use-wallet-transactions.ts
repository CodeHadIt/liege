"use client";

import { useQuery } from "@tanstack/react-query";
import type { Transaction } from "@/types/wallet";
import type { ChainId } from "@/types/chain";

export function useWalletTransactions(
  chain: ChainId,
  address: string,
  type?: Transaction["type"]
) {
  return useQuery<Transaction[]>({
    queryKey: ["wallet-txns", chain, address, type],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "50" });
      if (type) params.set("type", type);
      const res = await fetch(
        `/api/wallet/${chain}/${address}/transactions?${params}`
      );
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    },
    enabled: !!chain && !!address,
    staleTime: 30_000,
  });
}
