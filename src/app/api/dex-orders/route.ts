import { NextResponse } from "next/server";
import { fetchAllPumpFunForPeriod } from "@/lib/api/pump-fun-utils";
import { getTokenOrders } from "@/lib/api/dexscreener";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { DexOrderTag, DexOrderToken } from "@/types/token";

type Period = "1h" | "4h" | "6h" | "12h" | "24h";
const VALID_PERIODS: Period[] = ["1h", "4h", "6h", "12h", "24h"];
const BATCH_SIZE = 50;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") as Period | null;
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  if (!period || !VALID_PERIODS.includes(period)) {
    return NextResponse.json(
      { error: "Invalid period. Use: 1h, 4h, 6h, 12h, 24h" },
      { status: 400 }
    );
  }

  try {
    const allTokens = await fetchAllPumpFunForPeriod(period);
    const totalTokens = allTokens.length;
    const batch = allTokens.slice(offset, offset + BATCH_SIZE);

    const results: DexOrderToken[] = [];

    for (const token of batch) {
      const cacheKey = `dex-orders:${token.address}`;
      let tags = serverCache.get<DexOrderTag[]>(cacheKey);

      if (tags === null) {
        // Cache miss — query DexScreener
        const orderData = await getTokenOrders("solana", token.address);
        tags = [];

        if (orderData?.orders) {
          for (const order of orderData.orders) {
            if (order.status !== "approved") continue;
            if (order.type === "tokenProfile" && !tags.includes("dexPaid")) {
              tags.push("dexPaid");
            }
            if (order.type === "communityTakeover" && !tags.includes("cto")) {
              tags.push("cto");
            }
          }
        }

        // Cache even empty arrays (means "checked, no orders")
        serverCache.set(cacheKey, tags, CACHE_TTL.DEX_ORDERS);
      }

      if (tags.length > 0) {
        results.push({ ...token, tags });
      }
    }

    const nextOffset = offset + BATCH_SIZE;
    const hasMore = nextOffset < totalTokens;

    return NextResponse.json({
      data: results,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
      totalChecked: Math.min(nextOffset, totalTokens),
      totalTokens,
    });
  } catch (error) {
    console.error("Dex orders API error:", error);
    return NextResponse.json(
      { data: [], hasMore: false, nextOffset: null, totalChecked: 0, totalTokens: 0 },
      { status: 500 }
    );
  }
}
