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
  /** pool creation time in ms (when a pool for this pair first appeared) */
  pairCreatedAt: number | null;
  /** on-chain contract deployment time in SECONDS — the true launch time */
  onChainCreatedAt: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  pairUrl: string | null;
  imageUrl: string | null;
}

/**
 * Look up on-chain contract-deployment timestamps (unix seconds) for a batch of
 * addresses via the Robinhood Chain Blockscout explorer. This is the true "launch
 * time" — unlike a DexScreener pool's creation time, a token may be deployed well
 * before (or pool later on) a given pair.
 */
export async function fetchTokenCreationTimes(addresses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (addresses.length === 0) return out;
  await rateLimit("robinscan");
  try {
    const res = await fetch(
      `${RH_EXPLORER}/api?module=contract&action=getcontractcreation&contractaddresses=${addresses.join(",")}`,
      { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return out;
    const data = await res.json();
    const arr: Array<{ contractAddress?: string; timestamp?: string | number }> =
      Array.isArray(data?.result) ? data.result : [];
    for (const x of arr) {
      const addr = String(x.contractAddress ?? "").toLowerCase();
      const ts = parseInt(String(x.timestamp ?? ""), 10);
      if (addr && Number.isFinite(ts)) out.set(addr, ts);
    }
  } catch {
    /* ignore — callers fall back to pool time */
  }
  return out;
}

interface DexPair {
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  dexId?: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  liquidity?: { usd?: number };
  marketCap?: number;
  url?: string;
  info?: { imageUrl?: string };
}

// Standard quote/base currencies on Robinhood Chain — a pool of stock↔currency is
// the stock's own price pool, NOT a token launched against the stock.
const QUOTE_CURRENCIES = new Set([
  "USDG", "USDC", "USDT", "DAI", "WETH", "ETH", "WBTC", "BTC",
  "WBNB", "BNB", "FRAX", "PYUSD", "USD1", "USDE",
]);

/**
 * Return the tokens launched against a given stock — i.e. pools pairing the stock
 * with a NON-currency token. DexScreener's base/quote labeling is inconsistent
 * per stock (the stock can be labeled either side), so we identify the "other"
 * side by address and keep it only when it isn't a currency or another stock.
 * Deduped by token (earliest pool kept) and sorted oldest-first.
 *
 * Stats (price/liq/mc/image) are left null here because the stock's pairs report
 * the stock's metrics, not the launched token's — enrich via enrichCreatedToken.
 */
export async function fetchTokensCreatedAgainst(
  stockAddress: string,
  excludeAddresses?: Set<string>
): Promise<CreatedToken[]> {
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
    const excl = excludeAddresses ?? new Set<string>();

    const byToken = new Map<string, CreatedToken>();
    for (const p of pairs) {
      const baseAddr = (p.baseToken?.address ?? "").toLowerCase();
      const quoteAddr = (p.quoteToken?.address ?? "").toLowerCase();
      // The "other" token is whichever side isn't the stock.
      const other = baseAddr === stock ? p.quoteToken : quoteAddr === stock ? p.baseToken : null;
      const otherAddr = (other?.address ?? "").toLowerCase();
      if (!other || !otherAddr) continue;
      if (QUOTE_CURRENCIES.has((other.symbol ?? "").toUpperCase())) continue; // stock's own pool
      if (excl.has(otherAddr)) continue; // another stock, not a launch

      const created = p.pairCreatedAt ?? null;
      const ex = byToken.get(otherAddr);
      // keep the EARLIEST pool per token
      if (!ex || (created ?? Infinity) < (ex.pairCreatedAt ?? Infinity)) {
        byToken.set(otherAddr, {
          tokenAddress: other.address ?? "",
          symbol: other.symbol ?? "?",
          name: other.name ?? other.symbol ?? "",
          dexId: p.dexId ?? "",
          pairCreatedAt: created,
          onChainCreatedAt: null,
          priceUsd: null,
          liquidityUsd: null,
          marketCap: null,
          pairUrl: p.url ?? null,
          imageUrl: null,
        });
      }
    }

    const tokens = [...byToken.values()];
    // Resolve true on-chain deployment times and sort by them (oldest first).
    const times = await fetchTokenCreationTimes(tokens.map((t) => t.tokenAddress));
    for (const t of tokens) t.onChainCreatedAt = times.get(t.tokenAddress.toLowerCase()) ?? null;

    const launchKey = (t: CreatedToken): number =>
      t.onChainCreatedAt ?? (t.pairCreatedAt != null ? Math.floor(t.pairCreatedAt / 1000) : Number.MAX_SAFE_INTEGER);
    return tokens.sort((a, b) => launchKey(a) - launchKey(b));
  } catch {
    return [];
  }
}

/**
 * Fill in a launched token's real stats from its OWN highest-liquidity pool
 * (where it is the base token, so price/market cap are the token's, not the
 * stock's). Falls back to the deepest pool if it's never the base.
 */
export async function enrichCreatedToken(t: CreatedToken): Promise<CreatedToken> {
  await rateLimit("dexscreener");
  try {
    const res = await fetch(
      `https://api.dexscreener.com/token-pairs/v1/robinhood/${t.tokenAddress}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return t;
    const data = await res.json();
    const pairs: DexPair[] = Array.isArray(data) ? data : (data?.pairs ?? []);
    const self = t.tokenAddress.toLowerCase();
    const asBase = pairs.filter((p) => (p.baseToken?.address ?? "").toLowerCase() === self);
    const pool = (asBase.length ? asBase : pairs).sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0];
    if (!pool) return t;
    return {
      ...t,
      priceUsd: pool.priceUsd ? parseFloat(pool.priceUsd) : t.priceUsd,
      liquidityUsd: pool.liquidity?.usd ?? t.liquidityUsd,
      marketCap: pool.marketCap ?? t.marketCap,
      imageUrl: pool.info?.imageUrl ?? t.imageUrl,
      pairUrl: t.pairUrl ?? pool.url ?? null,
    };
  } catch {
    return t;
  }
}
