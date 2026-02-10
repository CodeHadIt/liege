"use client";

import { useQuery } from "@tanstack/react-query";
import type { UnifiedTokenData } from "@/types/token";
import type { ChainId } from "@/types/chain";
import { REFETCH_INTERVALS } from "@/config/constants";

export function useTokenData(chain: ChainId, address: string) {
  return useQuery<UnifiedTokenData | null>({
    queryKey: ["token", chain, address],
    queryFn: async () => {
      const res = await fetch(`/api/token/${chain}/${address}`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data || null;
    },
    enabled: !!chain && !!address,
    refetchInterval: REFETCH_INTERVALS.PRICE,
  });
}
