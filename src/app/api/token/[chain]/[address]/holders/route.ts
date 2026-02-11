import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import type { ChainId } from "@/types/chain";
import type { ApiError } from "@/types/api";
import { serverCache, CACHE_TTL } from "@/lib/cache";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> }
) {
  const { chain, address } = await params;

  if (!isChainSupported(chain)) {
    return NextResponse.json(
      { error: `Unsupported chain: ${chain}`, code: "CHAIN_ERROR" } satisfies ApiError,
      { status: 400 }
    );
  }

  try {
    const cacheKey = `holders:${chain}:${address}`;
    const cached = serverCache.get(cacheKey);
    if (cached) {
      return NextResponse.json({ data: cached, cached: true });
    }

    const provider = getChainProvider(chain as ChainId);
    const holders = await provider.getTopHolders(address, 50);

    serverCache.set(cacheKey, holders, CACHE_TTL.TOKEN_META);

    return NextResponse.json({
      data: holders,
      chain,
      timestamp: Date.now(),
      cached: false,
    });
  } catch (error) {
    console.error(`Error fetching holders ${chain}/${address}:`, error);
    return NextResponse.json(
      { error: "Internal server error", code: "UNKNOWN", chain } satisfies ApiError,
      { status: 500 }
    );
  }
}
