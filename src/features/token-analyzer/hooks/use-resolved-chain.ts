"use client";

import { useQuery } from "@tanstack/react-query";
import type { ChainId } from "@/types/chain";
import type { TokenSearchResult } from "@/types/token";

/**
 * For Solana, the chain is unambiguous from the address format.
 * For EVM (base / bsc), both chains share the same 0x address format — we must
 * verify the actual chain via DexScreener before trusting the URL param.
 */
export function useResolvedChain(chain: ChainId, address: string) {
  const isEvm = chain === "base" || chain === "bsc";

  const { data: resolvedChain, isLoading } = useQuery<ChainId>({
    queryKey: ["resolved-chain", address],
    queryFn: async (): Promise<ChainId> => {
      const res = await fetch(
        `/api/token/search?q=${encodeURIComponent(address)}`
      );
      if (!res.ok) return chain;
      const json = await res.json();
      const results: TokenSearchResult[] = json.data ?? [];
      const match = results.find(
        (r) => r.address.toLowerCase() === address.toLowerCase()
      );
      return match?.chain ?? chain;
    },
    enabled: isEvm && !!address,
    // Chain for a given address is stable — no need to refetch
    staleTime: Infinity,
    gcTime: 1000 * 60 * 10,
  });

  if (!isEvm) return { resolvedChain: chain, isLoading: false };
  return { resolvedChain: resolvedChain ?? chain, isLoading };
}
