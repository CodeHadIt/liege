import { rateLimit } from "@/lib/rate-limiter";

// OpenSea indexes Robinhood Chain, and its per-collection v2 endpoints are
// public — no API key. (The chain-filtered LIST endpoint does require one, which
// is easy to mistake for the whole API being gated.)
//
// This gives a real floor — the lowest current ask — rather than the lowest
// recent fill we can derive from chain data. The two are not the same: a fill
// floor reads low after someone dumps, and reads stale when nothing has traded.
const OS = "https://api.opensea.io/api/v2";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Our chain ids → OpenSea's chain slugs. */
const CHAIN_SLUG: Record<string, string> = {
  rh: "robinhood",
  ethereum: "ethereum",
  base: "base",
  bsc: "bsc",
};

export interface OpenSeaCollectionStats {
  slug: string;
  name: string | null;
  /** lowest current ask, in the chain's native token */
  floorNative: number | null;
  floorSymbol: string | null;
  volumeNative: number | null;
  sales: number | null;
  owners: number | null;
  url: string;
}

async function osFetch<T>(path: string): Promise<T | null> {
  await rateLimit("opensea");
  try {
    const res = await fetch(`${OS}${path}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Resolve a contract to its OpenSea collection slug. */
export async function getOpenSeaSlug(chain: string, address: string): Promise<string | null> {
  const slug = CHAIN_SLUG[chain.toLowerCase()];
  if (!slug) return null;
  const d = await osFetch<{ collection?: string }>(`/chain/${slug}/contract/${address.toLowerCase()}`);
  return d?.collection ?? null;
}

/**
 * Floor and headline stats for an NFT collection. Returns null when OpenSea
 * doesn't know the contract, so callers can fall back to on-chain data.
 */
export async function getOpenSeaCollectionStats(
  chain: string,
  address: string
): Promise<OpenSeaCollectionStats | null> {
  const slug = await getOpenSeaSlug(chain, address);
  if (!slug) return null;

  const stats = await osFetch<{
    total?: {
      volume?: number;
      sales?: number;
      num_owners?: number;
      floor_price?: number;
      floor_price_symbol?: string;
    };
  }>(`/collections/${slug}/stats`);
  if (!stats?.total) return null;

  const t = stats.total;
  const name = await osFetch<{ name?: string }>(`/collections/${slug}`);
  return {
    slug,
    name: name?.name ?? null,
    // A collection with nothing listed reports 0 — that's "no asks", not a
    // floor of zero, so it's normalised away rather than shown as free.
    floorNative: t.floor_price && t.floor_price > 0 ? t.floor_price : null,
    floorSymbol: t.floor_price_symbol ?? null,
    volumeNative: t.volume ?? null,
    sales: t.sales ?? null,
    owners: t.num_owners ?? null,
    url: `https://opensea.io/collection/${slug}`,
  };
}
