import { supabase } from "@/lib/supabase";
import { rateLimit } from "@/lib/rate-limiter";
import { labelToken, CHAIN_PREFIX } from "@/lib/api/alpha-wallets";
import { RH_EXPLORER } from "@/lib/api/ath-tokens";

// Alpha deployers — devs behind two or more tokens that reached a $2M ATH.

/** A token only counts as a hit if it ran this far from its launch market cap. */
export const SUCCESS_MULTIPLE = 20;
/** Deployers need at least this many ATH tokens to be tracked. */
export const MIN_ATH_TOKENS = 2;

export interface DeployerToken {
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  athMcUsd: number | null;
  currentMcUsd: number | null;
  deployMcUsd: number | null;
  athMultiple: number | null;
  launchedAt: string | null;
}

export interface AlphaDeployer {
  id: string;
  address: string;
  label: string | null;
  tokenCount: number;
  success20xCount: number;
  tokens: string[];
  lastSeenTx: string | null;
}

/**
 * Label a deployer: <CHAIN>_<coin1>_<coin2>_Dep, e.g. RH_sestri_frong_Dep.
 * The trailing Dep is constant and marks the address as a builder rather than a
 * trader, so the two lists never read alike.
 */
export function buildDeployerLabel(chain: string, tokens: string[]): string {
  const prefix = CHAIN_PREFIX[chain.toLowerCase()] ?? chain.toUpperCase();
  const picked = tokens.slice(0, 2).map(labelToken);
  while (picked.length < 2) picked.push("na");
  return `${prefix}_${picked.join("_")}_Dep`;
}

/**
 * Market cap a token launched at, taken from its EARLIEST pool.
 *
 * Using the deepest pool — the obvious choice — is wrong here: a token that
 * migrated off its bonding curve has a deeper post-migration pool whose first
 * candle opens well after launch. Measured that way CASHCAT appeared to launch
 * at $117M and therefore to have gone 1.8x, when the number that matters is
 * what it opened at on its original pool.
 */
export async function fetchDeployMc(tokenAddress: string, supply: number): Promise<number | null> {
  await rateLimit("geckoterminal");
  try {
    const infoRes = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${tokenAddress}?include=top_pools`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }
    );
    if (!infoRes.ok) return null;
    const info = await infoRes.json();
    const pools = (info?.included ?? []).filter((x: { type?: string }) => x.type === "pool");
    if (pools.length === 0) return null;

    const earliest = pools.sort(
      (a: { attributes: { pool_created_at?: string } }, b: { attributes: { pool_created_at?: string } }) =>
        new Date(a.attributes.pool_created_at ?? 0).getTime() - new Date(b.attributes.pool_created_at ?? 0).getTime()
    )[0];

    await rateLimit("geckoterminal");
    const ohlcvRes = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${earliest.attributes.address}/ohlcv/hour?limit=1000&currency=usd`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }
    );
    if (!ohlcvRes.ok) return null;
    const o = await ohlcvRes.json();
    const list: number[][] = o?.data?.attributes?.ohlcv_list ?? [];
    if (list.length === 0) return null;

    // Hourly rather than daily: a bonding curve can run several multiples inside
    // its first day, and a daily open would already reflect that.
    const open = list[list.length - 1][1];
    if (!(open > 0)) return null;
    return open * supply;
  } catch {
    return null;
  }
}

/** Every ATH token attributed to a deployer. */
export async function tokensByDeployer(chain: string, deployer: string): Promise<DeployerToken[]> {
  const { data, error } = await supabase
    .from("ath_tokens")
    .select("token_address, symbol, name, ath_mc_usd, current_mc_usd, deploy_mc_usd, ath_multiple, launched_at")
    .eq("chain", chain)
    .eq("deployer_address", deployer.toLowerCase())
    .order("ath_mc_usd", { ascending: false });
  if (error) return [];
  return (data ?? []).map((r) => ({
    tokenAddress: r.token_address,
    symbol: r.symbol,
    name: r.name,
    athMcUsd: r.ath_mc_usd,
    currentMcUsd: r.current_mc_usd,
    deployMcUsd: r.deploy_mc_usd,
    athMultiple: r.ath_multiple,
    launchedAt: r.launched_at,
  }));
}

