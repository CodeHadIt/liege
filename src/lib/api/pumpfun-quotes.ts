/**
 * Pump.fun quote-asset catalog and launch feed.
 *
 * Pump.fun's /create page lets a creator pick the asset their coin is paired
 * against. Unlike StonkFun, Flap or Four.meme there is no HTTP endpoint that
 * serves that catalog — the page is client-rendered and every plausible API
 * route (/quote-tokens, /pairs, /config, /coins/quote-mints …) 404s. The
 * frontend bundle showed why: the list is not fetched at all, it is read from
 * the chain into a `supportedCurrencies` array on a `globalConfig` PDA.
 *
 * The pump program publishes its Anchor IDL on-chain, which settles the layout
 * exactly rather than by inference:
 *
 *   program        6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *   Global PDA     seeds ["global"] -> 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf
 *   field          Global.whitelisted_quote_mints
 *   instructions   add_quote_mint / remove_quote_mint
 *
 * Summing the field sizes ahead of it puts `whitelisted_quote_mints` at byte
 * 1013, and the live account is exactly 1045 bytes with USDC occupying the final
 * 32 — so the computed offset is confirmed against real data, not just the IDL.
 *
 * Reading the account directly (rather than watching add_quote_mint calls) means
 * the catalog is a single getAccountInfo with no history to replay, and a
 * restart re-reads the truth instead of reconstructing it.
 */
import { rateLimit } from "@/lib/rate-limiter";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/** PDA of the pump program's Global account — seeds ["global"]. */
export const PUMP_GLOBAL_PDA = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";

/**
 * Byte offset of Global.whitelisted_quote_mints.
 *
 * Derived from the on-chain IDL by summing every preceding field after the
 * 8-byte Anchor discriminator, and cross-checked against the live account.
 */
export const QUOTE_MINTS_OFFSET = 1013;

export const PUMP_CREATE_URL = "https://pump.fun/create";

/**
 * Assets that are the pre-existing baseline, not a new listing.
 *
 * The whitelist is seeded from whatever is live on the first poll, so these
 * would normally never be announced anyway. Naming them explicitly means a
 * redeploy can't announce the stablecoin baseline as a fresh listing — while a
 * genuine stock quote, which by definition is not in this set, still alerts.
 *
 * SOL appears in the launch feed under two spellings: the system-program
 * sentinel (native SOL) and the wrapped-SOL mint. Both are baseline.
 */
export const SOL_SENTINEL = "11111111111111111111111111111111";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const BASELINE_QUOTE_MINTS = new Set([
  SOL_SENTINEL,
  WSOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
]);

/** Symbols for the baseline assets, so the feed can name them without a lookup. */
const KNOWN_SYMBOLS: Record<string, { symbol: string; name: string }> = {
  [SOL_SENTINEL]: { symbol: "SOL", name: "Solana" },
  [WSOL_MINT]: { symbol: "SOL", name: "Wrapped SOL" },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD" },
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: { symbol: "USD1", name: "World Liberty Financial USD" },
};

const METAPLEX_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/**
 * RPC endpoints to try in order.
 *
 * Helius first when it's configured, then the public endpoint. The fallback is
 * not decoration: Helius returns HTTP 429 "max usage reached" once the account's
 * credits are spent, and with a single endpoint the catalog read would then fail
 * indefinitely — the whole feature going quiet while looking healthy. Both calls
 * this module makes (getAccountInfo on two known accounts) are light enough for
 * the public node, which is why the fallback is viable here even though the
 * heavier readers elsewhere in the codebase depend on Helius.
 */
function rpcEndpoints(): string[] {
  const endpoints: string[] = [];
  const url = process.env.HELIUS_RPC_URL;
  if (url && !url.endsWith("api-key=")) endpoints.push(url);
  else if (process.env.HELIUS_API_KEY) {
    endpoints.push(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);
  }
  endpoints.push("https://api.mainnet-beta.solana.com");
  return endpoints;
}

