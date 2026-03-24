import { useQuery } from "@tanstack/react-query";
import type { ChainId } from "@/types/chain";
import type { TopTradersResponse } from "@/types/traders";

async function fetchTopTraders(
  chain: ChainId,
  address: string
): Promise<TopTradersResponse> {
  const res = await fetch(`/api/token/${chain}/${address}/top-traders`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to fetch top traders");
  }
  return res.json();
}

export function useTopTraders(chain: ChainId, address: string) {
  return useQuery({
    queryKey: ["top-traders", chain, address],
    queryFn: () => fetchTopTraders(chain, address),
    staleTime: 2 * 60 * 1000,
    // EVM scraping takes ~20-30s on first load; give it 90s before timing out
    gcTime: 5 * 60 * 1000,
    retry: 1,
    enabled: !!chain && !!address,
  });
}
