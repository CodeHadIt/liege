import { rateLimit } from "@/lib/rate-limiter";

// ── o1 Launchpad ─────────────────────────────────────────────────────────────
//
// o1 mints a fixed-supply token and seeds a locked Uniswap v4 pool in one
// transaction, priced against a paired asset. Same shape as StonkFun and the
// Robinhood-chain launchpads: a catalog of pairable assets, and launches priced
// against them.
//
// This reads o1's documented public API. The first implementation could not:
// launch.o1.exchange sits behind a Vercel checkpoint that answers 429 to every
// non-browser request, so the quote catalog was lifted from a JS bundle and
// pinned in source. That list was stale the day it shipped — it had 10 stocks
// where the API reports 13, missing CRCL, INTC and MSFT outright.
//
// api.launch.o1.exchange is NOT behind the checkpoint. It needs a key, and it
// answers the catalog question directly, which is what makes a new pair
// announceable when it is REGISTERED rather than when someone first launches
// against it.

const API = "https://api.launch.o1.exchange/v1";

/** Chains o1 runs on. Base is live here; Robinhood is the same API surface. */
export const O1_CHAIN = { BASE: 8453, ROBINHOOD: 4663 } as const;
export type O1ChainId = (typeof O1_CHAIN)[keyof typeof O1_CHAIN];

export function o1KeyConfigured(): boolean {
  return !!process.env.O1_API_KEY;
}

/**
 * Documented limits on the developer plan: 20/s, 300/min, 25k/day, 500k/month.
 * The pollers here use roughly 3,600/day, so the daily quota is ~7x headroom;
 * the per-second limit is the only one worth pacing against.
 */
async function get<T>(path: string, params: Record<string, string | number | boolean>): Promise<T | null> {
  const key = process.env.O1_API_KEY;
  if (!key) return null;

  await rateLimit("o1");
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  // 429s are a normal part of a quota'd API, not a failure. o1 sends
  // Retry-After, so honour it rather than hammering — and never treat a rate
  // limit as "no data", which would look like an empty catalog.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "x-api-key": key, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 429) {
        const wait = Math.min(30, Number(res.headers.get("retry-after") ?? 2) || 2);
        console.warn(`[o1] ${path} rate limited — waiting ${wait}s (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) {
        console.error(`[o1] ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const j = await res.json();
      return (j?.data ?? null) as T;
    } catch (err) {
      console.error(`[o1] ${path} failed: ${(err as Error).message}`);
      return null;
    }
  }
  console.error(`[o1] ${path} still rate limited after retries — skipping this pass`);
  return null;
}

export interface O1Quote {
  address: string;
  symbol: string;
  decimals: number;
  /** `rwa` = a stock. `standard` = ETH/USDC and friends. */
  route: "rwa" | "standard" | string;
  suiteId: string | null;
  /** o1 has wired the quote up on-chain. */
  registered: boolean;
  /** o1's launch form offers it. This is the liveness signal. */
  selectable: boolean;
}

interface RawQuote {
  address?: string;
  symbol?: string;
  decimals?: number;
  route?: string;
  suite_id?: string;
  registered?: boolean;
  selectable?: boolean;
}

/**
 * The quote catalog for a chain.
 *
 * `activeOnly: false` returns everything o1 knows about, including quotes not
 * yet switched on — 15 on Base against 6 selectable. Fetching the full list is
 * what makes a stock going live a visible transition rather than a surprise
 * arrival, so the poller reads it all and filters on `selectable` itself.
 *
 * Returns null on failure rather than an empty array: a caller that treated a
 * dead fetch as "no quotes" would announce the entire catalog as new when it
 * recovered.
 */
export async function fetchO1Quotes(
  chainId: O1ChainId,
  activeOnly = false
): Promise<O1Quote[] | null> {
  const data = await get<{ quotes?: RawQuote[] }>("/config", {
    chain_id: chainId,
    include: "chains,suites,quotes",
    active_only: activeOnly,
  });
  if (!data?.quotes) return null;

  return data.quotes
    .filter((q) => q.address && q.symbol)
    .map((q) => ({
      address: String(q.address).toLowerCase(),
      symbol: String(q.symbol),
      decimals: typeof q.decimals === "number" ? q.decimals : 18,
      route: (q.route as O1Quote["route"]) ?? "standard",
      suiteId: q.suite_id ?? null,
      registered: q.registered === true,
      selectable: q.selectable === true,
    }));
}

export interface O1Launch {
  tokenAddress: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  quoteAddress: string;
  quoteSymbol: string;
  /** `rwa` marks a stock-paired launch — o1's own classification. */
  market: string;
  createdAt: number;
  creator: string | null;
  poolId: string | null;
  txHash: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
}

interface RawToken {
  chain_id?: number;
  market?: string;
  token?: { address?: string; name?: string; symbol?: string; image_url?: string };
  launch?: {
    creator_address?: string;
    pool_id?: string;
    created_at?: string;
    quote?: { address?: string; symbol?: string };
    onchain?: { transaction_hash?: string };
  };
  market_data?: {
    price?: { usd?: number };
    market_cap?: { usd?: number };
    liquidity?: { usd?: number };
  };
}

/**
 * Launches, newest first.
 *
 * Each record names the quote alongside the token, so the pairing is exact and
 * atomic — no pool lookup and no retry queue, the property that makes StonkFun's
 * feed reliable.
 *
 * Returns null on failure rather than an empty array, so a caller cannot mistake
 * a dead fetch for "nothing launched" and advance past a gap.
 */
export async function fetchO1Launches(
  chainId: O1ChainId,
  limit = 50
): Promise<O1Launch[] | null> {
  const data = await get<RawToken[]>("/tokens", {
    chain_id: chainId,
    sort: "newest",
    limit,
  });
  if (!Array.isArray(data)) return null;

  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const str = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : null);

  const out: O1Launch[] = [];
  for (const r of data) {
    const addr = str(r.token?.address);
    const quote = str(r.launch?.quote?.address);
    const created = Date.parse(r.launch?.created_at ?? "");
    if (!addr || !quote || !Number.isFinite(created)) continue;
    out.push({
      tokenAddress: addr.toLowerCase(),
      name: str(r.token?.name) ?? str(r.token?.symbol) ?? "Unknown",
      symbol: str(r.token?.symbol) ?? "?",
      imageUrl: str(r.token?.image_url),
      quoteAddress: quote.toLowerCase(),
      quoteSymbol: str(r.launch?.quote?.symbol) ?? "?",
      market: str(r.market) ?? "standard",
      createdAt: created,
      creator: str(r.launch?.creator_address),
      poolId: str(r.launch?.pool_id),
      txHash: str(r.launch?.onchain?.transaction_hash),
      priceUsd: num(r.market_data?.price?.usd),
      marketCapUsd: num(r.market_data?.market_cap?.usd),
      liquidityUsd: num(r.market_data?.liquidity?.usd),
    });
  }
  return out;
}
