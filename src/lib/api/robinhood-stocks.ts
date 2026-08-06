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
