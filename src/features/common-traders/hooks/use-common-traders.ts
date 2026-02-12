import { useMutation } from "@tanstack/react-query";
import type { ChainId } from "@/types/chain";
import type { CommonTradersResponse } from "@/types/traders";

interface TokenInput {
  chain: ChainId;
  address: string;
}

async function fetchCommonTraders(
  tokens: TokenInput[]
): Promise<CommonTradersResponse> {
  const res = await fetch("/api/traders/common", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokens }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to find common traders");
  }
  return res.json();
}

export function useCommonTraders() {
  return useMutation({
    mutationFn: fetchCommonTraders,
  });
}
