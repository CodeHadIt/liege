"use client";

import { useQuery } from "@tanstack/react-query";
import type { WalletData } from "@/types/wallet";
import type { ChainId } from "@/types/chain";

export function useWalletData(chain: ChainId, address: string) {
  return useQuery<WalletData | null>({
    queryKey: ["wallet", chain, address],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/${chain}/${address}`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data || null;
    },
    enabled: !!chain && !!address,
    staleTime: 60_000,
  });
}
