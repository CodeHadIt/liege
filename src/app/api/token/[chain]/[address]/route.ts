import { NextResponse } from "next/server";
import { aggregateTokenData } from "@/lib/aggregator";
import { isChainSupported } from "@/lib/chains/registry";
import type { ApiError } from "@/types/api";

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
    const data = await aggregateTokenData(chain, address);
    if (!data) {
      return NextResponse.json(
        { error: "Token not found", code: "NOT_FOUND", chain } satisfies ApiError,
        { status: 404 }
      );
    }

    return NextResponse.json({
      data,
      chain,
      timestamp: Date.now(),
      cached: false,
    });
  } catch (error) {
    console.error(`Error fetching token ${chain}/${address}:`, error);
    return NextResponse.json(
      { error: "Internal server error", code: "UNKNOWN", chain } satisfies ApiError,
      { status: 500 }
    );
  }
}
