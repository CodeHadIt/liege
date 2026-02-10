"use client";

import { useQuery } from "@tanstack/react-query";
import type { OHLCVBar, Timeframe } from "@/types/token";
import type { ChainId } from "@/types/chain";
import { REFETCH_INTERVALS } from "@/config/constants";

export function useTokenChart(
  chain: ChainId,
  address: string,
  timeframe: Timeframe = "1h"
) {
  return useQuery<OHLCVBar[]>({
    queryKey: ["chart", chain, address, timeframe],
    queryFn: async () => {
      const res = await fetch(
        `/api/chart/${chain}/${address}?tf=${timeframe}`
      );
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    },
    enabled: !!chain && !!address,
    refetchInterval: REFETCH_INTERVALS.CHART,
  });
}
