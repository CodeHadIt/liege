import { NextResponse } from "next/server";
import { isChainSupported } from "@/lib/chains/registry";
import * as helius from "@/lib/api/helius";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";
import type { Transaction } from "@/types/wallet";

function mapType(type: string): Transaction["type"] {
  const t = type.toLowerCase();
  if (t.includes("swap")) return "swap";
  if (t.includes("transfer")) return "transfer";
  if (t.includes("create") || t.includes("deploy")) return "deploy";
  if (t.includes("approve")) return "approve";
  return "other";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> }
) {
  const { chain, address } = await params;

  if (!isChainSupported(chain)) {
    return NextResponse.json({ data: [] });
  }

  const chainId = chain as ChainId;

  if (chainId !== "solana") {
    return NextResponse.json({ data: [] });
  }

  try {
    const cacheKey = `token-txns:${chain}:${address}`;
    const cached = serverCache.get<Transaction[]>(cacheKey);
    if (cached) return NextResponse.json({ data: cached });

    const txns = await helius.getTransactionHistory(address, 30);

    // Collect all unique mints to resolve names
    const mintSet = new Set<string>();
    for (const tx of txns) {
      for (const tt of tx.tokenTransfers ?? []) {
        if (tt.mint) mintSet.add(tt.mint);
      }
    }
    const assetMap = await helius.getAssetBatch([...mintSet]);

    const data: Transaction[] = txns.map((tx) => {
      const firstToken = tx.tokenTransfers?.[0];
      return {
        hash: tx.signature,
        blockNumber: 0,
        timestamp: tx.timestamp,
        type: mapType(tx.type),
        from:
          firstToken?.fromUserAccount ??
          tx.nativeTransfers?.[0]?.fromUserAccount ??
          "",
        to:
          firstToken?.toUserAccount ??
          tx.nativeTransfers?.[0]?.toUserAccount ??
          "",
        value: firstToken?.tokenAmount ?? tx.nativeTransfers?.[0]?.amount ?? 0,
        valueUsd: null,
        token: firstToken
          ? {
              address: firstToken.mint,
              symbol: assetMap.get(firstToken.mint)?.symbol ?? "",
              name: assetMap.get(firstToken.mint)?.name ?? "",
            }
          : null,
        fee: tx.fee,
        status: "success" as const,
      };
    });

    serverCache.set(cacheKey, data, CACHE_TTL.PRICE);
    return NextResponse.json({ data });
  } catch (error) {
    console.error("Token transactions error:", error);
    return NextResponse.json({ data: [] });
  }
}
