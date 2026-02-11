import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { Timeframe, OHLCVBar } from "@/types/token";

const VALID_TIMEFRAMES = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> }
) {
  const { chain, address } = await params;
  const { searchParams } = new URL(request.url);
  const tf = searchParams.get("tf") || "1h";

  if (!isChainSupported(chain)) {
    return NextResponse.json({ error: "Unsupported chain" }, { status: 400 });
  }

  if (!VALID_TIMEFRAMES.has(tf)) {
    return NextResponse.json({ error: "Invalid timeframe" }, { status: 400 });
  }

  const cacheKey = `chart:${chain}:${address}:${tf}`;
  const cached = serverCache.get<OHLCVBar[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ data: cached, cached: true });
  }

  try {
    const provider = getChainProvider(chain);
    const bars = await provider.getPriceHistory(address, tf as Timeframe);

    serverCache.set(cacheKey, bars, CACHE_TTL.CHART);
    return NextResponse.json({ data: bars });
  } catch (error) {
    console.error(`Chart error ${chain}/${address}:`, error);
    return NextResponse.json({ data: [] });
  }
}
