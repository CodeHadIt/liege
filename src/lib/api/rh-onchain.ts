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

/** Raised when a range matches more logs than the node will return. */
class LogLimitError extends Error {}

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
      if (d?.error) {
        // "logs matched by query exceeds limit of 10000" is not a transient
        // failure — retrying the same range can only fail again. Surface it so
        // the caller can split the range instead of spinning.
        if (String(d.error?.message ?? "").includes("exceeds limit")) throw new LogLimitError();
        continue;
      }
      if (d?.result !== undefined) return d.result as T;
    } catch (err) {
      if (err instanceof LogLimitError) throw err;
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
type RawLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string };

/**
 * eth_getLogs over a range, splitting in half whenever the node refuses the
 * query for matching too many logs. Without this a busy range fails
 * permanently — the error is deterministic, so a caller that just retries
 * never advances.
 */
async function getLogsSplitting(
  wallets: string[],
  fromBlock: number,
  toBlock: number,
  depth = 0
): Promise<RawLog[] | null> {
  try {
    const logs = await rpc<RawLog[]>("eth_getLogs", [
      {
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
        topics: [TRANSFER_TOPIC, null, wallets.map(padTopic)],
      },
    ]);
    return Array.isArray(logs) ? logs : null;
  } catch (err) {
    if (!(err instanceof LogLimitError)) return null;
    // A single block that still exceeds the limit can't be split further.
    if (fromBlock >= toBlock || depth > 12) return [];
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const [a, b] = await Promise.all([
      getLogsSplitting(wallets, fromBlock, mid, depth + 1),
      getLogsSplitting(wallets, mid + 1, toBlock, depth + 1),
    ]);
    if (a == null || b == null) return null;
    return [...a, ...b];
  }
}

export async function getTransfersToWallets(
  wallets: string[],
  fromBlock: number,
  toBlock: number
): Promise<IncomingTransfer[] | null> {
  if (wallets.length === 0) return [];
  const logs = await getLogsSplitting(wallets, fromBlock, toBlock);
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

/**
 * Recent sale prices for a collection, derived from on-chain fills.
 *
 * No orderbook exists to query on this chain — OpenSea, Reservoir and Magic Eden
 * all fail for it — so a true "lowest current ask" floor is not obtainable.
 * What IS observable is what people actually paid: secondary sales settle
 * through Seaport, and the transaction value divided by the number of ids moved
 * gives a per-NFT price. The lowest recent fill is the closest honest proxy for
 * a floor, and it is labelled as such rather than presented as an ask.
 */
export interface NftSaleStats {
  /** lowest per-NFT price paid in the window */
  lowEth: number;
  medianEth: number;
  sales: number;
  windowBlocks: number;
}

export async function getNftSaleStats(
  collection: string,
  latestBlock: number,
  windowBlocks = 50_000,
  maxTxLookups = 40
): Promise<NftSaleStats | null> {
  const from = latestBlock - windowBlocks;
  const logs: RawLog[] = [];
  // Chunked to stay under the node's 10k-log cap.
  for (let start = from; start < latestBlock; start += 2_000) {
    const end = Math.min(start + 1_999, latestBlock);
    let chunk: RawLog[] | null = null;
    try {
      chunk = await rpc<RawLog[]>("eth_getLogs", [
        {
          address: collection,
          fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + end.toString(16),
          topics: [TRANSFER_TOPIC],
        },
      ]);
    } catch {
      continue; // over the cap even at this size — skip rather than fail the alert
    }
    if (Array.isArray(chunk)) logs.push(...chunk);
  }
  if (logs.length === 0) return null;

  // Mints are not sales — a free mint would drag any floor to zero.
  const zeroTopic = "0x" + "0".repeat(64);
  const secondary = logs.filter((l) => l.topics?.[1] !== zeroTopic);
  if (secondary.length === 0) return null;

  const perTx = new Map<string, number>();
  for (const l of secondary) perTx.set(l.transactionHash, (perTx.get(l.transactionHash) ?? 0) + 1);

  const prices: number[] = [];
  for (const [txHash, count] of [...perTx].slice(0, maxTxLookups)) {
    const info = await getTxInfo(txHash);
    if (!info || info.valueWei <= BigInt(0)) continue; // transfer, not a purchase
    prices.push(Number(info.valueWei) / 1e18 / Math.max(count, 1));
  }
  if (prices.length === 0) return null;

  prices.sort((a, b) => a - b);
  return {
    lowEth: prices[0],
    medianEth: prices[Math.floor(prices.length / 2)],
    sales: prices.length,
    windowBlocks,
  };
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
      // Blockscout returns holders_count, not holders — reading the latter
      // silently produced null on every collection.
      holders: num(d.holders_count ?? d.holders),
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
