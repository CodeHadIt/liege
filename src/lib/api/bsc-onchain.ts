import { rateLimit } from "@/lib/rate-limiter";
import { FLAP_PORTALS, FLAP_BSC_CHAIN_ID } from "@/lib/api/flap";

// Real-time launch detection on BNB Chain, read straight from the bonding-curve
// creation events — not from DexScreener pools, which only appear once a token
// is indexed (and, for a curve that never migrates, may never appear at all).
//
// Both launchpads emit a creation event the instant the curve is deployed:
//
//   Flap      portal 0xe2ce…9de0, topic 0x3ceb902d…
//             data = [address token, address paymentToken]   ← quote is inline
//
//   Four.meme TokenManager2 0x5c95…762b, topic 0x396d5e90…
//             data = [creator, token, id, nameOff, symbolOff, supply, …]
//             The quote is NOT in the event, so we read it back from
//             TokenManagerHelper3.getTokenInfo(token).quote
//
// Verified against live launches on 2026-08-08.

export const FLAP_PORTAL_BSC = FLAP_PORTALS[FLAP_BSC_CHAIN_ID];
export const FLAP_LAUNCH_TOPIC =
  "0x3ceb902d3c555c21c3415b6aa839104b18e4825b2f8324011ff979089a507a8c";

export const FOURMEME_TOKEN_MANAGER = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
export const FOURMEME_CREATE_TOPIC =
  "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20";
/** TokenManagerHelper3 — exposes getTokenInfo(token) → (…, quote, …) */
export const FOURMEME_HELPER = "0xf251f83e40a78868fcfa3fa4599dad6494e46034";
const GET_TOKEN_INFO_SELECTOR = "0x1f69565f";

const ERC20_NAME = "0x06fdde03";
const ERC20_SYMBOL = "0x95d89b41";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Public BNB Chain RPCs — no key required. We rotate on failure because the
// free endpoints rate-limit aggressively and individually go down often.
const BSC_RPCS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed.defibit.io",
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.bnbchain.org",
  "https://bsc-dataseed2.bnbchain.org",
  "https://bsc-dataseed.ninicoin.io",
];

let rpcCursor = 0;

/** JSON-RPC call, rotating endpoints until one answers. */
async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  await rateLimit("bscrpc");
  let lastErr: unknown = null;
  for (let i = 0; i < BSC_RPCS.length; i++) {
    const url = BSC_RPCS[(rpcCursor + i) % BSC_RPCS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.error) {
        lastErr = data.error;
        continue;
      }
      if (data?.result !== undefined) {
        // Stick with whichever endpoint just worked.
        rpcCursor = (rpcCursor + i) % BSC_RPCS.length;
        return data.result as T;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) console.error("[bsc-rpc]", method, "all endpoints failed");
  return null;
}

export async function getLatestBscBlock(): Promise<number | null> {
  const hex = await rpc<string>("eth_blockNumber", []);
  if (typeof hex !== "string") return null;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
}

interface RawLog {
  topics?: string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
}

/**
 * Free BSC endpoints cap `eth_getLogs` spans (commonly at 1k–5k blocks), so
 * ranges are requested in chunks this size.
 */
const LOG_CHUNK = 1_000;

/**
 * Logs for a range, or null if any chunk failed. The null is load-bearing: an
 * RPC failure must NOT look like "no launches happened", or the caller would
 * advance its cursor past blocks it never actually read.
 */
async function getLogs(
  address: string,
  topic0: string,
  from: number,
  to: number
): Promise<RawLog[] | null> {
  const out: RawLog[] = [];
  for (let start = from; start <= to; start += LOG_CHUNK) {
    const end = Math.min(start + LOG_CHUNK - 1, to);
    const logs = await rpc<RawLog[]>("eth_getLogs", [
      {
        address,
        topics: [topic0],
        fromBlock: "0x" + start.toString(16),
        toBlock: "0x" + end.toString(16),
      },
    ]);
    if (!Array.isArray(logs)) return null;
    out.push(...logs);
  }
  return out;
}

