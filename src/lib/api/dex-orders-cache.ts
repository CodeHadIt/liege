import { supabase } from "@/lib/supabase";
import { getLatestTokenProfiles, type DexScreenerPair } from "./dexscreener";
import { rateLimit } from "@/lib/rate-limiter";
import type { DexOrderToken } from "@/types/token";

const BASE_URL = "https://api.dexscreener.com";
const POLL_THROTTLE_MS = 30_000;
let lastPollAt = 0;

type Period = "30m" | "1h" | "2h" | "4h" | "8h";

const PERIOD_HOURS: Record<Period, number> = {
  "30m": 0.5,
  "1h": 1,
  "2h": 2,
  "4h": 4,
  "8h": 8,
};

/**
 * Batch-fetch token pair data from DexScreener.
 * Up to 30 addresses per call, returns best pair per token.
 */
async function batchEnrich(
  addresses: string[]
): Promise<Map<string, DexScreenerPair>> {
  const result = new Map<string, DexScreenerPair>();
  const BATCH_SIZE = 30;

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);
    const joined = batch.join(",");

    await rateLimit("dexscreener");
    try {
      const res = await fetch(`${BASE_URL}/tokens/v1/solana/${joined}`, {
        headers: { Accept: "application/json" },
        next: { revalidate: 30 },
      });
      if (!res.ok) continue;
      const pairs: DexScreenerPair[] = await res.json();
      if (!Array.isArray(pairs)) continue;

      for (const pair of pairs) {
        const addr = pair.baseToken.address;
        const existing = result.get(addr);
        if (
          !existing ||
          (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)
        ) {
          result.set(addr, pair);
        }
      }
    } catch (err) {
      console.error("[dex-orders-cache] DexScreener enrich error:", err);
    }
  }

  return result;
}

/**
 * Poll DexScreener /token-profiles/latest/v1, filter Solana,
 * enrich new tokens with pair data, store complete rows in Supabase,
 * and clean up entries older than 24h. Throttled to 30s min between polls.
 */
export async function pollAndStoreDexProfiles(): Promise<number> {
  const now = Date.now();
  const elapsed = now - lastPollAt;
  if (elapsed < POLL_THROTTLE_MS) {
    console.log(
      `[dex-orders-cache] Poll throttled — ${Math.round((POLL_THROTTLE_MS - elapsed) / 1000)}s until next poll`
    );
    return 0;
  }
  lastPollAt = now;
  console.log(`[dex-orders-cache] Polling DexScreener /token-profiles/latest/v1 ...`);

  const profiles = await getLatestTokenProfiles();
  const solanaProfiles = profiles.filter((p) => p.chainId === "solana");

  if (solanaProfiles.length === 0) return 0;

  // Check which tokens are already in DB
  const addresses = solanaProfiles.map((p) => p.tokenAddress);
  const { data: existing } = await supabase
    .from("dex_profiles")
    .select("token_address")
    .in("token_address", addresses);

  const existingSet = new Set(existing?.map((r) => r.token_address) ?? []);
  const newProfiles = solanaProfiles.filter(
    (p) => !existingSet.has(p.tokenAddress)
  );

  if (newProfiles.length > 0) {
    // Enrich new tokens with pair data (price, FDV, name, etc.)
    const newAddresses = newProfiles.map((p) => p.tokenAddress);
    const enriched = await batchEnrich(newAddresses);

    const rows = newProfiles.map((p) => {
      const pair = enriched.get(p.tokenAddress);
      const twitter =
        pair?.info?.socials?.find((s) => s.type === "twitter")?.url ?? null;

      return {
        token_address: p.tokenAddress,
        chain_id: p.chainId,
        name: pair?.baseToken.name ?? null,
        symbol: pair?.baseToken.symbol ?? null,
        logo_url: p.icon ?? pair?.info?.imageUrl ?? null,
        price_usd: pair ? parseFloat(pair.priceUsd) : null,
        fdv: pair?.fdv ?? null,
        liquidity_usd: pair?.liquidity?.usd ?? null,
        trade_count: pair
          ? pair.txns.h24.buys + pair.txns.h24.sells
          : null,
        created_at: pair?.pairCreatedAt ?? null,
        url: p.url ?? null,
        twitter,
        discovered_at: new Date().toISOString(),
      };
    });

    const { error } = await supabase.from("dex_profiles").insert(rows);

    if (error) {
      console.error("[dex-orders-cache] Supabase insert error:", error.message);
    }
  }

  // Clean up entries older than 24h
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("dex_profiles").delete().lt("discovered_at", cutoff);

  const { count: totalCount } = await supabase
    .from("dex_profiles")
    .select("*", { count: "exact", head: true });

  console.log(
    `[dex-orders-cache] Polled: ${solanaProfiles.length} from API, ${newProfiles.length} new enriched & stored, ${totalCount ?? 0} total in DB`
  );
  return newProfiles.length;
}

/** DB row shape returned by Supabase query. */
interface DexProfileRow {
  token_address: string;
  name: string | null;
  symbol: string | null;
  logo_url: string | null;
  price_usd: number | null;
  fdv: number | null;
  liquidity_usd: number | null;
  trade_count: number | null;
  created_at: number | null;
  url: string | null;
  twitter: string | null;
  discovered_at: string;
}

/**
 * Query Supabase for fully-enriched profiles within the period.
 * Returns DexOrderToken[] ready to serve to the frontend.
 */
export async function getDexProfiles(period: Period): Promise<DexOrderToken[]> {
  const hours = PERIOD_HOURS[period];
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("dex_profiles")
    .select(
      "token_address, name, symbol, logo_url, price_usd, fdv, liquidity_usd, trade_count, created_at, url, twitter, discovered_at"
    )
    .gte("discovered_at", since)
    .order("discovered_at", { ascending: false });

  if (error) {
    console.error("[dex-orders-cache] Supabase query error:", error.message);
    return [];
  }

  return (data as DexProfileRow[]).map((row) => ({
    address: row.token_address,
    name: row.name ?? row.token_address.slice(0, 8),
    symbol: row.symbol ?? "???",
    logoUrl: row.logo_url,
    priceUsd: row.price_usd,
    fdv: row.fdv,
    liquidity: row.liquidity_usd,
    createdAt: row.created_at
      ? new Date(row.created_at).toISOString()
      : row.discovered_at,
    tags: ["dexPaid"] as const,
    tradeCount: row.trade_count ?? undefined,
    discoveredAt: row.discovered_at,
    url: row.url,
    twitter: row.twitter,
  }));
}

/**
 * Get the total count of profiles currently stored in Supabase.
 */
export async function getTotalProfileCount(): Promise<number> {
  const { count, error } = await supabase
    .from("dex_profiles")
    .select("*", { count: "exact", head: true });

  if (error) {
    console.error("[dex-orders-cache] Count error:", error.message);
    return 0;
  }
  return count ?? 0;
}
