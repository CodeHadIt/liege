import bs58 from "bs58";
import { rateLimit } from "@/lib/rate-limiter";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import { getTokenPairs } from "@/lib/api/dexscreener";
import { getOHLCV, getTokenOverview } from "@/lib/api/birdeye";

export interface DeployedToken {
  address: string;
  name: string;
  symbol: string;
  currentMcUsd: number;
  /** All-time-high MC. null if not computable. */
  highestMcUsd: number | null;
  createdAt: number | null;
}

const DEPLOYS_TTL = 300_000; // 5 minutes

// ── Solana ────────────────────────────────────────────────────────────────────

const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// Anchor discriminator for `create` instruction on pump.fun
const PUMP_CREATE_DISCRIMINATOR = Buffer.from("181ec828051c0777", "hex");
// Alternate older discriminator
const PUMP_CREATE_DISCRIMINATOR_ALT = Buffer.from("d6904cec5f8b31b4", "hex");

const HELIUS_RPC = () => {
  const k = process.env.HELIUS_API_KEY;
  return k ? `https://mainnet.helius-rpc.com/?api-key=${k}` : null;
};
const HELIUS_ENHANCED = () => {
  const k = process.env.HELIUS_API_KEY;
  return k ? `https://api.helius.xyz/v0/transactions?api-key=${k}` : null;
};

interface SignatureInfo { signature: string; blockTime: number | null }

async function getSignaturesPage(address: string, before?: string, limit = 1000): Promise<SignatureInfo[]> {
  const url = HELIUS_RPC();
  if (!url) return [];
  await rateLimit("helius");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [address, before ? { limit, before } : { limit }],
      }),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return j.result ?? [];
  } catch { return []; }
}

interface EnhancedInstr {
  programId: string;
  data?: string;
  accounts?: string[];
  parsed?: { type?: string; info?: { mint?: string } };
  innerInstructions?: EnhancedInstr[];
}

interface EnhancedTx {
  signature: string;
  timestamp: number;
  feePayer?: string;
  instructions?: EnhancedInstr[];
}

async function parseTransactionsBatch(signatures: string[]): Promise<EnhancedTx[]> {
  const url = HELIUS_ENHANCED();
  if (!url) return [];
  const out: EnhancedTx[] = [];
  const BATCH = 100;
  for (let i = 0; i < signatures.length; i += BATCH) {
    const slice = signatures.slice(i, i + BATCH);
    await rateLimit("helius");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: slice }),
      });
      if (!res.ok) continue;
      const arr = await res.json() as EnhancedTx[];
      out.push(...arr);
    } catch { /* skip batch */ }
  }
  return out;
}

function hasDiscriminator(dataB58: string, disc: Buffer): boolean {
  try {
    const bytes = Buffer.from(bs58.decode(dataB58));
    if (bytes.length < 8) return false;
    return bytes.subarray(0, 8).equals(disc);
  } catch { return false; }
}

function detectMintsInTx(tx: EnhancedTx, wallet: string): Array<{ mint: string; timestamp: number }> {
  const found: Array<{ mint: string; timestamp: number }> = [];
  const ts = tx.timestamp;
  // The fee payer of a pump.fun create is the deployer. We require it to be
  // the wallet we're scanning — that's the strongest signal of authorship.
  const isPayer = tx.feePayer === wallet;

  const walkAll = (ix: EnhancedInstr) => {
    // 1) Pump.fun `create` instruction (top-level OR inner via CPI).
    //    Account layout has the new mint at accounts[0].
    if (ix.programId === PUMP_FUN_PROGRAM && ix.data && isPayer) {
      const isCreate =
        hasDiscriminator(ix.data, PUMP_CREATE_DISCRIMINATOR) ||
        hasDiscriminator(ix.data, PUMP_CREATE_DISCRIMINATOR_ALT);
      if (isCreate) {
        const mint = ix.accounts?.[0];
        if (mint) found.push({ mint, timestamp: ts });
      }
    }

    // 2) Direct SPL token initializeMint where wallet is the fee payer.
    //    Catches non-launchpad SPL deployments.
    if (isPayer && (ix.parsed?.type === "initializeMint" || ix.parsed?.type === "initializeMint2")) {
      const mint = ix.parsed.info?.mint;
      if (mint) found.push({ mint, timestamp: ts });
    }

    for (const inner of ix.innerInstructions ?? []) walkAll(inner);
  };

  for (const ix of tx.instructions ?? []) walkAll(ix);
  return found;
}

