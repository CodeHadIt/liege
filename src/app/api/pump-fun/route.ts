import { NextResponse } from "next/server";
import { getPumpFunNewTokens } from "@/lib/api/moralis";
import {
  fetchAllPumpFunForPeriod,
  mapMoralisTokens,
} from "@/lib/api/pump-fun-utils";

type Period = "latest" | "1h" | "4h" | "6h" | "24h" | "1w";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = (searchParams.get("period") || "latest") as Period;

  try {
    // --- Time-based periods: use shared utility (cached 1h) ---
    if (period !== "latest") {
      const tokens = await fetchAllPumpFunForPeriod(period);
      return NextResponse.json({
        data: tokens,
        nextCursor: null,
        hasMore: false,
      });
    }

    // --- "Latest": uncached, cursor-based pagination ---
    const cursor = searchParams.get("cursor") || undefined;
    const response = await getPumpFunNewTokens(100, cursor);
    if (!response?.result) {
      return NextResponse.json({ data: [], nextCursor: null, hasMore: false });
    }

    const tokens = mapMoralisTokens(response.result);
    const moralisCursor = response.cursor || null;

    return NextResponse.json({
      data: tokens,
      nextCursor: moralisCursor,
      hasMore: moralisCursor !== null,
    });
  } catch (error) {
    console.error("Pump.fun API error:", error);
    return NextResponse.json({ data: [], nextCursor: null, hasMore: false });
  }
}
