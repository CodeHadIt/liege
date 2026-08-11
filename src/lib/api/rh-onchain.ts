import { rateLimit } from "@/lib/rate-limiter";

// Robinhood Chain JSON-RPC. Used by the alpha-wallet watcher, which needs
// eth_getLogs with an OR-filter across many addresses — something Blockscout's
// REST API can't express, and which lets us watch every alpha wallet with a
// SINGLE call per poll instead of one per wallet.
//
// The public RPC rejects requests without browser-ish headers (403), hence the
// Origin/Referer below.
export const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Origin: "https://pools.trade",
  Referer: "https://pools.trade/",
};

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc<T>(method: string, params: unknown[], tries = 3): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    await rateLimit("rhrpc");
    try {
      const res = await fetch(RH_RPC, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const d = await res.json();
      if (d?.error) continue;
      if (d?.result !== undefined) return d.result as T;
    } catch {
      /* retry */
    }
  }
  return null;
}

export async function getRhLatestBlock(): Promise<number | null> {
  const hex = await rpc<string>("eth_blockNumber", []);
  if (typeof hex !== "string") return null;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
}

function padTopic(address: string): string {
  return "0x" + address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

export interface IncomingTransfer {
  tokenAddress: string;
  from: string;
  to: string;
  /** raw value, still in token base units */
  rawValue: bigint;
  txHash: string;
  blockNumber: number;
}

/**
 * Every ERC-20 Transfer INTO any of `wallets` within a block range — one call
 * for all of them, via an OR-filter on the indexed `to` topic. Returns null on
 * RPC failure so the caller can hold its cursor rather than mistake a failed
 * read for a quiet period.
 */
export async function getTransfersToWallets(
  wallets: string[],
  fromBlock: number,
  toBlock: number
): Promise<IncomingTransfer[] | null> {
  if (wallets.length === 0) return [];
  const logs = await rpc<Array<{ address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string }>>(
    "eth_getLogs",
    [
      {
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
        topics: [TRANSFER_TOPIC, null, wallets.map(padTopic)],
      },
    ]
  );
  if (!Array.isArray(logs)) return null;

  const out: IncomingTransfer[] = [];
  for (const l of logs) {
    // ERC-721 shares ERC-20's Transfer topic0 exactly, so an NFT mint is
    // indistinguishable by topic alone. The difference is arity: ERC-20 indexes
    // (from, to) and carries `value` in data — 3 topics; ERC-721 also indexes
    // `tokenId` — 4 topics, with empty data.
    //
    // Without this check an NFT collection reads as a token every alpha wallet
    // is "buying" for $0, which is exactly what happened with Spritehood Wisp
    // (ERC-721, 44,444 supply): 452 phantom buys and 31 alerts.
    if (!l.topics || l.topics.length !== 3) continue;

    let rawValue = BigInt(0);
    try {
      rawValue = BigInt(l.data && l.data !== "0x" ? l.data : "0x0");
    } catch {
      /* keep zero */
    }
    // A zero-value transfer is not a purchase.
    if (rawValue <= BigInt(0)) continue;
    out.push({
      tokenAddress: l.address.toLowerCase(),
      from: ("0x" + l.topics[1].slice(-40)).toLowerCase(),
      to: ("0x" + l.topics[2].slice(-40)).toLowerCase(),
      rawValue,
      txHash: l.transactionHash,
      blockNumber: parseInt(l.blockNumber, 16) || 0,
    });
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber);
}

/**
 * The sender of a transaction. Used to tell a BUY from a mere receipt: if the
 * alpha wallet itself sent the transaction that delivered the tokens, it acted
 * — an airdrop or an inbound transfer from somewhere else did not.
 */
export async function getTxSender(txHash: string): Promise<string | null> {
  const tx = await rpc<{ from?: string }>("eth_getTransactionByHash", [txHash]);
  return tx?.from ? tx.from.toLowerCase() : null;
}

/** Block timestamp in ms, for dating a buy accurately rather than at poll time. */
export async function getBlockTimeMs(blockNumber: number): Promise<number | null> {
  const b = await rpc<{ timestamp?: string }>("eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false]);
  if (!b?.timestamp) return null;
  const s = parseInt(b.timestamp, 16);
  return Number.isFinite(s) ? s * 1000 : null;
}

const ERC20_DECIMALS = "0x313ce567";

export async function getRhTokenDecimals(address: string): Promise<number> {
  const res = await rpc<string>("eth_call", [{ to: address, data: ERC20_DECIMALS }, "latest"]);
  if (typeof res !== "string") return 18;
  const n = parseInt(res.slice(-2), 16);
  return Number.isFinite(n) && n >= 0 && n <= 36 ? n : 18;
}
