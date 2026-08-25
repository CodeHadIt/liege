import { rateLimit } from "@/lib/rate-limiter";

// ── o1 exchange on Base ──────────────────────────────────────────────────────
//
// o1 launches tokens against a paired asset and seeds a locked Uniswap v4 pool
// in one transaction. Same shape as StonkFun and the Robinhood-chain launchpads:
// a catalog of pairable stocks, and launches priced against them.
//
// Two hard constraints shaped this module, both discovered by probing:
//
//   1. launch.o1.exchange is behind a Vercel checkpoint. Every non-browser
//      request — HTML and JS assets alike — answers 429 "Vercel Security
//      Checkpoint", consistently and after cooldown. It cannot sit in a poller.
//   2. Its Convex backend is NOT protected. `exciting-fox-990.convex.cloud`
//      answers plain HTTP POSTs, and Base RPC is open.
//
// So nothing here touches the website. Launches come from Convex, and the stock
// catalog's live/dormant state is read on-chain.

export const O1_BASE_CHAIN_ID = 8453;
const CONVEX = "https://exciting-fox-990.convex.cloud/api/query";

/**
 * A Base Stock Token pairable on o1.
 *
 * Captured from o1's `contracts-*.js` bundle. It cannot be re-fetched at runtime
 * (see constraint 1), and the bundle's filename is content-hashed so it changes
 * on every o1 deploy — pinning the hash would rot. The list is therefore static,
 * and `pollO1BaseStocks` logs loudly when a launch appears against a quote that
 * is not here, so drift is visible rather than silent.
 *
 * All carry the `0xb2…` vanity prefix and 8 decimals. Prices are mirrored from
 * Robinhood Chain (`provider: "robinhood"`, `sourceNetworkId: 4663`).
 */
export interface O1Stock {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
}

export const O1_BASE_STOCKS: O1Stock[] = [
  { symbol: "AAPL", name: "Apple Inc.", address: "0xb200000000000000000000c2e324d24d7eecd1fb", decimals: 8 },
  { symbol: "AMZN", name: "Amazon.com Inc.", address: "0xb200000000000000000000d9192b6b456483c2e8", decimals: 8 },
  { symbol: "COIN", name: "Coinbase Global Inc.", address: "0xb200000000000000000000c85a31389d71f3ecfb", decimals: 8 },
  { symbol: "GOOGL", name: "Alphabet Inc.", address: "0xb2000000000000000000002d0ba3164cc74f58b7", decimals: 8 },
  { symbol: "META", name: "Meta Platforms Inc.", address: "0xb2000000000000000000008bc8786b856e61707c", decimals: 8 },
  { symbol: "MSTR", name: "Strategy Inc.", address: "0xb2000000000000000000004884b426556b92883d", decimals: 8 },
  { symbol: "NVDA", name: "NVIDIA Corporation", address: "0xb20000000000000000000078ee7ce2fe4908108c", decimals: 8 },
  { symbol: "SNDK", name: "Sandisk Corporation", address: "0xb200000000000000000000397293cb8cda9a10c5", decimals: 8 },
  { symbol: "SPCX", name: "Space Exploration Technologies Corp.", address: "0xb2000000000000000000007b9fcbd005511acbd5", decimals: 8 },
  { symbol: "TSLA", name: "Tesla Inc.", address: "0xb2000000000000000000001e800a7f5189430cd0", decimals: 8 },
];

/** Crypto quotes, which are not stocks and are never announced as new pairs. */
export const O1_BASE_CRYPTO_QUOTES = new Set([
  "0x0000000000000000000000000000000000000000", // ETH
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
]);

export function o1StockByAddress(address: string): O1Stock | null {
  const a = address.toLowerCase();
  return O1_BASE_STOCKS.find((s) => s.address === a) ?? null;
}

// ── Convex ───────────────────────────────────────────────────────────────────

