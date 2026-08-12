import { supabase } from "@/lib/supabase";
import { rateLimit } from "@/lib/rate-limiter";
import type { GmgnTopTrader } from "@/lib/api/gmgn-scraper";

// Storage for the daily ATH pipeline: which tokens reached the threshold, who
// deployed them, and who the top traders were. The trader corpus is the part
// that matters — cross-referencing today's runners against every past one is
// what surfaces a new alpha wallet.

export const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

// Factory → launchpad. The factory that deployed a token is deterministic per
// launchpad, which makes it a more reliable label than anything an indexer
// reports (DexScreener shows where liquidity currently sits, not the origin).
const FACTORY_LAUNCHPAD: Record<string, string> = {
  "0x000000e200088d55c39a11f609e5f667729ad49b": "pools.trade",
  "0x3711cea4feade896c913c68f01eda97cb06d1a42": "pons",
};

/**
 * Addresses that are infrastructure, not traders.
 *
 * GMGN's top-trader list is derived from token flow, so contracts that hold or
 * route a token appear in it — the V4 PoolManager shows up in essentially every
 * token on the chain and will otherwise be promoted as the most prolific trader
 * alive. It was filtered out of the research pipeline for exactly this reason;
 * the daily scan is a second path to the same table and needs the same guard.
 */
export const KNOWN_INFRA = new Set(
  [
    "0x0000000000000000000000000000000000000000", // zero
    "0x000000000000000000000000000000000000dead", // burn
    "0x8366a39cc670b4001a1121b8f6a443a643e40951", // Uniswap V4 PoolManager
    "0x000000e200088d55c39a11f609e5f667729ad49b", // UERC20Factory (pools.trade)
    "0x22e99278308b393ea1260859b181ad7e78f5eeed", // LongLauncher
    "0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09", // Flap portal
    "0x3711cea4feade896c913c68f01eda97cb06d1a42", // Pons factory
    "0x0000000068f116a894984e2db1123eb395",       // Seaport (truncated form guard)
  ].map((a) => a.toLowerCase())
);

const contractCache = new Map<string, boolean>();