/**
 * Raw account data.
 *
 * Returns null only when no endpoint could answer. An account that genuinely
 * doesn't exist also reads as null, which is fine for both callers here: the
 * Global account always exists, and a missing metadata account just falls
 * through to the next naming source.
 */
async function getAccountData(pubkey: string): Promise<Buffer | null> {
  for (const endpoint of rpcEndpoints()) {
    await rateLimit("helius");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [pubkey, { encoding: "base64" }],
        }),
      });
      // Rate limited or over quota — try the next endpoint rather than give up.
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.error) continue;
      const value = json?.result?.value;
      // A successful response with no account is an answer, not a failure.
      if (!value) return null;
      if (!value?.data?.[0]) return null;
      return Buffer.from(value.data[0], "base64");
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The quote mints pump.fun currently allows new coins to be paired against.
 *
 * Returns null — never an empty array — when the account can't be read. The
 * difference matters: a caller that treats a failed read as "the list is empty"
 * would first alert on every quote as removed, then re-alert on all of them as
 * newly added the moment the node recovers.
 *
 * The field is a fixed-size array in the current IDL ([pubkey; 1]), but the
 * program has an `extend_account` instruction, so adding a quote grows the
 * account. Everything from the offset to the end of the account is therefore
 * parsed, rather than a hardcoded element count — a longer array is picked up
 * automatically instead of being silently truncated to the first entry.
 */
export async function fetchWhitelistedQuoteMints(): Promise<string[] | null> {
  const data = await getAccountData(PUMP_GLOBAL_PDA);
  if (!data) return null;
  if (data.length < QUOTE_MINTS_OFFSET + 32) {
    console.error(
      `[pumpfun] Global account is ${data.length} bytes, expected at least ${QUOTE_MINTS_OFFSET + 32} — layout may have changed`
    );
    return null;
  }

  const { PublicKey } = await import("@solana/web3.js");
  const mints: string[] = [];
  for (let off = QUOTE_MINTS_OFFSET; off + 32 <= data.length; off += 32) {
    const slot = data.subarray(off, off + 32);
    // An unused slot is the all-zero pubkey; skip rather than report it.
    if (slot.every((b) => b === 0)) continue;
    mints.push(new PublicKey(slot).toBase58());
  }
  return mints;
}

export interface QuoteMintMeta {
  mint: string;
  symbol: string;
  name: string;
}

/**
 * Name a quote mint.
 *
 * Metaplex metadata is read from the chain first and an indexer only consulted
 * as a fallback. That ordering is deliberate: a stock quote is interesting on
 * the day it lists, which is exactly when a third-party token list is least
 * likely to know about it, whereas its metadata account exists from mint.
 */
export async function fetchQuoteMintMeta(mint: string): Promise<QuoteMintMeta> {
  const known = KNOWN_SYMBOLS[mint];
  if (known) return { mint, ...known };

  const onchain = await fetchMetaplexMeta(mint);
  if (onchain) return { mint, ...onchain };

  const jup = await fetchJupiterMeta(mint);
  if (jup) return { mint, ...jup };

  const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  return { mint, symbol: short, name: short };
}

async function fetchMetaplexMeta(mint: string): Promise<{ symbol: string; name: string } | null> {
  const pda = await metadataPda(mint);
  if (!pda) return null;
  const data = await getAccountData(pda);
  if (!data || data.length < 1 + 32 + 32 + 4) return null;
  try {
    // key(1) + update_authority(32) + mint(32), then borsh strings.
    let off = 1 + 32 + 32;
    const readString = (): string => {
      const len = data.readUInt32LE(off);
      off += 4;
      if (len > 512 || off + len > data.length) throw new Error("bad string length");
      const s = data.subarray(off, off + len).toString("utf8");
      off += len;
      // Metaplex pads these to a fixed width with NULs.
      return s.replace(/\0+$/, "").trim();
    };
    const name = readString();
    const symbol = readString();
    if (!symbol && !name) return null;
    return { symbol: symbol || name, name: name || symbol };
  } catch {
    return null;
  }
}

