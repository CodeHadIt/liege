/**
 * pools.fun — SushiSwap's launchpad on Robinhood Chain.
 *
 * NOT pools.trade, which is a different platform on the same chain.
 *
 * pools.fun has no public API and, at the time of writing, no UI listing
 * launches at all — so everything here is read from the chain. That turns out to
 * be the ideal case rather than a limitation, because the factory is **verified**
 * and its events carry exactly what both halves of the feed need:
 *
 *   PairedAssetCurveSet(address indexed asset, address feed, uint32 maxPriceAge, int24 fallbackTick)
 *   PairedAssetCurveRemoved(address indexed asset)
 *   TokenLaunched(address indexed token, address indexed pool, address pairedAsset,
 *                 address indexed creator, address deployer, address feeRecipient,
 *                 int24 startTick, string metadataUri, uint256 devBuyAmountOut)
 *
 * `TokenLaunched` names the token AND its paired asset in one event, atomically,
 * at launch. That is the same shape as the BNB Chain bonding-curve watchers and
 * strictly better than StonkFun, where the pair only resolves once an indexer
 * catches up to a pool created in a later transaction.
 *
 * Contract: PartyFactory `0x626c3d09b65bf5d1d40e0d5f25e19fa49783b3d4`,
 * deployed 2026-08-11 09:55:56 UTC at block 33,570,152.
 */
import { rateLimit } from "@/lib/rate-limiter";

export const POOLS_FUN_FACTORY = "0x626c3d09b65bf5d1d40e0d5f25e19fa49783b3d4";
export const POOLS_FUN_URL = "https://pools.fun";

/** Block the factory was deployed in — nothing to scan before it. */
export const POOLS_FUN_DEPLOY_BLOCK = 33_570_152;

const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
// The public RPC rejects requests that don't look like they came from the
// explorer, so every call carries browser-ish origin headers.
const RPC_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://robinhoodchain.blockscout.com",
  Referer: "https://robinhoodchain.blockscout.com/",
};

/** keccak256 of the event signatures above. */
export const TOPIC_TOKEN_LAUNCHED =
  "0xd1844be5e646143a1c9e6841471e58911bac843c7d033e435d304cfeba2c2153";
export const TOPIC_PAIRED_ASSET_SET =
  "0x0037326e50f85c4d0231f5e525ab185f2ff16a2cf9dade45c77f3eb7df9f62c1";
export const TOPIC_PAIRED_ASSET_REMOVED =
  "0x798e649fcbf16ef11471e9772ed418e99efb8a2f68365e6b78702d3748c0d1af";

/**
 * The paired assets the factory shipped with, both set in its deployment block.
 *
 * These are the platform's base currencies, not listings — WETH takes the great
 * majority of launches and USDG the rest. A stock quote, which is what this feed
 * exists for, would be a third asset added later via `setPairedAssetCurve`.
 */
export const BASELINE_PAIRED_ASSETS = new Set([
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG (Global Dollar)
]);

export const BASELINE_SYMBOLS: Record<string, string> = {
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "WETH",
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
};

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(RH_RPC, {
      method: "POST",
      headers: RPC_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.error) return null;
    return json?.result as T;
  } catch {
    return null;
  }
}

/** Latest block, or null if the node couldn't be reached. */
export async function getLatestBlock(): Promise<number | null> {
  const hex = await rpc<string>("eth_blockNumber", []);
  if (!hex) return null;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
}

/**
 * Factory logs for one topic over a block range.
 *
 * Returns null on failure rather than an empty array. This distinction has
 * bitten every chain watcher in this codebase at least once: an empty array
 * combined with an advancing cursor silently skips blocks forever, and the feed
 * looks healthy while missing every launch in the gap.
 */
async function getFactoryLogs(
  topic: string,
  fromBlock: number,
  toBlock: number
): Promise<RpcLog[] | null> {
  const out: RpcLog[] = [];
  // Robinhood Chain produces blocks every ~0.1s, so a catch-up range can be
  // large. Chunked to stay well inside the node's per-query log cap.
  const CHUNK = 50_000;
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    const logs = await rpc<RpcLog[]>("eth_getLogs", [
      {
        address: POOLS_FUN_FACTORY,
        topics: [topic],
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
      },
    ]);
    if (logs === null) return null;
    out.push(...logs);
  }
  return out;
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(26)}`.toLowerCase();
}

export interface PairedAssetEvent {
  asset: string;
  block: number;
  txHash: string;
}

/** Paired (quote) assets ADDED in a block range. */
export async function getPairedAssetsSet(
  fromBlock: number,
  toBlock: number
): Promise<PairedAssetEvent[] | null> {
  const logs = await getFactoryLogs(TOPIC_PAIRED_ASSET_SET, fromBlock, toBlock);
  if (logs === null) return null;
  return logs.map((l) => ({
    asset: topicAddress(l.topics[1]),
    block: parseInt(l.blockNumber, 16),
    txHash: l.transactionHash,
  }));
}

/** Paired assets REMOVED in a block range. */
export async function getPairedAssetsRemoved(
  fromBlock: number,
  toBlock: number
): Promise<PairedAssetEvent[] | null> {
  const logs = await getFactoryLogs(TOPIC_PAIRED_ASSET_REMOVED, fromBlock, toBlock);
  if (logs === null) return null;
  return logs.map((l) => ({
    asset: topicAddress(l.topics[1]),
    block: parseInt(l.blockNumber, 16),
    txHash: l.transactionHash,
  }));
}

export interface PoolsFunLaunch {
  token: string;
  pool: string;
  creator: string;
  pairedAsset: string;
  block: number;
  txHash: string;
}

/**
 * Tokens launched in a block range, each with the asset it was paired against.
 *
 * `pairedAsset` is the first non-indexed word of the event data. token, pool and
 * creator are indexed and come from the topics.
 */
export async function getTokenLaunches(
  fromBlock: number,
  toBlock: number
): Promise<PoolsFunLaunch[] | null> {
  const logs = await getFactoryLogs(TOPIC_TOKEN_LAUNCHED, fromBlock, toBlock);
  if (logs === null) return null;
  return logs.map((l) => ({
    token: topicAddress(l.topics[1]),
    pool: topicAddress(l.topics[2]),
    creator: topicAddress(l.topics[3]),
    // data word 0 — right-aligned address inside a 32-byte word
    pairedAsset: `0x${l.data.slice(2, 66).slice(24)}`.toLowerCase(),
    block: parseInt(l.blockNumber, 16),
    txHash: l.transactionHash,
  }));
}

/**
 * Whether the factory currently accepts an asset as a pairing currency.
 *
 * Used to confirm a `PairedAssetCurveSet` still stands before opening a window —
 * an asset could in principle be set and removed inside one scan range.
 */
export async function isAllowedPairedAsset(asset: string): Promise<boolean | null> {
  // allowedPairedAsset(address) — keccak256 of the signature, first 4 bytes
  const data = `0x52fea3ee${asset.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const res = await rpc<string>("eth_call", [{ to: POOLS_FUN_FACTORY, data }, "latest"]);
  if (res === null) return null;
  try {
    // A bool return is a 32-byte word: all zeroes is false, anything else true.
    // Compared as a string rather than a BigInt literal, which this project's
    // TS target predates.
    return /[1-9a-f]/i.test(res.replace(/^0x/, ""));
  } catch {
    return null;
  }
}
