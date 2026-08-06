import { rateLimit } from "@/lib/rate-limiter";

// StonkFun is a custodial launchpad on Solana — every token is minted by this
// single platform deployer wallet (like pump.fun's factory). A "new token" is a
// TOKEN_MINT transaction from this address that mints ~1B of a fresh mint.
export const STONKFUN_DEPLOYER = "5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG";

const STANDARD_SUPPLY = 1_000_000_000;

export interface StonkFunCreation {
  mint: string;
  /** Best-effort symbol from the tx description; refined by DAS in enrichment */
  symbol: string;
  signature: string;
  /** unix seconds */
  timestamp: number;
}

export interface StonkFunTokenDetails extends StonkFunCreation {
  name: string;
  imageUrl: string | null;
  description: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  // Market / pairing — from DexScreener (null until the Raydium pool is indexed)
  pairedSymbol: string | null;
  pairedAddress: string | null;
  dex: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  pairUrl: string | null;
}

function heliusKey(): string {
  return process.env.HELIUS_API_KEY || "";
}

function heliusRpcUrl(): string {
  const url = process.env.HELIUS_RPC_URL;
  if (url && !url.endsWith("api-key=")) return url;
  const key = heliusKey();
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : "https://api.mainnet-beta.solana.com";
}

interface HeliusTokenTransfer {
  mint?: string;
  toUserAccount?: string;
  fromUserAccount?: string;
  tokenAmount?: number;
}
interface HeliusTx {
  type?: string;
  signature?: string;
  timestamp?: number;
  description?: string;
  tokenTransfers?: HeliusTokenTransfer[];
}

/**
 * Fetch the most recent StonkFun token creations (newest first) by reading the
 * deployer's TOKEN_MINT transactions from the Helius enhanced API.
 */
export async function fetchRecentCreations(limit = 25): Promise<StonkFunCreation[]> {
  const key = heliusKey();
  if (!key) return [];
  await rateLimit("helius");
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${STONKFUN_DEPLOYER}/transactions` +
        `?api-key=${key}&type=TOKEN_MINT&limit=${limit}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];

    const out: StonkFunCreation[] = [];
    for (const tx of data as HeliusTx[]) {
      if (tx?.type !== "TOKEN_MINT") continue;
      const transfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
      // A real StonkFun launch mints EXACTLY 1,000,000,000 of the new token to the
      // deployer. The deployer also does other TOKEN_MINTs (fee/utility mints with
      // odd amounts, no metadata, no pool) — requiring the standard 1B supply
      // filters those out so we only alert on genuine launches.
      const minted = transfers.find(
        (t) =>
          t?.mint &&
          t.toUserAccount === STONKFUN_DEPLOYER &&
          (t.tokenAmount ?? 0) >= STANDARD_SUPPLY * 0.999 &&
          (t.tokenAmount ?? 0) <= STANDARD_SUPPLY * 1.001
      );
      const mint = minted?.mint;
      if (!mint || !tx.signature) continue;

      // description looks like: "5CEbue… minted 1000000000.00 ASSDAQ."
      const m = /minted\s+[\d.,]+\s+(.+?)\.?\s*$/.exec(tx.description || "");
      const symbol = m?.[1]?.trim() || "?";

      out.push({ mint, symbol, signature: tx.signature, timestamp: tx.timestamp ?? 0 });
    }
    return out;
  } catch {
    return [];
  }
}

interface DasAsset {
  content?: {
    metadata?: { name?: string; symbol?: string };
    links?: { image?: string };
    json_uri?: string;
  };
}

/** Pull name/symbol/image + off-chain socials from Metaplex/DAS metadata. */
async function fetchAssetMeta(mint: string): Promise<{
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  description: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
}> {
  const blank = { name: null, symbol: null, imageUrl: null, description: null, website: null, twitter: null, telegram: null };
  await rateLimit("helius");
  try {
    const res = await fetch(heliusRpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
    });
    if (!res.ok) return blank;
    const json = await res.json();
    const asset: DasAsset = json?.result ?? {};
    const meta = asset.content?.metadata ?? {};
    let imageUrl = asset.content?.links?.image ?? null;
    let description: string | null = null;
    let website: string | null = null;
    let twitter: string | null = null;
    let telegram: string | null = null;

    const jsonUri = asset.content?.json_uri;
    if (jsonUri) {
      try {
        const jr = await fetch(jsonUri, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8_000) });
        if (jr.ok) {
          const j = await jr.json();
          description = j.description ?? null;
          imageUrl = imageUrl ?? j.image ?? null;
          const ext = j.extensions ?? {};
          website  = j.website  ?? ext.website  ?? j.external_url ?? null;
          twitter  = j.twitter  ?? ext.twitter  ?? ext.x ?? null;
          telegram = j.telegram ?? ext.telegram ?? null;
        }
      } catch { /* off-chain json optional */ }
    }

    return {
      name: meta.name ?? null,
      symbol: meta.symbol ?? null,
      imageUrl,
      description,
      website,
      twitter,
      telegram,
    };
  } catch {
    return blank;
  }
}

interface DexPair {
  dexId?: string;
  url?: string;
  priceUsd?: string;
  marketCap?: number;
  liquidity?: { usd?: number };
  quoteToken?: { symbol?: string; address?: string };
}

/** Resolve the Raydium pairing + liquidity via DexScreener (top pool by liquidity). */
async function fetchMarket(mint: string): Promise<{
  pairedSymbol: string | null;
  pairedAddress: string | null;
  dex: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  pairUrl: string | null;
}> {
  const blank = { pairedSymbol: null, pairedAddress: null, dex: null, priceUsd: null, liquidityUsd: null, marketCap: null, pairUrl: null };
  await rateLimit("dexscreener");
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return blank;
    const data: unknown = await res.json();
    const pairs: DexPair[] = Array.isArray(data) ? data : ((data as { pairs?: DexPair[] })?.pairs ?? []);
    if (pairs.length === 0) return blank;
    const top = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return {
      pairedSymbol: top.quoteToken?.symbol ?? null,
      pairedAddress: top.quoteToken?.address ?? null,
      dex: top.dexId ?? null,
      priceUsd: top.priceUsd ? parseFloat(top.priceUsd) : null,
      liquidityUsd: top.liquidity?.usd ?? null,
      marketCap: top.marketCap ?? null,
      pairUrl: top.url ?? null,
    };
  } catch {
    return blank;
  }
}

/**
 * Enrich a bare creation with metadata + market data. Retries the market lookup
 * once, since the Raydium pool is often indexed a few seconds after the mint.
 */
export async function enrichCreation(c: StonkFunCreation): Promise<StonkFunTokenDetails> {
  const [meta, market1] = await Promise.all([fetchAssetMeta(c.mint), fetchMarket(c.mint)]);
  let market = market1;
  if (!market.liquidityUsd) {
    await new Promise((r) => setTimeout(r, 5_000));
    const retry = await fetchMarket(c.mint);
    if (retry.liquidityUsd) market = retry;
  }
  return {
    ...c,
    symbol: meta.symbol || c.symbol,
    name: meta.name || c.symbol,
    imageUrl: meta.imageUrl,
    description: meta.description,
    website: meta.website,
    twitter: meta.twitter,
    telegram: meta.telegram,
    ...market,
  };
}
