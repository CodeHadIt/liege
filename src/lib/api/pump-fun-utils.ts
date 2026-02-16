import { getPumpFunNewTokens } from "@/lib/api/moralis";
import { serverCache } from "@/lib/cache";
import type { PumpFunToken } from "@/types/token";

type TimePeriod = "1h" | "4h" | "6h" | "12h" | "24h" | "1w";

export const PERIOD_MS: Record<TimePeriod, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
};

const PERIOD_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export function mapMoralisTokens(
  result: NonNullable<Awaited<ReturnType<typeof getPumpFunNewTokens>>>["result"]
): PumpFunToken[] {
  return result.map((t) => ({
    address: t.tokenAddress,
    name: t.name || "Unknown",
    symbol: t.symbol || "???",
    logoUrl: t.logo || null,
    priceUsd: t.priceUsd ? parseFloat(t.priceUsd) : null,
    liquidity: t.liquidity ? parseFloat(t.liquidity) : null,
    fdv: t.fullyDilutedValuation
      ? parseFloat(t.fullyDilutedValuation)
      : null,
    createdAt: t.createdAt,
  }));
}

/** Fetch all Moralis pages within a time window, server-side cached for 1h. */
export async function fetchAllPumpFunForPeriod(
  period: TimePeriod
): Promise<PumpFunToken[]> {
  const cacheKey = `pump-fun:${period}`;
  const cached = serverCache.get<PumpFunToken[]>(cacheKey);
  if (cached) return cached;

  const cutoff = Date.now() - PERIOD_MS[period];
  const all: PumpFunToken[] = [];
  let cursor: string | undefined;

  while (true) {
    const response = await getPumpFunNewTokens(100, cursor);
    if (!response?.result?.length) break;

    const tokens = mapMoralisTokens(response.result);
    const filtered = tokens.filter(
      (t) => new Date(t.createdAt).getTime() >= cutoff
    );
    all.push(...filtered);

    // Stop if oldest token in this page is outside the window
    const oldest = tokens[tokens.length - 1];
    if (!oldest || new Date(oldest.createdAt).getTime() < cutoff) break;
    if (!response.cursor) break;

    cursor = response.cursor;
  }

  serverCache.set(cacheKey, all, PERIOD_CACHE_TTL);
  return all;
}
