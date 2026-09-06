import { rateLimit } from "@/lib/rate-limiter";

// StonkFun is a custodial launchpad on Solana — every token is minted by this
// single platform deployer wallet (like pump.fun's factory). A "new token" is a
// TOKEN_MINT transaction from this address that mints ~1B of a fresh mint.
export const STONKFUN_DEPLOYER = "5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG";

const STANDARD_SUPPLY = 1_000_000_000;

export const STONKFUN_BASE = "https://www.stonkfun.xyz";

/**
 * A realistic browser user-agent.
 *
 * Every request here used a bare "Mozilla/5.0". Both StonkFun feeds stopped
 * returning data on 2026-09-03 while every other source kept working, which is
 * the signature of bot filtering rather than an outage. The modules that stayed
 * up (Flap, Robinhood) all send a full UA string, so this matches them.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": UA,
  Referer: `${STONKFUN_BASE}/`,
  Origin: STONKFUN_BASE,
};

/** A quote token = an asset you can pair a new StonkFun launch against. */
export interface QuoteToken {
  quoteMint: string;
  symbol: string;
  name: string;
  decimals: number;
  category: string;
  logoUrl: string | null;
}

/**
 * Fetch the current list of quote tokens available on the StonkFun launch page.
 * Backed by the site's own public JSON API (no scraping needed).
 */