export function successRate(tokens: DeployerToken[]): { hits: number; total: number; pct: number } {
  // Only tokens we can measure count toward the denominator — an unknown launch
  // market cap is not a failure, and treating it as one would understate every
  // deployer with a migrated pool.
  const measurable = tokens.filter((t) => t.athMultiple != null);
  const hits = measurable.filter((t) => (t.athMultiple ?? 0) >= SUCCESS_MULTIPLE).length;
  return { hits, total: measurable.length, pct: measurable.length ? (hits / measurable.length) * 100 : 0 };
}

/**
 * Promote every deployer with enough ATH tokens. Idempotent: labels and counts
 * are recomputed from ath_tokens each time.
 */
export async function refreshAlphaDeployers(chain: string): Promise<AlphaDeployer[]> {
  const { data: rows } = await supabase
    .from("ath_tokens")
    .select("deployer_address")
    .eq("chain", chain)
    .not("deployer_address", "is", null);

  const counts = new Map<string, number>();
  for (const r of rows ?? []) {
    const a = String(r.deployer_address).toLowerCase();
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }

  const promoted: AlphaDeployer[] = [];
  for (const [address, count] of counts) {
    if (count < MIN_ATH_TOKENS) continue;

    const tokens = await tokensByDeployer(chain, address);
    const { hits } = successRate(tokens);
    const symbols = tokens.map((t) => t.symbol ?? "?");
    const label = buildDeployerLabel(chain, symbols);

    const { data, error } = await supabase
      .from("token_deployers")
      .upsert(
        {
          chain,
          address,
          token_count: count,
          tokens: symbols,
          label,
          is_alpha: true,
          promoted_at: new Date().toISOString(),
          success_20x_count: hits,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "chain,address" }
      )
      .select("id, address, label, token_count, success_20x_count, tokens, last_seen_tx")
      .single();
    if (error) {
      console.error("[deployers] promote failed:", error.message);
      continue;
    }
    promoted.push({
      id: data.id,
      address: data.address,
      label: data.label,
      tokenCount: data.token_count,
      success20xCount: data.success_20x_count,
      tokens: data.tokens ?? [],
      lastSeenTx: data.last_seen_tx ?? null,
    });
  }
  return promoted;
}

export async function loadAlphaDeployers(chain: string): Promise<AlphaDeployer[]> {
  const { data, error } = await supabase
    .from("token_deployers")
    .select("id, address, label, token_count, success_20x_count, tokens, last_seen_tx")
    .eq("chain", chain)
    .eq("is_alpha", true);
  if (error) return [];
  return (data ?? []).map((r) => ({
    id: r.id,
    address: r.address,
    label: r.label,
    tokenCount: r.token_count,
    success20xCount: r.success_20x_count,
    tokens: r.tokens ?? [],
    lastSeenTx: r.last_seen_tx ?? null,
  }));
}

export interface DeployerTx {
  hash: string;
  timestamp: string | null;
}

/** A deployer's most recent transactions, newest first. */
export async function recentTxs(address: string): Promise<DeployerTx[]> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(`${RH_EXPLORER}/api/v2/addresses/${address}/transactions`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const d = await res.json();
    return (d?.items ?? []).map((t: { hash: string; timestamp?: string }) => ({
      hash: t.hash,
      timestamp: t.timestamp ?? null,
    }));
  } catch {
    return [];
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Tokens newly minted inside a transaction.
 *
 * Detecting a launch by method name doesn't generalise — every launchpad names
 * its entrypoint differently, and a deployer's recent history is mostly fee
 * collection. A mint from the zero address is the same shape whoever built the
 * launchpad.
 */
export async function mintedTokensInTx(
  txHash: string
): Promise<Array<{ address: string; symbol: string | null; name: string | null }>> {
  await rateLimit("robinscan");
  try {
    const res = await fetch(`${RH_EXPLORER}/api/v2/transactions/${txHash}/token-transfers`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const d = await res.json();
    const out = new Map<string, { address: string; symbol: string | null; name: string | null }>();
    for (const t of d?.items ?? []) {
      const from = String(t?.from?.hash ?? "").toLowerCase();
      if (from !== ZERO) continue;
      const tok = t?.token ?? {};
      const addr = String(tok.address_hash ?? tok.address ?? "").toLowerCase();
      if (!addr) continue;
      out.set(addr, { address: addr, symbol: tok.symbol ?? null, name: tok.name ?? null });
    }
    return [...out.values()];
  } catch {
    return [];
  }
}

export async function markDeployerChecked(id: string, lastSeenTx: string | null): Promise<void> {
  await supabase
    .from("token_deployers")
    .update({ last_seen_tx: lastSeenTx, last_checked_at: new Date().toISOString() })
    .eq("id", id);
}
