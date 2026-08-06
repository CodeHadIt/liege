import { rateLimit } from "@/lib/rate-limiter";

// Long (app.long.xyz/create) lets you create/trade token pairs against tokenized
// stocks on Robinhood Chain. Long's own catalog API is Cloudflare + wallet gated,
// but the underlying stocks come from Robinhood Chain's official, public asset
// registry — the source of truth for what stocks exist (and thus what Long can
// offer). We monitor that registry.
export const RH_ASSETS_URL = "https://api.robinhood.com/rhj/assets";
export const RH_CHAIN_ID = 4663;
export const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

export interface RhStockToken {
  symbol: string;
  name: string;
  /** ERC-20 contract on Robinhood Chain (4663) */
  contractAddress: string;
  logoUrl: string | null;
  status: string;
  isin: string | null;
  decimals: number;
}

interface RhDeployment {
  chainId?: number | string;
  contractAddress?: string;
}
interface RhAsset {
  tokenSymbol?: string;
  tokenName?: string;
  deployments?: RhDeployment[];
  status?: string;
  logoUrl?: string;
  isin?: string;
  tokenDecimals?: number;
}

/**
 * Fetch all stock tokens deployed on Robinhood Chain from the official registry.
 * Only assets with a Robinhood-mainnet (4663) deployment are returned.
 */
export async function fetchRobinhoodStockTokens(): Promise<RhStockToken[]> {
  await rateLimit("robinhood");
  try {
    const res = await fetch(RH_ASSETS_URL, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const arr: RhAsset[] = Array.isArray(data)
      ? data
      : (data?.assets ?? data?.data ?? data?.results ?? []);

    const out: RhStockToken[] = [];
    for (const a of arr) {
      const dep = (a.deployments ?? []).find(
        (d) => String(d.chainId) === String(RH_CHAIN_ID)
      );
      if (!dep?.contractAddress || !a.tokenSymbol) continue;
      out.push({
        symbol: a.tokenSymbol,
        name: a.tokenName ?? a.tokenSymbol,
        contractAddress: dep.contractAddress,
        logoUrl: a.logoUrl ?? null,
        status: a.status ?? "",
        isin: a.isin ?? null,
        decimals: typeof a.tokenDecimals === "number" ? a.tokenDecimals : 18,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function rhExplorerTokenUrl(address: string): string {
  return `${RH_EXPLORER}/token/${address}`;
}

// ── Tokens created against a stock (Long launches) ────────────────────────────
// A token "created with a stock base pair" appears on-chain as a pool where the
// new token is the base and the stock is the quote. DexScreener indexes these on
// the robinhood network, so we read them from its token-pairs endpoint.

export interface CreatedToken {
  tokenAddress: string;
  symbol: string;
  name: string;
  dexId: string;
  /** pool creation time in ms (proxy for token creation) */
  pairCreatedAt: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  pairUrl: string | null;
  imageUrl: string | null;
}

interface DexPair {
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string };
  dexId?: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  liquidity?: { usd?: number };
  marketCap?: number;
  url?: string;
  info?: { imageUrl?: string };
}

/**
 * Return the tokens that have been created against a given stock (i.e. pools
 * where the stock is the quote token), deduped by token and sorted oldest-first.
 */
export async function fetchTokensCreatedAgainst(stockAddress: string): Promise<CreatedToken[]> {
  await rateLimit("dexscreener");
  try {
    const res = await fetch(
      `https://api.dexscreener.com/token-pairs/v1/robinhood/${stockAddress}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const pairs: DexPair[] = Array.isArray(data) ? data : (data?.pairs ?? []);
    const stock = stockAddress.toLowerCase();

    const byToken = new Map<string, CreatedToken>();
    for (const p of pairs) {
      // Only pools where the stock is the QUOTE side = something paired against it.
      if ((p.quoteToken?.address ?? "").toLowerCase() !== stock) continue;
      const addr = p.baseToken?.address ?? "";
      if (!addr) continue;
      const tok: CreatedToken = {
        tokenAddress: addr,
        symbol: p.baseToken?.symbol ?? "?",
        name: p.baseToken?.name ?? p.baseToken?.symbol ?? "",
        dexId: p.dexId ?? "",
        pairCreatedAt: p.pairCreatedAt ?? null,
        priceUsd: p.priceUsd ? parseFloat(p.priceUsd) : null,
        liquidityUsd: p.liquidity?.usd ?? null,
        marketCap: p.marketCap ?? null,
        pairUrl: p.url ?? null,
        imageUrl: p.info?.imageUrl ?? null,
      };
      // a token may have several pools against the stock — keep the deepest
      const ex = byToken.get(addr);
      if (!ex || (tok.liquidityUsd ?? 0) > (ex.liquidityUsd ?? 0)) byToken.set(addr, tok);
    }
    return [...byToken.values()].sort(
      (a, b) => (a.pairCreatedAt ?? 0) - (b.pairCreatedAt ?? 0)
    );
  } catch {
    return [];
  }
}