export async function fetchQuoteTokens(): Promise<QuoteToken[] | null> {
  await rateLimit("stonkfun");
  try {
    const res = await fetch(`${STONKFUN_BASE}/api/quote-tokens`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[stonkfun] quote-tokens ${res.status} — quote feed is BLIND this pass`);
      return null;
    }
    const data = await res.json();
    const list: unknown[] = Array.isArray(data?.quoteTokens) ? data.quoteTokens : [];
    return list
      .map((t) => {
        const q = t as Record<string, unknown>;
        const logo = typeof q.logoUrl === "string" ? q.logoUrl : null;
        return {
          quoteMint: String(q.quoteMint ?? ""),
          symbol: String(q.symbol ?? "?"),
          name: String(q.name ?? ""),
          decimals: typeof q.decimals === "number" ? q.decimals : 0,
          category: String(q.category ?? "other"),
          // logoUrl comes back relative (e.g. /api/asset/quote-logo/…)
          logoUrl: logo ? (logo.startsWith("http") ? logo : `${STONKFUN_BASE}${logo}`) : null,
        };
      })
      .filter((q) => q.quoteMint.length > 0);
  } catch (err) {
    // null, not []. An unreachable API and an empty catalog are different facts,
    // and conflating them is why a two-day outage looked like "nothing new".
    console.error(`[stonkfun] quote-tokens failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * A launch as StonkFun itself reports it, from its own `/api/launches` feed.
 *
 * This is a far stronger source than reconstructing launches from the deployer's
 * mint transactions, for one reason above all: **it names the quote mint
 * directly**, in the same record as the token. No pool to wait for, no deepest-
 * pool inference, no ambiguity when a token later picks up a deeper SOL pool.
 *
 * It also catches launches the mint-based detector cannot see at all. Tokens
 * launched against RAY produce no `TOKEN_MINT` transaction from the deployer —
 * the supply arrives via Raydium SWAPs (a 900M and a 100M leg) — so
 * `fetchRecentCreations` never surfaces them. Verified against
 * FELbdqrBvrhRA7214SiGCktyoAeH2nZEnwnQFDH8uYW9 ($713), which is absent from the
 * deployer's TOKEN_MINT history but present here with quoteMint = RAY.
 */
export interface StonkFunLaunch {
  mint: string;
  pool: string | null;
  quoteMint: string;
  quoteSymbol: string;
  name: string;
  symbol: string;
  creator: string | null;
  logoUrl: string | null;
  launchpad: string | null;
  startMarketCapUsd: number | null;
  /** ISO timestamp */
  createdAt: string;
}

/**
 * One launch record, from either feed shape.
 *
 * The public API nests the quote (`quote.mint`), the internal one flattens it
 * (`quoteMint`). Both are accepted so the parser is not a second thing to change
 * if the source moves again.
 */
function parseLaunch(raw: unknown): StonkFunLaunch | null {
  const l = raw as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof l[k] === "string" && (l[k] as string).length > 0 ? (l[k] as string) : null;
  const quote = (l.quote ?? {}) as Record<string, unknown>;
  const qs = (k: string): string | null =>
    typeof quote[k] === "string" && (quote[k] as string).length > 0 ? (quote[k] as string) : null;

  const out: StonkFunLaunch = {
    mint: String(l.mint ?? ""),
    pool: str("pool"),
    quoteMint: String(l.quoteMint ?? qs("mint") ?? ""),
    quoteSymbol: str("quoteSymbol") ?? qs("symbol") ?? "?",
    name: str("name") ?? str("symbol") ?? "Unknown",
    symbol: str("symbol") ?? "?",
    creator: str("creator"),
    logoUrl: str("logoUrl"),
    launchpad: str("launchpad"),
    startMarketCapUsd:
      typeof l.startMarketCapUsd === "number" && Number.isFinite(l.startMarketCapUsd)
        ? (l.startMarketCapUsd as number)
        : null,
    createdAt: String(l.createdAt ?? ""),
  };
  if (!out.mint || !out.quoteMint || !out.createdAt) return null;
  return out;
}

/**
 * StonkFun launches, newest first, from the **public** API.
 *
 * Returns null on failure rather than an empty array: a caller that treats a
 * failed fetch as "nothing launched" would advance its cursor over the gap and
 * lose every launch in it.
 *
 * This reads `/api/public/v1/launches` rather than the internal `/api/launches`.
 * Both are served from the same ledger — compared over an 18.9h overlap they
 * agreed on all 100 records, in both directions — but only the public one
 * supports `since` and real pagination, which is what allows a watcher to resume
 * after downtime instead of silently swallowing the gap.
 *
 * `since` is INCLUSIVE: passing the newest known timestamp returns that record
 * again, so callers must still dedupe on mint.
 */
export async function fetchStonkFunLaunches(
  opts: { since?: string | null; maxPages?: number } = {}
): Promise<StonkFunLaunch[] | null> {
  const { since = null, maxPages = 10 } = opts;
  const out: StonkFunLaunch[] = [];
  const seen = new Set<string>();
  let totalPages = 1;

  for (let page = 1; page <= totalPages && page <= maxPages; page++) {
    await rateLimit("stonkfun");
    const url = new URL(`${STONKFUN_BASE}/api/public/v1/launches`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("page", String(page));
    if (since) url.searchParams.set("since", since);

    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      totalPages = Number(data?.data?.pagination?.totalPages) || 1;
      const list: unknown[] = Array.isArray(data?.data?.launches) ? data.data.launches : [];
      if (list.length === 0) break;

      let added = 0;
      for (const raw of list) {
        const l = parseLaunch(raw);
        if (!l || seen.has(l.mint)) continue;
        seen.add(l.mint);
        out.push(l);
        added++;
      }
      // An out-of-range page serves page 1 again rather than an empty list, so
      // a pass that adds nothing new means we are looping, not paginating.
      if (added === 0) break;
    } catch {
      return null;
    }
  }
  return out;
}

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
 *
 * The `type=TOKEN_MINT` server-side filter is deliberately NOT used, despite
 * being the obvious way to ask this question. Helius answers that filter with
 * **HTTP 404** and `{"error":"Failed to find events within the search period"}`
 * whenever it can't fill the requested count inside its scan window — which for
 * this deployer is most of the time, since mints are sparse against a stream of
 * transfers and swaps. Combined with a `!res.ok` guard that returned an empty
 * array, an ordinary 404 was indistinguishable from "nothing launched", so the
 * feed went quiet at random. Observed directly: one call 404'd while the very
 * next unfiltered call showed a real mint.
 *
 * Fetching unfiltered and filtering here is deterministic — the raw endpoint
 * always answers 200.
 *
 * The trade-off is lookback depth. Measured at **10.4 tx/min** for this
 * deployer, 100 transactions covers roughly **10 minutes**, where the type
 * filter reached back hours. That is still large headroom for a 30s poll, and
 * `MAX_ALERT_AGE_SECONDS` (15 min) means anything older wouldn't be alerted on
 * anyway — but it does mean an outage longer than ~10 minutes can drop a launch
 * rather than catching up on restart.
 *
 * Note that returning zero here is usually correct, not a failure: genuine
 * launches are sparse (one in the last 1,200 transactions when this was
 * measured), while the deployer mints amount=1 utility tokens constantly. The
 * 1B supply check below is what separates them.
 */
export async function fetchRecentCreations(limit = 25): Promise<StonkFunCreation[]> {
  const key = heliusKey();
  if (!key) return [];
  await rateLimit("helius");
  try {
    // `limit` is the number of CREATIONS wanted; the raw stream needs a much
    // wider scan than that to contain them.
    const scan = Math.min(100, Math.max(limit * 4, 100));
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${STONKFUN_DEPLOYER}/transactions` +
        `?api-key=${key}&limit=${scan}`,
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
      if (out.length >= limit) break;
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

// ── Airdrop Mode ─────────────────────────────────────────────────────────────
// A launch option that holds a share of supply OUT of the pool and distributes
// it to holders of the quote token being paired against. Reward-mode launches
// only, capped at 50% of supply, with the recipient set snapshotted and frozen
// at quote time.
//
// Detection has to use the INTERNAL feed. The public ledger carries no airdrop
// flag and no airdrop filter, so the only alternative is one
// `/tokens/{mint}/airdrop` request per launch — 1,593 requests to cover a
// handful of days, which is not a polling strategy. The internal feed carries
// `airdropBps` inline on every record.

export interface StonkFunAirdropLaunch extends StonkFunLaunch {
  /** Basis points of supply airdropped. 5000 = 50%. Zero/absent = no airdrop. */
  airdropBps: number;
  /** Raw base units carved out of the pool. */
  airdropSupplyRaw: string | null;
  /**
   * Raw base units actually delivered. Runs a few units under `supplyRaw` on
   * most launches from rounding across recipients — that is expected, not a
   * failed drop.
   */
  airdropDeliveredRaw: string | null;
}

/**
 * Launches from StonkFun's internal feed, newest first, carrying airdrop fields.
 *
 * Returns null on failure rather than an empty array, so a caller cannot mistake
 * a dead fetch for "nothing launched" and advance past a gap.
 *
 * Capped at 100 records with no pagination — roughly 19 hours at current rates.
 * Fine for a 30s poller, useless for history.
 */
export async function fetchStonkFunInternalLaunches(): Promise<StonkFunAirdropLaunch[] | null> {
  await rateLimit("stonkfun");
  try {
    const res = await fetch(`${STONKFUN_BASE}/api/launches`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const list: unknown[] = Array.isArray(data?.launches) ? data.launches : [];
    const out: StonkFunAirdropLaunch[] = [];
    for (const raw of list) {
      const base = parseLaunch(raw);
      if (!base) continue;
      const l = raw as Record<string, unknown>;
      out.push({
        ...base,
        airdropBps: typeof l.airdropBps === "number" ? l.airdropBps : 0,
        airdropSupplyRaw: l.airdropSupplyRaw != null ? String(l.airdropSupplyRaw) : null,
        airdropDeliveredRaw: l.airdropDeliveredRaw != null ? String(l.airdropDeliveredRaw) : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

export interface StonkFunAirdropDetail {
  bps: number;
  percentOfSupply: number;
  supplyTokens: number | null;
  source: string | null;
  recipientCount: number | null;
  quoteSymbol: string | null;
  settledAt: string | null;
}

/**
 * Full airdrop detail for one mint, or null if it launched without one.
 *
 * Best-effort enrichment only: it names the recipient count and tier, which the
 * feed does not carry. An alert must never wait on it.
 */
export async function fetchStonkFunAirdrop(mint: string): Promise<StonkFunAirdropDetail | null> {
  await rateLimit("stonkfun");
  try {
    const res = await fetch(`${STONKFUN_BASE}/api/public/v1/tokens/${mint}/airdrop`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const a = (await res.json())?.data?.airdrop;
    if (!a) return null;
    return {
      bps: Number(a.bps) || 0,
      percentOfSupply: Number(a.percentOfSupply) || 0,
      supplyTokens: a.supplyTokens != null ? Number(a.supplyTokens) : null,
      source: a.source ?? null,
      recipientCount: a.recipientCount != null ? Number(a.recipientCount) : null,
      quoteSymbol: a.quoteToken?.symbol ?? null,
      settledAt: a.settledAt ?? null,
    };
  } catch {
    return null;
  }
}
