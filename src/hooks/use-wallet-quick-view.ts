import { useQuery } from "@tanstack/react-query";
import type { ChainId } from "@/types/chain";
import type { WalletQuickViewData } from "@/types/traders";

interface WalletQuickViewInput {
  walletAddress: string;
  chain: ChainId;
}

async function fetchWalletQuickView(
  input: WalletQuickViewInput
): Promise<WalletQuickViewData> {
  const res = await fetch("/api/wallet/quick-view", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to fetch wallet data");
  }
  return res.json();
}

export function useWalletQuickView(input: WalletQuickViewInput | null) {
  return useQuery({
    queryKey: ["wallet-quick-view", input?.walletAddress, input?.chain],
    queryFn: () => fetchWalletQuickView(input!),
    enabled: !!input,
    staleTime: 60 * 1000,
  });
}