async function fetchJupiterMeta(mint: string): Promise<{ symbol: string; name: string } | null> {
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
    if (!res.ok) return null;
    const json = await res.json();
    const hit = Array.isArray(json) ? json.find((t) => t?.id === mint || t?.address === mint) : null;
    if (!hit?.symbol) return null;
    return { symbol: hit.symbol, name: hit.name || hit.symbol };
  } catch {
    return null;
  }
}

/**
 * Metaplex metadata PDA: ["metadata", metaplex_program, mint].
 *
 * Uses @solana/web3.js, which is already a dependency, rather than
 * reimplementing off-curve PDA derivation.
 */
async function metadataPda(mint: string): Promise<string | null> {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const program = new PublicKey(METAPLEX_PROGRAM);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), program.toBuffer(), new PublicKey(mint).toBuffer()],
      program
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}

// ── Launch feed ──────────────────────────────────────────────────────────────

export interface PumpCoin {
  mint: string;
  name: string;
  symbol: string;
  quoteMint: string | null;
  createdTimestamp: number; // ms
  creator: string | null;
  imageUrl: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  marketCapUsd: number | null;
  bondingCurve: string | null;
}

const PUMP_API = "https://frontend-api-v3.pump.fun";

/**
 * Server-side cap on /coins. Asking for more returns 70, so paging is the only
 * way past it.
 */
const PAGE_SIZE = 70;

/**
 * Recently created pump.fun coins, newest first.
 *
 * There is no server-side filter for the quote mint — every spelling of the
 * parameter (quoteMint, quote_mint, quoteMints, quote) is ignored and the
 * response comes back all-SOL — so the feed is pulled and filtered here.
 *
 * That is affordable because the firehose is slower than it looks: measured at
 * ~21 coins/minute, one 70-coin page covers a little over three minutes. Polling
 * every 60s therefore carries roughly 3x headroom, and `pages` extends that if a
 * burst or a stalled poller ever outruns a single page.
 *
 * Returns null on failure so a caller can hold its cursor rather than mistake an
 * outage for a quiet minute.
 */
export async function fetchRecentPumpCoins(pages = 1): Promise<PumpCoin[] | null> {
  const out: PumpCoin[] = [];
  for (let page = 0; page < pages; page++) {
    await rateLimit("pumpfun");
    let batch: unknown;
    try {
      const res = await fetch(
        `${PUMP_API}/coins?offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}` +
          `&sort=created_timestamp&order=DESC&includeNsfw=true`,
        {
          headers: {
            // The API rejects requests that don't look like the site.
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
            Origin: "https://pump.fun",
            Referer: "https://pump.fun/",
          },
        }
      );
      if (!res.ok) return out.length > 0 ? out : null;
      batch = await res.json();
    } catch {
      return out.length > 0 ? out : null;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const raw of batch) out.push(normaliseCoin(raw as Record<string, unknown>));
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

function normaliseCoin(c: Record<string, unknown>): PumpCoin {
  const str = (k: string): string | null => {
    const v = c[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const num = (k: string): number | null => {
    const v = c[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return {
    mint: String(c.mint ?? ""),
    name: str("name") ?? "Unknown",
    symbol: str("symbol") ?? "?",
    // Older coins predate the field entirely; absent means SOL-quoted.
    quoteMint: str("quote_mint"),
    createdTimestamp: num("created_timestamp") ?? 0,
    creator: str("creator"),
    imageUrl: str("image_uri"),
    website: str("website"),
    twitter: str("twitter"),
    telegram: str("telegram"),
    marketCapUsd: num("usd_market_cap") ?? num("market_cap_usd"),
    bondingCurve: str("bonding_curve"),
  };
}

/** True when a coin's quote is one of the assets we're watching. */
export function coinQuoteMint(coin: PumpCoin): string {
  return coin.quoteMint ?? SOL_SENTINEL;
}