/** The 32-byte word at index `i` of a hex data blob (no 0x). */
function word(body: string, i: number): string {
  return body.slice(i * 64, (i + 1) * 64);
}

function wordToAddress(w: string): string {
  return ("0x" + w.slice(-40)).toLowerCase();
}

/** Decode an ABI dynamic string living at `byteOffset` within the data blob. */
function abiString(body: string, byteOffset: number): string {
  const at = byteOffset / 32;
  const len = parseInt(word(body, at), 16);
  if (!Number.isFinite(len) || len <= 0 || len > 256) return "";
  const hex = body.slice((at + 1) * 64, (at + 1) * 64 + len * 2);
  try {
    return Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/, "");
  } catch {
    return "";
  }
}

export interface BscLaunch {
  platform: "flap" | "fourmeme";
  tokenAddress: string;
  /** the asset the token is priced in; ZERO_ADDRESS means native BNB */
  quoteAddress: string;
  name: string;
  symbol: string;
  blockNumber: number;
  txHash: string;
}

/**
 * Flap launches in a block range. The paired asset is carried in the event, so
 * a launch is fully identified without any follow-up call.
 */
export async function getFlapLaunches(from: number, to: number): Promise<BscLaunch[] | null> {
  const logs = await getLogs(FLAP_PORTAL_BSC, FLAP_LAUNCH_TOPIC, from, to);
  if (logs == null) return null;
  const out: BscLaunch[] = [];
  for (const lg of logs) {
    const body = (lg.data ?? "").replace(/^0x/, "");
    if (body.length < 128) continue;
    out.push({
      platform: "flap",
      tokenAddress: wordToAddress(word(body, 0)),
      quoteAddress: wordToAddress(word(body, 1)),
      name: "",
      symbol: "",
      blockNumber: parseInt(lg.blockNumber ?? "0x0", 16) || 0,
      txHash: lg.transactionHash ?? "",
    });
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber);
}

/**
 * Four.meme launches in a block range. Name and symbol come from the event; the
 * quote asset does not, so it's resolved per token — only for launches we still
 * care about, since resolution costs one eth_call each.
 */
export async function getFourMemeLaunches(from: number, to: number): Promise<BscLaunch[] | null> {
  const logs = await getLogs(FOURMEME_TOKEN_MANAGER, FOURMEME_CREATE_TOPIC, from, to);
  if (logs == null) return null;
  const out: BscLaunch[] = [];
  for (const lg of logs) {
    const body = (lg.data ?? "").replace(/^0x/, "");
    if (body.length < 64 * 6) continue;
    const nameOff = parseInt(word(body, 3), 16);
    const symbolOff = parseInt(word(body, 4), 16);
    out.push({
      platform: "fourmeme",
      tokenAddress: wordToAddress(word(body, 1)),
      quoteAddress: "", // resolved on demand
      name: Number.isFinite(nameOff) ? abiString(body, nameOff) : "",
      symbol: Number.isFinite(symbolOff) ? abiString(body, symbolOff) : "",
      blockNumber: parseInt(lg.blockNumber ?? "0x0", 16) || 0,
      txHash: lg.transactionHash ?? "",
    });
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber);
}

/** The asset a Four.meme token is priced in, via TokenManagerHelper3. */
export async function getFourMemeQuote(tokenAddress: string): Promise<string | null> {
  const data = GET_TOKEN_INFO_SELECTOR + tokenAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const res = await rpc<string>("eth_call", [{ to: FOURMEME_HELPER, data }, "latest"]);
  if (typeof res !== "string" || res.length < 2 + 64 * 3) return null;
  // (version, tokenManager, quote, …) — quote is the third word.
  return wordToAddress(word(res.replace(/^0x/, ""), 2));
}