/** Whether an address has code — i.e. is a contract rather than a wallet. */
export async function isContractAddress(address: string): Promise<boolean> {
  const addr = address.toLowerCase();
  if (KNOWN_INFRA.has(addr)) return true;
  const cached = contractCache.get(addr);
  if (cached !== undefined) return cached;

  await rateLimit("robinscan");
  try {
    const res = await fetch(`${RH_EXPLORER}/api/v2/addresses/${addr}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const d = await res.json();
    const isContract = d?.is_contract === true;
    contractCache.set(addr, isContract);
    return isContract;
  } catch {
    return false; // unknown -> treat as a wallet, and say so where it matters
  }
}

/**
 * Tokenized equities — real-world stocks issued on-chain, not launched coins.
 *
 * They clear a $2M market cap trivially (NVDA sat at $3.9M, SPCX at $2.4M with
 * 38k and 31k holders weeks after issue) but nothing about them is a launch:
 * their ATH equals their current cap because the price tracks an underlying
 * share, and their "deployer" is whoever issued the stock contract, not a dev.
 * Left in, they pollute the runner list, the trader corpus and the deployer
 * list all at once.
 *
 * Matched on the issuer's naming convention rather than a symbol denylist, so
 * every future tokenized stock is excluded automatically instead of needing a
 * new entry each time. Robinhood names these "NVIDIA • Robinhood Token"; the
 * bullet is part of the convention but is not required to match, since a
 * unicode character is a fragile thing to depend on.
 */
export function isTokenizedStock(symbol: string | null, name: string | null): boolean {
  const n = (name ?? "").toLowerCase();
  if (n.includes("robinhood token")) return true;
  // Other issuers' conventions seen on this chain and on BNB Chain's bStocks.
  if (/\b(tokenized|xstock|backed by)\b/.test(n)) return true;
  if (/•\s*(robinhood|ondo|backed)/i.test(name ?? "")) return true;
  const s = (symbol ?? "").toUpperCase();
  return ["NVDA", "SPCX", "AAPL", "TSLA", "MSFT", "META", "GOOGL", "AMZN", "SPY", "QQQ", "GME", "HOOD", "PLTR"].includes(s);
}

export interface AthTokenInput {
  chain: string;
  tokenAddress: string;
  name: string | null;
  symbol: string | null;
  launchpad: string | null;
  deployerAddress: string | null;
  athMcUsd: number | null;
  athAt: string | null;
  currentMcUsd: number | null;
  holders: number | null;
  totalSupply: number | null;
  poolAddress: string | null;
  launchedAt: string | null;
  source: string;
}

/**
 * Who created a token contract.
 *
 * Blockscout's v1 `getcontractcreation` returns null on this chain for every
 * token tried, so the v2 address endpoint is the source — it carries
 * `creator_address_hash` reliably.
 *
 * That creator is the factory when a launchpad deployed the token, and the
 * user's own address when it didn't. Both are wanted: the factory identifies
 * the launchpad, while the human behind it is the deployer worth tracking. When
 * the creator is a known factory we follow the creation transaction to its
 * sender to recover the person.
 */
export async function fetchDeployer(
  tokenAddress: string
): Promise<{ deployer: string | null; factory: string | null }> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(`${RH_EXPLORER}/api/v2/addresses/${tokenAddress}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { deployer: null, factory: null };
    const d = await res.json();
    const creator = d?.creator_address_hash ? String(d.creator_address_hash).toLowerCase() : null;
    if (!creator) return { deployer: null, factory: null };

    // Whether the creator is a factory is decided by asking the chain, not by a
    // hardcoded list. Launchpads we haven't catalogued would otherwise be
    // recorded as prolific "deployers" — one such contract looked like a dev
    // behind 6 separate $2M runners when it was simply the launchpad everyone
    // used.
    let isFactory = creator in FACTORY_LAUNCHPAD;
    if (!isFactory) {
      await rateLimit("robinscan");
      try {
        const cRes = await fetch(`${RH_EXPLORER}/api/v2/addresses/${creator}`, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(15_000),
        });
        if (cRes.ok) isFactory = (await cRes.json())?.is_contract === true;
      } catch {
        /* treat as an EOA on failure — see below */
      }
    }
    if (!isFactory) return { deployer: creator, factory: null };

    // Launchpad-deployed: the creation tx's sender is the actual person.
    const txHash = d?.creation_transaction_hash;
    if (!txHash) return { deployer: null, factory: creator };
    await rateLimit("robinscan");
    const txRes = await fetch(`${RH_EXPLORER}/api/v2/transactions/${txHash}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!txRes.ok) return { deployer: null, factory: creator };
    const tx = await txRes.json();
    const from = tx?.from?.hash ? String(tx.from.hash).toLowerCase() : null;
    return { deployer: from, factory: creator };
  } catch {
    return { deployer: null, factory: null };
  }
}

export function launchpadFromFactory(factory: string | null): string | null {
  if (!factory) return null;
  return FACTORY_LAUNCHPAD[factory.toLowerCase()] ?? null;
}

/** Holder count for a token, from Blockscout. */
export async function fetchHolders(tokenAddress: string): Promise<number | null> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(`${RH_EXPLORER}/api/v2/tokens/${tokenAddress}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const n = parseInt(String(d?.holders_count ?? d?.holders ?? ""), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Insert or refresh an ATH token. Returns its row id. */
export async function upsertAthToken(t: AthTokenInput): Promise<string | null> {
  const { data, error } = await supabase
    .from("ath_tokens")
    .upsert(
      {
        chain: t.chain,
        token_address: t.tokenAddress.toLowerCase(),
        name: t.name,
        symbol: t.symbol,
        launchpad: t.launchpad,
        deployer_address: t.deployerAddress,
        ath_mc_usd: t.athMcUsd,
        ath_at: t.athAt,
        current_mc_usd: t.currentMcUsd,
        current_mc_updated_at: t.currentMcUsd != null ? new Date().toISOString() : null,
        holders: t.holders,
        total_supply: t.totalSupply,
        pool_address: t.poolAddress,
        launched_at: t.launchedAt,
        source: t.source,
      },
      { onConflict: "chain,token_address" }
    )
    .select("id")
    .single();
  if (error) {
    console.error("[ath] upsert token failed:", error.message);
    return null;
  }
  return data?.id ?? null;
}

/**
 * Record a deployer, with its token count DERIVED from ath_tokens rather than
 * incremented. Incrementing looks simpler but is wrong under replay: a re-run of
 * the backfill, or a token re-scanned on a later day, would inflate the count
 * and make a one-hit deployer look prolific. Counting the rows is idempotent.
 */
export async function upsertDeployer(chain: string, address: string | null): Promise<void> {
  if (!address) return;
  const addr = address.toLowerCase();

  const { count } = await supabase
    .from("ath_tokens")
    .select("*", { count: "exact", head: true })
    .eq("chain", chain)
    .eq("deployer_address", addr);

  const { error } = await supabase.from("token_deployers").upsert(
    {
      chain,
      address: addr,
      ath_token_count: count ?? 1,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "chain,address" }
  );
  if (error) console.error("[ath] upsert deployer failed:", error.message);
}

const iso = (s: number | null) => (s && s > 0 ? new Date(s * 1000).toISOString() : null);

/** Persist a token's top traders. `supply` turns average prices into market caps. */
export async function saveTokenTraders(
  tokenId: string,
  chain: string,
  tokenAddress: string,
  tokenSymbol: string | null,
  traders: GmgnTopTrader[],
  supply: number | null,
  isBot: (addr: string) => { bot: boolean; reason: string | null }
): Promise<number> {
  if (traders.length === 0) return 0;
  const rows = traders.map((t, i) => {
    const invested = t.historyBoughtCostUsd;
    const total = t.realizedProfitUsd + t.unrealizedProfitUsd;
    const flag = isBot(t.walletAddress.toLowerCase());
    return {
      token_id: tokenId,
      chain,
      token_address: tokenAddress.toLowerCase(),
      token_symbol: tokenSymbol,
      wallet_address: t.walletAddress.toLowerCase(),
      rank: i + 1,
      amount_invested_usd: invested,
      avg_entry_price_usd: t.avgCostUsd,
      entry_mc_usd: supply && t.avgCostUsd ? t.avgCostUsd * supply : null,
      amount_sold_usd: t.historySoldIncomeUsd,
      avg_exit_price_usd: t.avgSoldUsd,
      exit_mc_usd: supply && t.avgSoldUsd ? t.avgSoldUsd * supply : null,
      realized_pnl_usd: t.realizedProfitUsd,
      unrealized_pnl_usd: t.unrealizedProfitUsd,
      total_pnl_usd: total,
      roi_pct: invested > 0 ? (total / invested) * 100 : null,
      buy_count: t.buyCount,
      sell_count: t.sellCount,
      tx_count: t.buyCount + t.sellCount,
      current_balance: t.balance,
      current_balance_usd: t.balanceUsd,
      supply_pct: t.supplyPercent,
      first_buy_at: iso(t.openTimestamp),
      last_active_at: iso(t.lastActiveTimestamp),
      is_bot: flag.bot,
      bot_reason: flag.reason,
    };
  });

  const { error } = await supabase
    .from("ath_token_traders")
    .upsert(rows, { onConflict: "token_address,wallet_address" });
  if (error) {
    console.error("[ath] save traders failed:", error.message);
    return 0;
  }
  await supabase.from("ath_tokens").update({ traders_captured_at: new Date().toISOString() }).eq("id", tokenId);
  return rows.length;
}

export interface WalletAppearance {
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  rank: number | null;
  totalPnlUsd: number | null;
  amountInvestedUsd: number | null;
  entryMcUsd: number | null;
  exitMcUsd: number | null;
  roiPct: number | null;
  txCount: number | null;
}

/**
 * Every non-bot appearance for the given wallets, across ALL recorded ATH
 * tokens. This is the cross-reference: a wallet returned here for two or more
 * distinct tokens has repeated across independent winners.
 */
export async function appearancesForWallets(
  chain: string,
  wallets: string[]
): Promise<Map<string, WalletAppearance[]>> {
  const out = new Map<string, WalletAppearance[]>();
  if (wallets.length === 0) return out;

  // Chunked — a wallet list can outgrow a single URL-encoded IN clause.
  for (let i = 0; i < wallets.length; i += 100) {
    const batch = wallets.slice(i, i + 100);
    const { data, error } = await supabase
      .from("ath_token_traders")
      .select("wallet_address, token_address, token_symbol, rank, total_pnl_usd, amount_invested_usd, entry_mc_usd, exit_mc_usd, roi_pct, tx_count")
      .eq("chain", chain)
      .eq("is_bot", false)
      .in("wallet_address", batch);
    if (error) {
      console.error("[ath] cross-reference failed:", error.message);
      continue;
    }
    for (const r of data ?? []) {
      const key = String(r.wallet_address).toLowerCase();
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push({
        walletAddress: key,
        tokenAddress: r.token_address,
        tokenSymbol: r.token_symbol,
        rank: r.rank,
        totalPnlUsd: r.total_pnl_usd,
        amountInvestedUsd: r.amount_invested_usd,
        entryMcUsd: r.entry_mc_usd,
        exitMcUsd: r.exit_mc_usd,
        roiPct: r.roi_pct,
        txCount: r.tx_count,
      });
    }
  }
  return out;
}

/** Token addresses already recorded, so a scan skips what it has seen. */
export async function knownAthTokens(chain: string): Promise<Set<string>> {
  const { data, error } = await supabase.from("ath_tokens").select("token_address").eq("chain", chain);
  if (error) {
    console.error("[ath] load known tokens failed:", error.message);
    return new Set();
  }
  return new Set((data ?? []).map((r) => String(r.token_address).toLowerCase()));
}
