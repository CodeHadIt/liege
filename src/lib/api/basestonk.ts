import { rateLimit } from "@/lib/rate-limiter";

// ── basestonk (Base) ─────────────────────────────────────────────────────────
//
// basestonk launches tokens priced against a "pair token", which may be a stock
// (Coinbase tokenized equities, ST0x wrapped equities), the house $BSTONK token,
// or a plain crypto asset like USDC/WETH.
//
// It exposes a clean public launch API with no auth. What it does NOT expose is
// a catalog of pairable assets: every plausible path was probed and only
// `/tokens`, `/stats/base`, `/pairusd/base` and `/ecosystem/base` exist. The
// launch form builds its picker from an obfuscated bundle, not an endpoint.
//
// That absence shapes the whole design. StonkFun and o1 can announce a stock
// when it is REGISTERED because both publish a catalog. basestonk cannot be
// asked "what is pairable?", only "what has been paired against?" — so a new
// stock pair here is discovered on its first launch. See basestonk-alerts.ts.

const API = "https://api.basestonk.io/api/launchpad";

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};

async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
  await rateLimit("basestonk");
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      console.error(`[basestonk] ${path} ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[basestonk] ${path} failed: ${(err as Error).message}`);
    return null;
  }
}

export interface BasestonkLaunch {
  address: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  pairToken: string;
  creator: string | null;
  txHash: string | null;
  pool: string | null;
  createdAt: number;
  createdBlock: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  migrated: boolean;
  /** Launcher contract generation, e.g. "v5". */
  generation: string | null;
}

interface RawToken {
  address?: string;
  name?: string;
  symbol?: string;
  imageUrl?: string;
  logoUrl?: string;
  pairToken?: string;
  creator?: string;
  txHash?: string;
  pool?: string;
  createdAt?: string;
  createdBlock?: number;
  priceUsd?: number;
  marketcapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  migrated?: boolean;
  generation?: string;
}

/**
 * Launches, newest first.
 *
 * Every record names its `pairToken` inline, so the pairing is exact and needs
 * no pool lookup — the same property that makes StonkFun's and o1's feeds
 * reliable.
 *
 * Returns null on failure rather than an empty array, so a caller cannot mistake
 * a dead fetch for "nothing launched" and advance past a gap.
 */
export async function fetchBasestonkLaunches(limit = 100): Promise<BasestonkLaunch[] | null> {
  const data = await get<{ tokens?: RawToken[] }>("/tokens", { sort: "age", limit });
  if (!data?.tokens || !Array.isArray(data.tokens)) return null;

  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const str = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : null);

  const out: BasestonkLaunch[] = [];
  for (const t of data.tokens) {
    const addr = str(t.address);
    const pair = str(t.pairToken);
    const created = Date.parse(t.createdAt ?? "");
    if (!addr || !pair || !Number.isFinite(created)) continue;
    out.push({
      address: addr.toLowerCase(),
      name: str(t.name) ?? str(t.symbol) ?? "Unknown",
      symbol: str(t.symbol) ?? "?",
      imageUrl: str(t.imageUrl) ?? str(t.logoUrl),
      pairToken: pair.toLowerCase(),
      creator: str(t.creator)?.toLowerCase() ?? null,
      txHash: str(t.txHash),
      pool: str(t.pool),
      createdAt: created,
      createdBlock: num(t.createdBlock),
      priceUsd: num(t.priceUsd),
      marketCapUsd: num(t.marketcapUsd),
      liquidityUsd: num(t.liquidityUsd),
      holders: num(t.holders),
      migrated: t.migrated === true,
      generation: str(t.generation),
    });
  }
  return out;
}

// ── Pair-token classification ────────────────────────────────────────────────
//
// basestonk does not label a pair token as a stock, so classification is done
// on-chain from ERC-20 metadata. Two families are live, and they look nothing
// alike:
//
//   Coinbase tokenized equities — address starts 0xb2, 8 decimals, symbol is the
//     ticker plus a lowercase `c`: COINc, GOOGLc, METAc, NVDAc, MSTRc.
//   ST0x wrapped equities — 18 decimals, symbol `wt<TICKER>`, name of the form
//     "Wrapped <Company> ST0x": wtCOIN, wtNVDA, wtSPCX.
//
// The 0xb2 prefix alone is NOT sufficient. `0xb2…4c27f6523082f41d01` is
// "Basecat", an 18-decimal memecoin that happens to sit in that range — a
// prefix-only rule would announce it as a stock. Decimals are what separate them.

const BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
];

/** ERC-20 selectors: symbol(), name(), decimals(). */
const SEL = { symbol: "0x95d89b41", name: "0x06fdde03", decimals: "0x313ce567" } as const;

async function baseCall(to: string, data: string): Promise<string | null> {
  for (const url of BASE_RPCS) {
    await rateLimit("baserpc");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const j = await res.json();
      if (typeof j?.result === "string") return j.result;
    } catch {
      /* try the next endpoint */
    }
  }
  return null;
}

/**
 * Decode an ABI-encoded string return value.
 *
 * Handles both the dynamic `string` encoding and the fixed `bytes32` form that
 * some older tokens return, which would otherwise decode to mojibake.
 */
function decodeAbiString(hex: string | null): string {
  if (!hex || hex === "0x") return "";
  const body = hex.slice(2);
  try {
    if (body.length === 64) {
      // bytes32: right-padded with zeros
      return Buffer.from(body.replace(/(00)+$/, ""), "hex").toString("utf8").replace(/\0/g, "").trim();
    }
    const len = parseInt(body.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0 || len > 512) return "";
    return Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8").trim();
  } catch {
    return "";
  }
}

export type PairKind = "coinbase-stock" | "st0x-stock" | "other";

export interface PairToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: PairKind;
  /** Underlying ticker with the wrapper marker stripped: COINc → COIN. */
  ticker: string;
}

export function isStockPair(p: PairToken): boolean {
  return p.kind === "coinbase-stock" || p.kind === "st0x-stock";
}

function classify(symbol: string, name: string, decimals: number, address: string): { kind: PairKind; ticker: string } {
  // Coinbase tokenized equity: vanity 0xb2 address, 8 decimals, TICKERc symbol.
  if (decimals === 8 && /^0xb2/i.test(address) && /^[A-Z]{1,6}c$/.test(symbol)) {
    return { kind: "coinbase-stock", ticker: symbol.slice(0, -1) };
  }
  // ST0x wrapped equity: wt-prefixed symbol, "… ST0x" name.
  if (/^wt[A-Z]{1,6}$/.test(symbol) && /ST0x/i.test(name)) {
    return { kind: "st0x-stock", ticker: symbol.slice(2) };
  }
  return { kind: "other", ticker: symbol };
}

/**
 * Pair tokens resolve once and never change, so results are cached for the life
 * of the process. Without this the launch poller would re-read three ERC-20
 * fields per pair on every 30s pass.
 */
const pairCache = new Map<string, PairToken>();

/**
 * Resolve and classify a pair token.
 *
 * Returns null when the metadata cannot be read at all, which is deliberately
 * distinct from "not a stock": an unreadable token is left unclassified and
 * retried on the next pass rather than being cached as `other`, which would
 * permanently suppress a stock behind one transient RPC failure.
 */
export async function resolvePairToken(address: string): Promise<PairToken | null> {
  const addr = address.toLowerCase();
  const hit = pairCache.get(addr);
  if (hit) return hit;

  const [symRaw, nameRaw, decRaw] = await Promise.all([
    baseCall(addr, SEL.symbol),
    baseCall(addr, SEL.name),
    baseCall(addr, SEL.decimals),
  ]);

  const symbol = decodeAbiString(symRaw);
  const name = decodeAbiString(nameRaw);
  if (!symbol && !name) return null;

  const decimals =
    decRaw && decRaw !== "0x" && Number.isFinite(Number(BigInt(decRaw))) ? Number(BigInt(decRaw)) : 18;

  const { kind, ticker } = classify(symbol, name, decimals, addr);
  const out: PairToken = { address: addr, symbol: symbol || "?", name: name || symbol, decimals, kind, ticker };
  pairCache.set(addr, out);
  return out;
}
