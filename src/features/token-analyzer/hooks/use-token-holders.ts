"use client";

import { useQuery } from "@tanstack/react-query";
import type { HolderEntry } from "@/types/token";
import type { ChainId } from "@/types/chain";

export function useTokenHolders(chain: ChainId, address: string) {
  return useQuery<HolderEntry[]>({
    queryKey: ["holders", chain, address],
    queryFn: async () => {
      const res = await fetch(`/api/token/${chain}/${address}/holders`);
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    },
    enabled: !!chain && !!address,
    staleTime: 5 * 60 * 1000,
  });
}