/** ERC-20 name/symbol for a freshly launched token. */
export async function getBscTokenMeta(address: string): Promise<{ name: string; symbol: string }> {
  const read = async (selector: string): Promise<string> => {
    const res = await rpc<string>("eth_call", [{ to: address, data: selector }, "latest"]);
    if (typeof res !== "string") return "";
    const body = res.replace(/^0x/, "");
    if (body.length < 128) {
      // Legacy tokens return a raw bytes32 rather than a dynamic string.
      try {
        return Buffer.from(body, "hex").toString("utf8").replace(/\0+/g, "").trim();
      } catch {
        return "";
      }
    }
    const off = parseInt(word(body, 0), 16);
    return Number.isFinite(off) ? abiString(body, off) : "";
  };
  const [name, symbol] = await Promise.all([read(ERC20_NAME), read(ERC20_SYMBOL)]);
  return { name, symbol };
}

// ── Batched reads, for corpus-scale work ─────────────────────────────────────
// The single-call `rpc` helper above is right for watchers, which make a handful
// of calls per poll. The alpha backfill asks the same question of a few thousand
// addresses at once, where one HTTP round trip per address is the bottleneck.
// These batch it into JSON-RPC arrays and rotate endpoints on failure.

const BATCH_RPCS = [
  ...BSC_RPCS,
  "https://binance.llamarpc.com",
  "https://bsc-dataseed1.defibit.io",
];
let batchCursor = 0;

/** One JSON-RPC batch, returning results by input index. Missing = unresolved. */
async function rpcBatch(
  calls: { method: string; params: unknown[] }[]
): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>();
  if (calls.length === 0) return out;
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));

  for (let attempt = 0; attempt < BATCH_RPCS.length * 2; attempt++) {
    const url = BATCH_RPCS[batchCursor % BATCH_RPCS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        batchCursor++;
        continue;
      }
      const json = await res.json();
      if (!Array.isArray(json)) {
        batchCursor++;
        continue;
      }
      for (const item of json) {
        if (typeof item?.id === "number" && item.result !== undefined) out.set(item.id, item.result);
      }
      // An endpoint that answers nothing is failing quietly — rotate rather than
      // report every address as unresolved.
      if (out.size > 0) return out;
      batchCursor++;
    } catch {
      batchCursor++;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return out;
}

const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";

/**
 * `totalSupply` per token, decimal-adjusted. Absent when the call failed or the
 * contract does not implement it — never silently zero, since a zero supply
 * would compute a $0 market cap and quietly drop a real runner.
 */
export async function getBscTotalSupplies(
  tokens: { address: string; decimals: number | null }[],
  batchSize = 25
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < tokens.length; i += batchSize) {
    const chunk = tokens.slice(i, i + batchSize);
    const res = await rpcBatch(
      chunk.map((t) => ({
        method: "eth_call",
        params: [{ to: t.address, data: SELECTOR_TOTAL_SUPPLY }, "latest"],
      }))
    );
    for (const [idx, raw] of res) {
      const t = chunk[idx];
      if (typeof raw !== "string" || raw === "0x") continue;
      try {
        const supply = Number(BigInt(raw)) / 10 ** (t.decimals ?? 18);
        if (Number.isFinite(supply) && supply > 0) out.set(t.address.toLowerCase(), supply);
      } catch {
        /* unparseable — leave unresolved */
      }
    }
    await new Promise((r) => setTimeout(r, 90));
  }
  return out;
}

/**
 * Which addresses have bytecode.
 *
 * Promotion must exclude contracts. Robinhood learned this the hard way: a
 * PoolManager appeared in nearly every token's trader list and was promoted as
 * an "alpha wallet" on billions of imputed PnL. Routers and aggregators do the
 * same on BSC.
 */
export async function getBscContractFlags(
  addresses: string[],
  batchSize = 40
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (let i = 0; i < addresses.length; i += batchSize) {
    const chunk = addresses.slice(i, i + batchSize);
    const res = await rpcBatch(
      chunk.map((a) => ({ method: "eth_getCode", params: [a, "latest"] }))
    );
    for (const [idx, raw] of res) {
      if (typeof raw !== "string") continue;
      out.set(chunk[idx].toLowerCase(), raw !== "0x");
    }
    await new Promise((r) => setTimeout(r, 90));
  }
  return out;
}
