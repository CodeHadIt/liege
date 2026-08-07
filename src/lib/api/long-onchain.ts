import { rateLimit } from "@/lib/rate-limiter";
import { RH_EXPLORER } from "@/lib/api/robinhood-stocks";

// Long launches are Uniswap V4 pools created via the singleton PoolManager on
// Robinhood Chain. Each creation emits an `Initialize` event carrying both
// currencies (indexed) — the real-time "a token was paired against X" signal.
export const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
// keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
export const INITIALIZE_TOPIC0 =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const UA = "Mozilla/5.0";

function topicToAddress(topic: string): string {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

/** Latest block number on Robinhood Chain (via Blockscout), or null on failure. */
export async function getLatestBlock(): Promise<number | null> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(`${RH_EXPLORER}/api?module=block&action=eth_block_number`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hex = data?.result;
    if (typeof hex !== "string") return null;
    const n = parseInt(hex, 16);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface InitializeEvent {
  blockNumber: number;
  currency0: string;
  currency1: string;
  hooks: string;
  /** tx that created the pool — used to identify the launchpad frontend */
  txHash: string;
}

/**
 * Read PoolManager `Initialize` events in a block range via Blockscout getLogs.
 * Ranges are small under normal polling; the caller caps the span.
 */
export async function getInitializeEvents(
  fromBlock: number,
  toBlock: number
): Promise<InitializeEvent[]> {
  await rateLimit("robinscan");
  try {
    const url =
      `${RH_EXPLORER}/api?module=logs&action=getLogs` +
      `&fromBlock=${fromBlock}&toBlock=${toBlock}` +
      `&address=${POOL_MANAGER}&topic0=${INITIALIZE_TOPIC0}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const logs: Array<{ topics?: string[]; data?: string; blockNumber?: string; transactionHash?: string }> =
      Array.isArray(data?.result) ? data.result : [];

    const out: InitializeEvent[] = [];
    for (const lg of logs) {
      const topics = lg.topics ?? [];
      if (topics.length < 4) continue;
      const body = (lg.data ?? "").replace(/^0x/, "");
      // data words: fee, tickSpacing, hooks, sqrtPriceX96, tick — hooks is word[2]
      const hooks = body.length >= 192 ? ("0x" + body.slice(128, 192).slice(-40)).toLowerCase() : ZERO_ADDRESS;
      out.push({
        blockNumber: parseInt(lg.blockNumber ?? "0x0", 16) || 0,
        currency0: topicToAddress(topics[2]),
        currency1: topicToAddress(topics[3]),
        hooks,
        txHash: lg.transactionHash ?? "",
      });
    }
    return out.sort((a, b) => a.blockNumber - b.blockNumber);
  } catch {
    return [];
  }
}

export interface OnchainTokenMeta {
  symbol: string;
  name: string;
  decimals: number;
  iconUrl: string | null;
}

/** ERC-20 metadata for a freshly-created token, via Blockscout's token endpoint. */
export async function getTokenMeta(address: string): Promise<OnchainTokenMeta | null> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(`${RH_EXPLORER}/api/v2/tokens/${address}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.symbol && !d?.name) return null;
    return {
      symbol: String(d.symbol ?? "?"),
      name: String(d.name ?? d.symbol ?? ""),
      decimals: parseInt(String(d.decimals ?? "18"), 10) || 18,
      iconUrl: d.icon_url ?? null,
    };
  } catch {
    return null;
  }
}

// ── Which launchpad created the pool ──────────────────────────────────────────
// Every launchpad on Robinhood Chain goes through the same Uniswap V4 singleton
// PoolManager, so we identify the frontend from two signals, most-specific first:
//   1. the branded router the launch tx called (e.g. "LongLauncher") — but many
//      launches route through generic Multicall3 / ERC-4337 EntryPoint, which
//      hide the frontend, so this is best-effort;
//   2. the pool's V4 hook contract, which is baked in regardless of routing.
// Falls back to the hook's on-chain protocol name, then a generic label.

export interface Launchpad {
  name: string;
  url: string | null;
  /** "Launched via X" for a shared protocol, "Launched on X" for a frontend. */
  via: boolean;
}

// Hook address (lowercase) → platform. Confirmed from on-chain sampling.
const HOOK_PLATFORMS: Record<string, Launchpad> = {
  [ZERO_ADDRESS]: { name: "Uniswap V4 (pools.trade)", url: "https://pools.trade/", via: false },
  "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544": { name: "Doppler", url: null, via: true }, // Long/others build on this
  "0x745d717620052a97a22deee2e5eba59583f3e0cc": { name: "Klik", url: null, via: true },
};

// Known branded router contract addresses (lowercase) → frontend.
const ROUTER_PLATFORMS: Record<string, Launchpad> = {
  "0x22e99278308b393ea1260859b181ad7e78f5eeed": { name: "Long", url: "https://app.long.xyz/create", via: false }, // LongLauncher
};

// Brand from a contract's verified name (router or hook). Substring match keeps
// this resilient to per-deploy hook addresses (Clanker/Flaunch deploy many).
function brandFromName(name?: string | null): Launchpad | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes("long")) return { name: "Long", url: "https://app.long.xyz/create", via: false };
  if (n.includes("pons")) return { name: "Pons", url: "https://www.ponsfamily.com/launchpad/create", via: false };
  if (n.includes("flaunch")) return { name: "Flaunch", url: "https://flaunch.gg", via: false };
  if (n.includes("clanker")) return { name: "Clanker", url: "https://clanker.world", via: false };
  if (n.includes("doppler")) return { name: "Doppler", url: null, via: true };
  if (n.includes("klik")) return { name: "Klik", url: null, via: true };
  if (n.includes("instant")) return { name: "InstantLaunch", url: null, via: false };
  return null;
}

/** The `to` contract of a tx: its address + verified name (if any). */
async function getTxTo(txHash: string): Promise<{ hash: string; name: string | null } | null> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(`${RH_EXPLORER}/api/v2/transactions/${txHash}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const to = d?.to;
    if (!to?.hash) return null;
    return { hash: String(to.hash).toLowerCase(), name: to.name ?? null };
  } catch {
    return null;
  }
}

/** Verified contract name for an address (e.g. a hook), or null. */
async function getContractName(address: string): Promise<string | null> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(`${RH_EXPLORER}/api/v2/addresses/${address}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort platform behind a pool creation. Resolution order:
 *   1. branded launch-tx router (address map, then verified name),
 *   2. known hook address,
 *   3. hook's on-chain protocol name,
 *   4. generic Uniswap V4.
 */
export async function resolveLaunchpad(hook: string, txHash?: string): Promise<Launchpad> {
  const h = (hook || "").toLowerCase();

  // 1. Branded router the launch tx called (most specific frontend signal).
  if (txHash) {
    const to = await getTxTo(txHash);
    if (to) {
      if (ROUTER_PLATFORMS[to.hash]) return ROUTER_PLATFORMS[to.hash];
      const byRouter = brandFromName(to.name);
      if (byRouter) return byRouter;
    }
  }

  // 2. Known hook address.
  if (HOOK_PLATFORMS[h]) return HOOK_PLATFORMS[h];

  // 3. Hook's on-chain protocol/brand name (skip the zero hook).
  if (h && h !== ZERO_ADDRESS) {
    const hookName = await getContractName(h);
    const byHook = brandFromName(hookName);
    if (byHook) return byHook;
    if (hookName) {
      const clean = hookName.replace(/hook.*/i, "").trim() || hookName;
      return { name: clean, url: null, via: true };
    }
  }

  // 4. Fallback.
  return { name: "Uniswap V4", url: null, via: true };
}
