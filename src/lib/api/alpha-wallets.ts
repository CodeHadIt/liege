import { supabase } from "@/lib/supabase";

// Alpha wallets — addresses that were top-30 traders across multiple tokens that
// reached a meaningful ATH market cap, with bots filtered out. The alert system
// fires on confluence: two or more buying the same token inside a short window.

export const CHAIN_PREFIX: Record<string, string> = {
  rh: "RH",
  bsc: "BSC",
  solana: "SOL",
  base: "BASE",
  ethereum: "ETH",
};

export interface AlphaWallet {
  id?: string;
  label: string;
  address: string;
  chain: string;
  tokenCount: number;
  tokens: string[];
  totalPnlUsd: number | null;
  totalInvestedUsd: number | null;
  aggregateRoiPct: number | null;
  bestRank: number | null;
  maxTxOnAToken: number | null;
  source: string | null;
  notes?: string | null;
  isActive?: boolean;
}

/**
 * Compact PnL for labels: 1.7M, 500k, 30k, 850.
 * Deliberately lowercase 'k' and uppercase 'M' to match the agreed convention.
 */
export function compactPnl(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const trim = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(1)).replace(/\.0$/, "");
  if (a >= 1e9) return `${sign}${trim(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}${trim(a / 1e3)}k`;
  return `${sign}${a.toFixed(0)}`;
}

/**
 * Normalise a ticker for use inside a label: lowercase, ASCII alphanumerics only.
 * Robinhood Chain has plenty of non-ASCII tickers (e.g. 币安人生), which would
 * make labels unusable as identifiers, so those fall back to a marker rather
 * than silently producing an empty segment.
 */
export function labelToken(symbol: string | null | undefined): string {
  const clean = (symbol ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean.slice(0, 14) || "tok";
}

/**
 * Build a label: <CHAIN>_<coin1>_<coin2>_<pnl> — e.g. RH_cashcat_tendies_1.7M.
 * `tokens` should already be ordered by the wallet's PnL contribution, so the
 * label names the two positions the wallet is actually known for.
 */
export function buildLabel(chain: string, tokens: string[], totalPnlUsd: number | null): string {
  const prefix = CHAIN_PREFIX[chain.toLowerCase()] ?? chain.toUpperCase();
  const picked = tokens.slice(0, 2).map(labelToken);
  while (picked.length < 2) picked.push("na");
  return `${prefix}_${picked.join("_")}_${compactPnl(totalPnlUsd)}`;
}

/**
 * Labels are derived from ticker + PnL, so two wallets can collide (same two
 * winners, similar PnL). Suffix duplicates so the label stays a usable key.
 */
export function dedupeLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((l) => {
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return n === 1 ? l : `${l}_${n}`;
  });
}

function toRow(w: AlphaWallet) {
  return {
    label: w.label,
    address: w.address.toLowerCase(),
    chain: w.chain,
    token_count: w.tokenCount,
    tokens: w.tokens,
    total_pnl_usd: w.totalPnlUsd,
    total_invested_usd: w.totalInvestedUsd,
    aggregate_roi_pct: w.aggregateRoiPct,
    best_rank: w.bestRank,
    max_tx_on_a_token: w.maxTxOnAToken,
    source: w.source,
    notes: w.notes ?? null,
    is_active: w.isActive ?? true,
    updated_at: new Date().toISOString(),
  };
}

/** Insert or refresh alpha wallets, keyed on (chain, address). */
export async function upsertAlphaWallets(wallets: AlphaWallet[]): Promise<number> {
  if (wallets.length === 0) return 0;
  const { error, count } = await supabase
    .from("alpha_wallets")
    .upsert(wallets.map(toRow), { onConflict: "chain,address", count: "exact" });
  if (error) throw new Error(`upsert alpha_wallets: ${error.message}`);
  return count ?? wallets.length;
}

/** Active alpha wallets for a chain, as a lowercase address → wallet map. */
export async function loadAlphaWallets(chain: string): Promise<Map<string, AlphaWallet & { id: string }>> {
  const { data, error } = await supabase
    .from("alpha_wallets")
    .select("*")
    .eq("chain", chain)
    .eq("is_active", true);
  if (error) throw new Error(`load alpha_wallets: ${error.message}`);

  const out = new Map<string, AlphaWallet & { id: string }>();
  for (const r of data ?? []) {
    out.set(String(r.address).toLowerCase(), {
      id: r.id,
      label: r.label,
      address: r.address,
      chain: r.chain,
      tokenCount: r.token_count,
      tokens: r.tokens ?? [],
      totalPnlUsd: r.total_pnl_usd,
      totalInvestedUsd: r.total_invested_usd,
      aggregateRoiPct: r.aggregate_roi_pct,
      bestRank: r.best_rank,
      maxTxOnAToken: r.max_tx_on_a_token,
      source: r.source,
      isActive: r.is_active,
    });
  }
  return out;
}