async function convex<T>(path: string, args: Record<string, unknown>): Promise<T | null> {
  await rateLimit("o1");
  try {
    const res = await fetch(CONVEX, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    // Convex answers 200 with {status:"error"} for a bad call, so the HTTP code
    // alone does not tell you whether it worked.
    if (j?.status !== "success") {
      console.error(`[o1] ${path} failed: ${String(j?.errorMessage ?? "unknown").slice(0, 160)}`);
      return null;
    }
    return j.value as T;
  } catch {
    return null;
  }
}

export interface O1Launch {
  tokenAddress: string;
  name: string;
  symbol: string;
  quoteAddress: string;
  quoteSymbol: string;
  /** Epoch ms. */
  createdAt: number;
  creator: string | null;
  imageUrl: string | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
}

interface FeedRow {
  launch?: Record<string, unknown>;
  stats?: Record<string, unknown>;
}

/**
 * Newest launches on Base, newest first.
 *
 * `tab: "new"` is what makes this usable — the default "trending" tab reorders by
 * activity, which is meaningless for detecting arrivals.
 *
 * Each record names `quoteAddress` and `quoteSymbol` alongside the token, so the
 * pairing is exact and atomic. No pool lookup, no retry queue — the same
 * property that made StonkFun's feed reliable.
 *
 * Returns null on failure rather than an empty array, so a caller cannot mistake
 * a dead fetch for "nothing launched" and advance past a gap.
 */
export async function fetchO1BaseLaunches(limit = 24): Promise<O1Launch[] | null> {
  const v = await convex<{ page?: FeedRow[] }>("dashboard:feedPage", {
    chainId: O1_BASE_CHAIN_ID,
    marketScope: "all",
    paginationOpts: { cursor: null, id: 1, numItems: limit },
    search: "",
    tab: "new",
  });
  if (!v) return null;

  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  const str = (x: unknown): string | null =>
    typeof x === "string" && x.length > 0 ? x : null;

  const out: O1Launch[] = [];
  for (const row of v.page ?? []) {
    const l = row.launch ?? {};
    const s = row.stats ?? {};
    const tokenAddress = str(l.tokenAddress);
    const quoteAddress = str(l.quoteAddress);
    const createdAt = num(l.createdAt);
    if (!tokenAddress || !quoteAddress || createdAt == null) continue;
    out.push({
      tokenAddress: tokenAddress.toLowerCase(),
      name: str(l.name) ?? str(l.symbol) ?? "Unknown",
      symbol: str(l.symbol) ?? "?",
      quoteAddress: quoteAddress.toLowerCase(),
      quoteSymbol: str(l.quoteSymbol) ?? "?",
      createdAt,
      creator: str(l.creator),
      imageUrl: str(l.imageUrl),
      marketCapUsd: num(s.marketCapUsd),
      liquidityUsd: num(s.poolLiquidityUsd),
      priceUsd: num(s.tokenPriceUsd),
    });
  }
  return out;
}

// ── Base RPC ─────────────────────────────────────────────────────────────────

const BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
];
let rpcCursor = 0;
const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";

async function baseRpc(method: string, params: unknown[]): Promise<unknown> {
  for (let i = 0; i < BASE_RPCS.length * 2; i++) {
    const url = BASE_RPCS[rpcCursor % BASE_RPCS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const j = await res.json();
        if (j?.result !== undefined) return j.result;
      }
    } catch {
      /* rotate */
    }
    rpcCursor++;
  }
  return null;
}

/**
 * Circulating supply of each catalog stock, in whole tokens.
 *
 * This is the liveness signal. Every one of the ten Base Stock Tokens is already
 * DEPLOYED and every one has a fresh price, so neither bytecode nor price
 * separates a pairable stock from a dormant one — measured, all ten pass both.
 * What separates them is supply: exactly the four with non-zero supply (AAPL,
 * GOOGL, META, NVDA) are the four o1's launch form offers.
 *
 * Absent from the map means the call failed — never silently zero, which would
 * read as "went dormant" and could fire a spurious transition.
 */
export async function fetchO1StockSupplies(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const s of O1_BASE_STOCKS) {
    const raw = await baseRpc("eth_call", [{ to: s.address, data: SELECTOR_TOTAL_SUPPLY }, "latest"]);
    if (typeof raw !== "string" || raw === "0x") continue;
    try {
      out.set(s.address, Number(BigInt(raw)) / 10 ** s.decimals);
    } catch {
      /* unparseable — leave absent */
    }
  }
  return out;
}