/**
 * Find SPL token mints created by `walletAddress`.
 * Catches pump.fun launches and direct SPL token deployments.
 */
export async function findSolanaDeployedMints(
  walletAddress: string,
  opts: { maxSigs?: number } = {}
): Promise<Array<{ mint: string; timestamp: number | null }>> {
  const maxSigs = opts.maxSigs ?? 1000;

  const allSigs: SignatureInfo[] = [];
  let before: string | undefined;
  while (allSigs.length < maxSigs) {
    const page = await getSignaturesPage(walletAddress, before, Math.min(1000, maxSigs - allSigs.length));
    if (page.length === 0) break;
    allSigs.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  if (allSigs.length === 0) return [];

  // Use Helius Enhanced parser — 100 txs per call instead of 25 raw RPC
  const sigList = allSigs.map((s) => s.signature);
  const enhanced = await parseTransactionsBatch(sigList);

  const out = new Map<string, number>();
  for (const tx of enhanced) {
    const found = detectMintsInTx(tx, walletAddress);
    for (const f of found) if (!out.has(f.mint)) out.set(f.mint, f.timestamp);
  }
  return [...out.entries()].map(([mint, timestamp]) => ({ mint, timestamp }));
}

// ── EVM ───────────────────────────────────────────────────────────────────────

const MORALIS_CHAIN_ID: Record<string, string> = {
  eth: "0x1",
  bsc: "0x38",
  base: "0x2105",
};

interface MoralisWalletTx {
  hash: string;
  block_timestamp: string;
  to_address: string | null;
  receipt_contract_address: string | null;
  receipt_status: string;
}

/**
 * Find contracts directly deployed by an EVM address.
 *
 * Uses Moralis wallet history. Only catches DIRECT deploys (where `to == null`
 * and a receipt_contract_address is set). Does NOT catch launchpad-created
 * tokens (e.g. four.meme, pump.fun-on-BSC) because the deployer didn't directly
 * create the contract — the launchpad did.
 */
export async function findEvmDeployedContracts(
  chain: "eth" | "base" | "bsc",
  walletAddress: string,
  opts: { maxPages?: number } = {}
): Promise<Array<{ address: string; timestamp: number }>> {
  const key = process.env.MORALIS_API_KEY;
  if (!key) return [];
  const moralisChain = MORALIS_CHAIN_ID[chain];
  if (!moralisChain) return [];

  const maxPages = opts.maxPages ?? 5;
  const addr = walletAddress.toLowerCase();
  const out: Array<{ address: string; timestamp: number }> = [];

  let cursor: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    await rateLimit("moralis");
    const url = new URL(`https://deep-index.moralis.io/api/v2.2/wallets/${addr}/history`);
    url.searchParams.set("chain", moralisChain);
    url.searchParams.set("limit", "100");
    url.searchParams.set("order", "ASC");
    if (cursor) url.searchParams.set("cursor", cursor);

    try {
      const res = await fetch(url.toString(), {
        headers: { "X-API-Key": key, Accept: "application/json" },
      });
      if (!res.ok) break;
      const j = await res.json();
      const txs = (j.result ?? []) as MoralisWalletTx[];
      for (const tx of txs) {
        if (tx.receipt_status !== "1") continue;
        const created = tx.receipt_contract_address;
        if (!created) continue;
        if (tx.to_address && tx.to_address !== "" && tx.to_address.toLowerCase() !== addr) continue;
        const ts = Math.floor(new Date(tx.block_timestamp).getTime() / 1000);
        out.push({ address: created.toLowerCase(), timestamp: ts });
      }
      cursor = j.cursor ?? undefined;
      if (!cursor) break;
    } catch { break; }
  }
  return out;
}

// ── Enrichment ───────────────────────────────────────────────────────────────

const DEX_CHAIN: Record<string, string> = {
  solana: "solana",
  eth: "ethereum",
  base: "base",
  bsc: "bsc",
};

