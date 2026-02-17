import { NextResponse } from "next/server";
import { fetchDuneTokens } from "@/lib/api/dune";
import { getTokenOrders } from "@/lib/api/dexscreener";
import type { DexOrderTag, DexOrderToken } from "@/types/token";

type Period = "30m" | "1h" | "2h" | "4h" | "8h";
const VALID_PERIODS: Period[] = ["30m", "1h", "2h", "4h", "8h"];
const BATCH_SIZE = 50;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") as Period | null;
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  if (!period || !VALID_PERIODS.includes(period)) {
    return NextResponse.json(
      { error: "Invalid period. Use: 30m, 1h, 2h, 4h, 8h" },
      { status: 400 }
    );
  }

  try {
    const { tokens: allTokens, metadata } = await fetchDuneTokens(period);
    const totalTokens = allTokens.length;
    console.log(`[dex-orders] Dune returned ${totalTokens} tokens for period=${period}, offset=${offset}`);
    const batch = allTokens.slice(offset, offset + BATCH_SIZE);

    const results: DexOrderToken[] = [];

    for (const token of batch) {
      const orderData = await getTokenOrders("solana", token.address);
      console.log(`[dex-orders] ${token.symbol} (${token.address}): orders=${JSON.stringify(orderData)}`);
      const tags: DexOrderTag[] = [];

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

      if (tags.length > 0) {
        const meta = metadata.get(token.address);
        results.push({
          ...token,
          tags,
          tradeCount: meta?.tradeCount,
          rank: meta?.rank,
        });
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
