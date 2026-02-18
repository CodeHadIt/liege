import { NextResponse } from "next/server";
import {
  getDexProfiles,
  getTotalProfileCount,
} from "@/lib/api/dex-orders-cache";

type Period = "30m" | "1h" | "2h" | "4h" | "8h";
const VALID_PERIODS: Period[] = ["30m", "1h", "2h", "4h", "8h"];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") as Period | null;

  if (!period || !VALID_PERIODS.includes(period)) {
    return NextResponse.json(
      { error: "Invalid period. Use: 30m, 1h, 2h, 4h, 8h" },
      { status: 400 }
    );
  }

  try {
    // Pure read from Supabase — polling happens in background via instrumentation.ts
    const data = await getDexProfiles(period);
    const totalProfiles = await getTotalProfileCount();

    return NextResponse.json({
      data,
      totalProfiles,
      period,
      hasMore: false,
      totalChecked: data.length,
      totalTokens: data.length,
    });
  } catch (error) {
    console.error("Dex orders API error:", error);
    return NextResponse.json(
      {
        data: [],
        hasMore: false,
        totalChecked: 0,
        totalTokens: 0,
        totalProfiles: 0,
        period,
      },
      { status: 500 }
    );
  }
}