async function enrichWithDexScreener(
  chain: "solana" | "eth" | "base" | "bsc",
  candidates: Array<{ address: string; timestamp: number | null }>
): Promise<DeployedToken[]> {
  const dexChain = DEX_CHAIN[chain];
  const results = await Promise.allSettled(
    candidates.map(async (c) => {
      const pairs = await getTokenPairs(dexChain, c.address);
      if (pairs.length === 0) return null;
      // Choose pair with highest liquidity, prefer matching chain
      const matching = pairs.filter((p) => p.chainId === dexChain || (dexChain === "ethereum" && p.chainId === "eth"));
      const best = (matching.length > 0 ? matching : pairs).sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      )[0];
      const mc = best.marketCap ?? best.fdv ?? 0;
      const pairCreated = best.pairCreatedAt ? Math.floor(best.pairCreatedAt / 1000) : null;
      return {
        address: c.address,
        name: best.baseToken.name || best.baseToken.symbol,
        symbol: best.baseToken.symbol,
        currentMcUsd: mc,
        highestMcUsd: null,
        createdAt: c.timestamp ?? pairCreated,
      } as DeployedToken;
    })
  );

  const tokens: DeployedToken[] = [];
  for (const r of results) if (r.status === "fulfilled" && r.value) tokens.push(r.value);
  return tokens;
}

// ── Public entry ──────────────────────────────────────────────────────────────

export async function getDeployedTokens(
  chain: "solana" | "eth" | "base" | "bsc",
  walletAddress: string
): Promise<DeployedToken[]> {
  const cacheKey = `deploys:${chain}:${walletAddress.toLowerCase()}`;
  const cached = serverCache.get<DeployedToken[]>(cacheKey);
  if (cached) return cached;

  let candidates: Array<{ address: string; timestamp: number | null }> = [];

  if (chain === "solana") {
    const mints = await findSolanaDeployedMints(walletAddress, { maxSigs: 1000 });
    candidates = mints.map((m) => ({ address: m.mint, timestamp: m.timestamp }));
  } else {
    const contracts = await findEvmDeployedContracts(chain, walletAddress, { maxPages: 5 });
    candidates = contracts.map((c) => ({ address: c.address, timestamp: c.timestamp }));
  }

  if (candidates.length === 0) {
    serverCache.set(cacheKey, [], CACHE_TTL.WALLET_QUICK);
    return [];
  }

  const tokens = await enrichWithDexScreener(chain, candidates);
  tokens.sort((a, b) => b.currentMcUsd - a.currentMcUsd);

  // ATH MC enrichment — Solana only (Birdeye historical OHLCV is reliable for SOL tokens).
  // Caps at top 10 tokens to keep latency bounded.
  if (chain === "solana" && process.env.BIRDEYE_API_KEY) {
    const top = tokens.slice(0, 10);
    await Promise.allSettled(top.map(async (t) => {
      try {
        const since = t.createdAt ?? Math.floor(Date.now() / 1000) - 86400 * 90; // up to 90 days
        const [ohlcv, overview] = await Promise.all([
          getOHLCV(t.address, "1h", since),
          getTokenOverview(t.address),
        ]);
        if (!ohlcv.length || !overview?.supply) return;
        const maxPrice = ohlcv.reduce((m, c) => Math.max(m, c.h), 0);
        if (maxPrice > 0) t.highestMcUsd = maxPrice * overview.supply;
      } catch { /* ignore */ }
    }));
  }

  serverCache.set(cacheKey, tokens, DEPLOYS_TTL);
  return tokens;
}

// ── Best Launch helper ────────────────────────────────────────────────────────

export function bestLaunch(tokens: DeployedToken[]): DeployedToken | null {
  if (tokens.length === 0) return null;
  // Prefer highestMc if any has it; else fall back to currentMc
  const withAth = tokens.filter((t) => t.highestMcUsd && t.highestMcUsd > 0);
  if (withAth.length > 0) {
    return withAth.sort((a, b) => (b.highestMcUsd ?? 0) - (a.highestMcUsd ?? 0))[0];
  }
  return tokens.sort((a, b) => b.currentMcUsd - a.currentMcUsd)[0];
}
