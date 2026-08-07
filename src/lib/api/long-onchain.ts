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
    const logs: Array<{ topics?: string[]; data?: string; blockNumber?: string }> =
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
