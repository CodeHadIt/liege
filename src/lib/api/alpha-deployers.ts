import { supabase } from "@/lib/supabase";
import { rateLimit } from "@/lib/rate-limiter";
import { labelToken, CHAIN_PREFIX } from "@/lib/api/alpha-wallets";
import { RH_EXPLORER } from "@/lib/api/ath-tokens";
import { scrapeGmgnDevTokens } from "@/lib/api/gmgn-scraper";

// Alpha deployers — devs behind two or more tokens that reached a $2M ATH.

/**
 * Launch market cap is a constant, not a measurement.
 *
 * Deriving it per token was unreliable — it came from a pool's first candle, and
 * any token that migrated off its bonding curve has a deeper pool that opens
 * long after launch (CASHCAT read as launching at $117M, so a 4,000x run looked
 * like 1.8x). Bonding curves here start around $5k, so fixing the base makes
 * "20x" mean exactly $100k ATH for every token, comparably.
 */
export const LAUNCH_MC_USD = 5_000;
export const SUCCESS_MULTIPLE = 20;
/** A deploy counts as a hit at or above this ATH market cap. */
export const SUCCESS_ATH_MC_USD = LAUNCH_MC_USD * SUCCESS_MULTIPLE; // $100k

/** Multiple achieved from the fixed launch base. */
export function athMultiple(athMcUsd: number | null | undefined): number | null {
  if (athMcUsd == null || !Number.isFinite(athMcUsd)) return null;
  return athMcUsd / LAUNCH_MC_USD;
}
/** Deployers need at least this many ATH tokens to be tracked. */
export const MIN_ATH_TOKENS = 2;

export interface DeployerToken {
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  athMcUsd: number | null;
  currentMcUsd: number | null;
  launchedAt: string | null;
  /** reached $100k ATH */
  isSuccess: boolean;
}

export interface AlphaDeployer {
  id: string;
  address: string;
  label: string | null;
  /** deploys that reached the $2M ATH bar — the runners */
  athTokenCount: number;
  /** deploys that reached $100k ATH */
  success20xCount: number;
  /** every token ever shipped — the success-rate denominator */
  totalDeploys: number;
  /** symbols of the $2M runners */
  athTokenSymbols: string[];
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

/** Every ATH token attributed to a deployer. */
export async function tokensByDeployer(chain: string, deployer: string): Promise<DeployerToken[]> {
  const { data, error } = await supabase
    .from("ath_tokens")
    .select("token_address, symbol, name, ath_mc_usd, current_mc_usd, launched_at")
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
    launchedAt: r.launched_at,
    isSuccess: (r.ath_mc_usd ?? 0) >= SUCCESS_ATH_MC_USD,
  }));
}

/**
 * Success rate over EVERY token a dev deployed, from deployer_launches.
 *
 * Computing it from ath_tokens would always return 100%: a token only enters
 * that table by clearing $2M, so the failures — which are the whole point of a
 * rate — are missing by construction.
 */
export async function deployerSuccessRate(
  chain: string,
  deployer: string
): Promise<{ hits: number; total: number; pct: number }> {
  const addr = deployer.toLowerCase();
  const { count: total } = await supabase
    .from("deployer_launches")
    .select("*", { count: "exact", head: true })
    .eq("chain", chain)
    .eq("deployer_address", addr);
  const { count: hits } = await supabase
    .from("deployer_launches")
    .select("*", { count: "exact", head: true })
    .eq("chain", chain)
    .eq("deployer_address", addr)
    .eq("is_success", true);
  const t = total ?? 0;
  return { hits: hits ?? 0, total: t, pct: t ? ((hits ?? 0) / t) * 100 : 0 };
}

