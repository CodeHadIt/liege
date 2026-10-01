// ── On-chain reads: what the chain says, independent of what anyone claims ─────
// The point of this source is not to duplicate a block explorer. It is to
// collect exactly the facts that can contradict a document:
//
//   totalSupply()          vs "fixed supply of N"
//   a mint selector        vs "no mint function"
//   owner() answering      vs "no owner"
//   a proxy pointer        vs "immutable"
//   a mint authority (SPL) vs "supply is fixed"
//
// Those five comparisons are the whole of `verify.ts`, and they are the reason
// this pipeline reads bytecode at all rather than trusting the explorer's labels.
//
// No API key is required for any of it. Public RPCs are rotated on failure (the
// same pattern as `bsc-onchain.ts`), and verified-source lookups prefer Blockscout
// because it answers without a key; the *scan keys already in the environment are
// used where we have them.

import { CHAIN_CONFIGS } from "@/config/chains";
import { rateLimit } from "@/lib/rate-limiter";
import { getJson, postJson, budgetSpent, type Budget } from "../fetcher";
import type { ChainId } from "@/types/chain";
import type { OnChainFacts } from "../types";

// ── selectors ─────────────────────────────────────────────────────────────────
const SEL = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  owner: "0x8da5cb5b",
} as const;

/**
 * Selectors whose presence in deployed bytecode is a trust fact.
 *
 * Presence is not proof the function is reachable — a selector can sit behind a
 * modifier that always reverts — so findings are worded as "the bytecode
 * contains", never "the owner can". Absence is the stronger signal: a contract
 * whose code contains no mint selector cannot mint.
 */
const TRUST_SELECTORS = {
  mint: ["40c10f19" /* mint(address,uint256) */, "a0712d68" /* mint(uint256) */, "1249c58b" /* mint() */],
  pause: ["8456cb59" /* pause() */, "3f4ba83a" /* unpause() */],
};

/** EIP-1967: keccak256("eip1967.proxy.implementation") - 1 */
const EIP1967_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const RPCS: Partial<Record<ChainId, string[]>> = {
  eth: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
    "https://1rpc.io/eth",
    "https://rpc.flashbots.net",
  ],
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
  bsc: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org", "https://bsc.drpc.org"],
  rh: ["https://rpc.mainnet.chain.robinhood.com"],
};

const RPC_LIMITER: Partial<Record<ChainId, string>> = {
  eth: "ethrpc",
  base: "baserpc",
  bsc: "bscrpc",
  rh: "rhrpc",
};

async function rpc<T>(chain: ChainId, method: string, params: unknown[], budget: Budget): Promise<T | null> {
  const urls = RPCS[chain] ?? ([CHAIN_CONFIGS[chain]?.rpcUrl].filter(Boolean) as string[]);
  const limiter = RPC_LIMITER[chain];
  if (limiter) await rateLimit(limiter);
  for (const url of urls) {
    if (budgetSpent(budget)) return null;
    const res = await postJson<{ result?: T; error?: unknown }>(
      url,
      { jsonrpc: "2.0", id: 1, method, params },
      budget,
      10_000
    );
    if (res && res.error === undefined && res.result !== undefined) return res.result;
  }
  return null;
}

async function ethCall(chain: ChainId, to: string, data: string, budget: Budget): Promise<string | null> {
  return rpc<string>(chain, "eth_call", [{ to, data }, "latest"], budget);
}

// ── ABI decoding, narrow on purpose ───────────────────────────────────────────

function decodeUint(hex: string | null): bigint | undefined {
  if (!hex || hex === "0x" || hex.length < 3) return undefined;
  try {
    return BigInt(hex.slice(0, 66));
  } catch {
    return undefined;
  }
}

function decodeAddress(hex: string | null): string | undefined {
  if (!hex || hex.length < 66) return undefined;
  const addr = "0x" + hex.slice(26, 66);
  return /^0x0{40}$/.test(addr) ? undefined : addr;
}

/** Printable text only — a bytes32 slot full of binary is not a name. */
function isPrintable(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return s.length > 0;
}

/**
 * Decode a `string` return, falling back to bytes32.
 *
 * Tokens from 2017–2018 (MKR is the famous one) return a fixed bytes32 name, and
 * a decoder that only handles dynamic strings reports them as nameless.
 */
