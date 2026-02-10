import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";
import type { ApiError } from "@/types/api";
import type { Transaction } from "@/types/wallet";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> }
) {
  const { chain, address } = await params;
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "50");
  const type = searchParams.get("type") as Transaction["type"] | null;

  if (!isChainSupported(chain)) {
    return NextResponse.json(
      { error: `Unsupported chain: ${chain}`, code: "CHAIN_ERROR" } satisfies ApiError,
      { status: 400 }
    );
  }

  try {
    const cacheKey = `wallet-txns:${chain}:${address}:${limit}:${type}`;
    const cached = serverCache.get<Transaction[]>(cacheKey);
    if (cached) {
      return NextResponse.json({ data: cached, cached: true });
    }

    const provider = getChainProvider(chain as ChainId);
    let txns = await provider.getWalletTransactions(address, { limit, type: type ?? undefined });

    if (type) {
      txns = txns.filter((tx) => tx.type === type);
    }

    serverCache.set(cacheKey, txns, CACHE_TTL.PRICE);

    return NextResponse.json({ data: txns, timestamp: Date.now(), cached: false });
  } catch (error) {
    console.error(`Error fetching wallet txns ${chain}/${address}:`, error);
    return NextResponse.json(
      { error: "Internal server error", code: "UNKNOWN", chain } satisfies ApiError,
      { status: 500 }
    );
  }
}
