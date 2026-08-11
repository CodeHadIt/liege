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

export type AssetStandard = "erc20" | "erc721";

export interface IncomingTransfer {
  tokenAddress: string;
  from: string;
  to: string;
  /** ERC-20: raw value in token base units. ERC-721: always 0. */
  rawValue: bigint;
  /** ERC-721 only — the id transferred. */
  tokenId: string | null;
  standard: AssetStandard;
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
    // ERC-721 shares ERC-20's Transfer topic0 exactly, so the two are
    // indistinguishable by signature. They differ in arity: ERC-20 indexes
    // (from, to) and carries `value` in data — 3 topics; ERC-721 also indexes
    // `tokenId` — 4 topics, with empty data.
    //
    // Conflating them made an NFT collection read as a token every alpha wallet
    // was "buying" for $0. They are now told apart and each handled on its own
    // terms, rather than one being mistaken for the other or discarded.
    if (!l.topics) continue;
    const isErc721 = l.topics.length === 4;
    const isErc20 = l.topics.length === 3;
    if (!isErc20 && !isErc721) continue;

    let rawValue = BigInt(0);
    if (isErc20) {
      try {
        rawValue = BigInt(l.data && l.data !== "0x" ? l.data : "0x0");
      } catch {
        /* keep zero */
      }
      // A zero-value token transfer is not a purchase.
      if (rawValue <= BigInt(0)) continue;
    }

    out.push({
      tokenAddress: l.address.toLowerCase(),
      from: ("0x" + l.topics[1].slice(-40)).toLowerCase(),
      to: ("0x" + l.topics[2].slice(-40)).toLowerCase(),
      rawValue,
      tokenId: isErc721 ? BigInt(l.topics[3]).toString() : null,
      standard: isErc721 ? "erc721" : "erc20",
      txHash: l.transactionHash,
      blockNumber: parseInt(l.blockNumber, 16) || 0,
    });
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber);
}

/**
 * Sender and native value of a transaction.
 *
 * `from` tells a BUY from a mere receipt: if the alpha wallet itself sent the
 * transaction that delivered the asset, it acted — an airdrop or an inbound
 * transfer from someone else did not.
 *
 * `valueWei` is what the wallet actually paid, which is the only price signal
 * an NFT mint has: there is no pool to quote against.
 */
export async function getTxInfo(txHash: string): Promise<{ from: string; valueWei: bigint } | null> {
  const tx = await rpc<{ from?: string; value?: string }>("eth_getTransactionByHash", [txHash]);
  if (!tx?.from) return null;
  let valueWei = BigInt(0);
  try {
    valueWei = BigInt(tx.value ?? "0x0");
  } catch {
    /* keep zero */
  }
  return { from: tx.from.toLowerCase(), valueWei };
}

export async function getTxSender(txHash: string): Promise<string | null> {
  return (await getTxInfo(txHash))?.from ?? null;
}

/** Wrapped-ETH on Robinhood Chain — the reference for pricing native spend. */
const WETH_RH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
let ethPriceCache: { usd: number; at: number } | null = null;

/** ETH price in USD, cached for a few minutes. */
export async function getEthUsdPrice(): Promise<number | null> {
  if (ethPriceCache && Date.now() - ethPriceCache.at < 5 * 60_000) return ethPriceCache.usd;
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/simple/networks/robinhood/token_price/${WETH_RH}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return ethPriceCache?.usd ?? null;
    const d = await res.json();
    const raw = d?.data?.attributes?.token_prices?.[WETH_RH];
    const usd = raw ? parseFloat(raw) : NaN;
    if (!Number.isFinite(usd) || usd <= 0) return ethPriceCache?.usd ?? null;
    ethPriceCache = { usd, at: Date.now() };
    return usd;
  } catch {
    return ethPriceCache?.usd ?? null;
  }
}

export interface NftCollection {
  name: string;
  symbol: string;
  totalSupply: number | null;
  holders: number | null;
}

/** Collection metadata from Blockscout — there is no DEX pool to read it from. */
export async function getNftCollection(address: string): Promise<NftCollection | null> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${address}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.symbol && !d?.name) return null;
    const num = (v: unknown) => {
      const n = parseInt(String(v ?? ""), 10);
      return Number.isFinite(n) ? n : null;
    };
    return {
      name: String(d.name ?? d.symbol ?? ""),
      symbol: String(d.symbol ?? "?"),
      totalSupply: num(d.total_supply),
      holders: num(d.holders),
    };
  } catch {
    return null;
  }
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