function decodeString(hex: string | null): string | undefined {
  if (!hex || hex === "0x") return undefined;
  const body = hex.slice(2);
  try {
    if (body.length >= 128) {
      const offset = Number(BigInt("0x" + body.slice(0, 64)));
      if (offset === 32) {
        const len = Number(BigInt("0x" + body.slice(64, 128)));
        if (len > 0 && len <= 256 && body.length >= 128 + len * 2) {
          const bytes = body.slice(128, 128 + len * 2);
          const s = Buffer.from(bytes, "hex").toString("utf8").replace(/\0/g, "").trim();
          if (s) return s;
        }
      }
    }
    const s = Buffer.from(body.slice(0, 64), "hex").toString("utf8").replace(/\0/g, "").trim();
    return isPrintable(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

// ── EVM ───────────────────────────────────────────────────────────────────────

export async function inspectEvm(chain: ChainId, address: string, budget: Budget): Promise<OnChainFacts> {
  const facts: OnChainFacts = { chain, address, notes: [] };

  const code = await rpc<string>(chain, "eth_getCode", [address, "latest"], budget);
  if (code === null) {
    facts.notes.push("no RPC endpoint answered — on-chain facts unavailable");
    return facts;
  }
  if (code === "0x") {
    facts.notes.push(`no code at this address on ${chain} — it is an EOA, or the wrong chain`);
    return facts;
  }

  const codeLower = code.toLowerCase();
  facts.hasMintSelector = TRUST_SELECTORS.mint.some((s) => codeLower.includes(s));
  facts.hasPauseSelector = TRUST_SELECTORS.pause.some((s) => codeLower.includes(s));

  // EIP-1167 minimal proxy: the implementation address is embedded in the code.
  const clone = codeLower.match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d/);
  if (clone) {
    facts.implementation = "0x" + clone[1];
    facts.proxyType = "EIP-1167 minimal proxy";
  } else {
    const slot = await rpc<string>(chain, "eth_getStorageAt", [address, EIP1967_SLOT, "latest"], budget);
    const impl = decodeAddress(slot ?? null);
    if (impl) {
      facts.implementation = impl;
      facts.proxyType = "EIP-1967 upgradeable proxy";
    }
  }

  // ERC-20 surface. A non-token contract simply answers none of these, which is
  // itself the answer: the report then describes it as a contract, not a token.
  const [name, symbol, decimals, supply, owner] = await Promise.all([
    ethCall(chain, address, SEL.name, budget),
    ethCall(chain, address, SEL.symbol, budget),
    ethCall(chain, address, SEL.decimals, budget),
    ethCall(chain, address, SEL.totalSupply, budget),
    ethCall(chain, address, SEL.owner, budget),
  ]);
  facts.name = decodeString(name);
  facts.symbol = decodeString(symbol);
  const dec = decodeUint(decimals);
  // BigInt literals need an ES2020 target; this project compiles to ES2017.
  facts.decimals = dec !== undefined && dec <= BigInt(36) ? Number(dec) : undefined;
  facts.totalSupply = decodeUint(supply);
  facts.ownerAddress = decodeAddress(owner);

  await enrichFromExplorer(chain, address, facts, budget);
  return facts;
}

const BLOCKSCOUT: Partial<Record<ChainId, string>> = {
  eth: "https://eth.blockscout.com",
  base: "https://base.blockscout.com",
  rh: "https://robinhoodchain.blockscout.com",
};

const SCAN: Partial<Record<ChainId, { url: string; key?: string; limiter: string }>> = {
  bsc: { url: "https://api.bscscan.com/api", key: process.env.BSCSCAN_API_KEY, limiter: "bscscan" },
  base: { url: "https://api.basescan.org/api", key: process.env.BASESCAN_API_KEY, limiter: "basescan" },
};

/** Verified-source name, proxy label, creator and holder count. */
async function enrichFromExplorer(
  chain: ChainId,
  address: string,
  facts: OnChainFacts,
  budget: Budget
): Promise<void> {
  const blockscout = BLOCKSCOUT[chain];
  if (blockscout) {
    await rateLimit("robinscan");
    const sc = await getJson<{
      is_verified?: boolean;
      name?: string;
      proxy_type?: string;
      implementations?: { address_hash?: string; name?: string }[];
    }>(`${blockscout}/api/v2/smart-contracts/${address}`, budget, { timeoutMs: 12_000 });
    if (sc) {
      facts.verified = sc.is_verified ?? facts.verified;
      facts.contractName = sc.name ?? facts.contractName;
      if (sc.proxy_type && !facts.proxyType) facts.proxyType = sc.proxy_type;
      const impl = sc.implementations?.[0]?.address_hash;
      if (impl && !facts.implementation) facts.implementation = impl;
      // A proxy's own name is the clone's; the implementation's name is the one
      // worth printing ("LaunchToken" rather than "unnamed proxy").
      if (sc.implementations?.[0]?.name && (!facts.contractName || facts.proxyType)) {
        facts.contractName = sc.implementations[0].name;
        /*
         * And it counts as verified.
         *
         * Blockscout answers is_verified=false for a minimal-proxy clone — the
         * clone's own 45 bytes are not verified source — while the implementation
         * it delegates every call to is fully verified. Reporting that as "source
         * not verified" told the reader the opposite of the truth about the code
         * that actually runs.
         */
        if (facts.verified !== true) {
          facts.verified = true;
          facts.notes.push("verified via the implementation contract; the clone itself carries no source");
        }
      }
    }
    const addr = await getJson<{
      creator_address_hash?: string;
      creation_transaction_hash?: string;
      token?: { holders?: string; holders_count?: string };
    }>(`${blockscout}/api/v2/addresses/${address}`, budget, { timeoutMs: 12_000 });
    if (addr) {
      facts.creator = addr.creator_address_hash ?? facts.creator;
      facts.creationTx = addr.creation_transaction_hash ?? facts.creationTx;
      const h = addr.token?.holders_count ?? addr.token?.holders;
      if (h && Number.isFinite(Number(h))) facts.holderCount = Number(h);
    }
    return;
  }

  // *scan fallback, for chains where we hold a key.
  const scan = SCAN[chain];
  if (!scan || !scan.key) {
    facts.notes.push(`no verified-source lookup for ${chain} (no explorer key configured)`);
    return;
  }
  await rateLimit(scan.limiter);
  const res = await getJson<{ result?: { ContractName?: string; Proxy?: string; Implementation?: string }[] }>(
    `${scan.url}?module=contract&action=getsourcecode&address=${address}&apikey=${scan.key}`,
    budget,
    { timeoutMs: 12_000 }
  );
  const row = res?.result?.[0];
  if (row) {
    if (row.ContractName) {
      facts.contractName = row.ContractName;
      facts.verified = true;
    }
    if (row.Proxy === "1" && row.Implementation && !facts.implementation) {
      facts.implementation = row.Implementation;
      facts.proxyType = facts.proxyType ?? "explorer-flagged proxy";
    }
  }
}

// ── Solana ────────────────────────────────────────────────────────────────────

/**
 * SPL mint facts. The two that matter are the authorities: a live mint authority
 * means supply is not fixed whatever the docs say, and a freeze authority means
 * balances can be frozen.
 */
export async function inspectSolana(mint: string, budget: Budget): Promise<OnChainFacts> {
  const facts: OnChainFacts = { chain: "solana", address: mint, notes: [] };
  const url = CHAIN_CONFIGS.solana.rpcUrl;
  await rateLimit("helius");
  const res = await postJson<{
    result?: {
      value?: {
        data?: {
          parsed?: {
            info?: {
              decimals?: number;
              supply?: string;
              mintAuthority?: string | null;
              freezeAuthority?: string | null;
            };
            type?: string;
          };
        };
        owner?: string;
      };
    };
  }>(url, { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }, budget);

  const info = res?.result?.value?.data?.parsed?.info;
  if (!info) {
    facts.notes.push("Solana account is not a parseable SPL mint (program, PDA, or unfunded address)");
    return facts;
  }
  facts.decimals = info.decimals;
  if (info.supply) {
    try {
      facts.totalSupply = BigInt(info.supply);
    } catch {
      /* unparseable supply — left undefined rather than guessed */
    }
  }
  // Both authorities are reported either way. "Revoked" is the fact a holder
  // actually wants, and only printing the alarming case leaves a clean mint
  // looking unexamined.
  if (info.mintAuthority) {
    facts.ownerAddress = info.mintAuthority;
    facts.hasMintSelector = true;
    facts.notes.push(`mint authority is LIVE: ${info.mintAuthority} — supply can be increased at will`);
  } else {
    facts.hasMintSelector = false;
    facts.notes.push("mint authority is revoked — supply cannot be increased");
  }
  facts.notes.push(
    info.freezeAuthority
      ? `freeze authority is LIVE: ${info.freezeAuthority} — balances can be frozen`
      : "freeze authority is revoked — balances cannot be frozen"
  );
  return facts;
}

/**
 * Which chain does this EVM address have code on?
 *
 * Used when DexScreener has never seen the address — an infrastructure contract
 * (a factory, a locker, a router) has no pair and therefore no DexScreener entry,
 * and defaulting such an address to Ethereum would silently research the wrong
 * chain. Probing is one cheap `eth_getCode` per chain.
 */
export async function detectEvmChain(address: string, budget: Budget): Promise<ChainId | null> {
  for (const chain of ["eth", "base", "bsc", "rh"] as ChainId[]) {
    if (budgetSpent(budget)) return null;
    const code = await rpc<string>(chain, "eth_getCode", [address, "latest"], budget);
    if (code && code !== "0x") return chain;
  }
  return null;
}