/** Peak market cap for any token, on the fixed supply convention. */
export async function fetchAthMc(tokenAddress: string): Promise<number | null> {
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
    const deepest = pools.sort(
      (a: { attributes: { reserve_in_usd?: string } }, b: { attributes: { reserve_in_usd?: string } }) =>
        parseFloat(b.attributes.reserve_in_usd ?? "0") - parseFloat(a.attributes.reserve_in_usd ?? "0")
    )[0];

    await rateLimit("geckoterminal");
    const o = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${deepest.attributes.address}/ohlcv/day?limit=1000&currency=usd`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }
    );
    if (!o.ok) return null;
    const j = await o.json();
    const list: number[][] = j?.data?.attributes?.ohlcv_list ?? [];
    if (list.length === 0) return null;
    const high = Math.max(...list.map((c) => c[2]));
    return high > 0 ? high * 1_000_000_000 : null;
  } catch {
    return null;
  }
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
    const { hits, total } = await deployerSuccessRate(chain, address);
    const symbols = tokens.map((t) => t.symbol ?? "?");
    const label = buildDeployerLabel(chain, symbols);

    const { data, error } = await supabase
      .from("token_deployers")
      .upsert(
        {
          chain,
          address,
          ath_token_count: count,
          ath_token_symbols: symbols,
          label,
          is_alpha: true,
          promoted_at: new Date().toISOString(),
          success_20x_count: hits,
          total_deploys: total,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "chain,address" }
      )
      .select("id, address, label, ath_token_count, success_20x_count, total_deploys, ath_token_symbols, last_seen_tx")
      .single();
    if (error) {
      console.error("[deployers] promote failed:", error.message);
      continue;
    }
    promoted.push({
      id: data.id,
      address: data.address,
      label: data.label,
      athTokenCount: data.ath_token_count,
      success20xCount: data.success_20x_count,
      totalDeploys: data.total_deploys ?? 0,
      athTokenSymbols: data.ath_token_symbols ?? [],
      lastSeenTx: data.last_seen_tx ?? null,
    });
  }
  return promoted;
}

export async function loadAlphaDeployers(chain: string): Promise<AlphaDeployer[]> {
  const { data, error } = await supabase
    .from("token_deployers")
    .select("id, address, label, ath_token_count, success_20x_count, total_deploys, ath_token_symbols, last_seen_tx")
    .eq("chain", chain)
    .eq("is_alpha", true);
  if (error) return [];
  return (data ?? []).map((r) => ({
    id: r.id,
    address: r.address,
    label: r.label,
    athTokenCount: r.ath_token_count,
    success20xCount: r.success_20x_count,
    totalDeploys: r.total_deploys ?? 0,
    athTokenSymbols: r.ath_token_symbols ?? [],
    lastSeenTx: r.last_seen_tx ?? null,
  }));
}

export interface DeployerTx {
  hash: string;
  timestamp: string | null;
}

/**
 * A deployer's transactions, newest first.
 *
 * `maxPages` matters for history: one page is 50 transactions, and an active dev
 * fills that with fee collection in days. Building a success rate off a single
 * page found zero deploys for a dev with two known $2M runners, because their
 * launches sat further back than the page reached. The live watcher only needs
 * the head, so it stays on one page; the backfill walks deeper.
 */
export async function recentTxs(address: string, maxPages = 1): Promise<DeployerTx[]> {
  const out: DeployerTx[] = [];
  let params: Record<string, string> | null = null;

  for (let page = 0; page < maxPages; page++) {
    await rateLimit("robinscan");
    try {
      const qs = params ? "?" + new URLSearchParams(params).toString() : "";
      const res = await fetch(`${RH_EXPLORER}/api/v2/addresses/${address}/transactions${qs}`, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) break;
      const d = await res.json();
      const items = d?.items ?? [];
      for (const t of items) out.push({ hash: t.hash, timestamp: t.timestamp ?? null });
      const next = d?.next_page_params;
      if (!next || items.length === 0) break;
      params = Object.fromEntries(
        Object.entries(next).map(([k, v]) => [k, String(v)])
      ) as Record<string, string>;
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Token contracts created by a transaction.
 *
 * Two earlier approaches failed. Matching on method name doesn't generalise —
 * every launchpad names its entrypoint differently. Looking for a mint from the
 * zero address seemed universal but isn't: a factory deploy creates the token
 * without minting in the same transaction, and the deploy transactions here
 * carry ZERO token transfers.
 *
 * Contract creation shows up as a create/create2 INTERNAL transaction, which is
 * true however the launchpad is built. Each created address is then checked
 * against the token endpoint, since a deploy can also create non-token helpers.
 */
export async function createdTokensInTx(
  txHash: string
): Promise<Array<{ address: string; symbol: string | null; name: string | null }>> {
  await rateLimit("robinscan");
  let created: string[] = [];
  try {
    const res = await fetch(`${RH_EXPLORER}/api/v2/transactions/${txHash}/internal-transactions`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const d = await res.json();
    created = (d?.items ?? [])
      .map((i: { created_contract?: { hash?: string } }) => i?.created_contract?.hash)
      .filter((h: string | undefined): h is string => !!h)
      .map((h: string) => h.toLowerCase());
  } catch {
    return [];
  }
  if (created.length === 0) return [];

  const out: Array<{ address: string; symbol: string | null; name: string | null }> = [];
  for (const addr of [...new Set(created)]) {
    await rateLimit("robinscan");
    try {
      const r = await fetch(`${RH_EXPLORER}/api/v2/tokens/${addr}`, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) continue; // not a token
      const t = await r.json();
      if (!t?.symbol && !t?.name) continue;
      out.push({ address: addr, symbol: t.symbol ?? null, name: t.name ?? null });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Replace a dev's recorded deploy history with GMGN's list.
 *
 * GMGN serves the dev's tokens with each one's ATH market cap already computed,
 * which is both the authoritative set and far cheaper than the alternative —
 * walking their transactions for create2 internals and pricing each result
 * through GeckoTerminal was ~100 requests for what this does in one.
 *
 * Rows are replaced rather than merged: the list is the full truth for that dev,
 * so anything we hold beyond it came from the older, less reliable walk.
 */
export async function syncDeployerTokensFromGmgn(
  chain: string,
  deployerId: string,
  devAddress: string
): Promise<{ total: number; hits: number } | null> {
  const info = await scrapeGmgnDevTokens(chain, devAddress);
  if (!info || info.tokens.length === 0) return null;

  const addr = devAddress.toLowerCase();
  await supabase.from("deployer_launches").delete().eq("chain", chain).eq("deployer_address", addr);

  const rows = info.tokens.map((t) => ({
    deployer_id: deployerId,
    chain,
    deployer_address: addr,
    token_address: t.tokenAddress,
    token_name: t.name,
    token_symbol: t.symbol,
    launched_at: t.createdAt ? new Date(t.createdAt * 1000).toISOString() : null,
    ath_mc_usd: t.athMcUsd,
    is_success: (t.athMcUsd ?? 0) >= SUCCESS_ATH_MC_USD,
    // Historical rows are recorded, never announced.
    alerted_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("deployer_launches")
    .upsert(rows, { onConflict: "chain,token_address" });
  if (error) {
    console.error("[deployers] gmgn sync failed:", error.message);
    return null;
  }
  return { total: rows.length, hits: rows.filter((r) => r.is_success).length };
}

export async function markDeployerChecked(id: string, lastSeenTx: string | null): Promise<void> {
  await supabase
    .from("token_deployers")
    .update({ last_seen_tx: lastSeenTx, last_checked_at: new Date().toISOString() })
    .eq("id", id);
}
