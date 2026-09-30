// ── CoinGecko: the link graph, not the price ───────────────────────────────────
// DexScreener answers "what is this trading at". CoinGecko answers the question
// that actually unlocks a research run: "where does this project publish".
// Its contract endpoint returns the homepage, the whitepaper, the GitHub repos,
// the X handle and the project's own categories — which is how a bare contract
// address turns into a docs crawl.
//
// Free tier, no key needed. `COINGECKO_API_KEY` is honoured when present (demo
// key header) purely for the higher rate limit; nothing here requires it.

import { rateLimit } from "@/lib/rate-limiter";
import { getJson, type Budget } from "../fetcher";
import type { ChainId } from "@/types/chain";

const BASE = "https://api.coingecko.com/api/v3";

/** CoinGecko's asset-platform ids for the chains we support. */
const PLATFORM: Partial<Record<ChainId, string>> = {
  eth: "ethereum",
  bsc: "binance-smart-chain",
  base: "base",
  solana: "solana",
  // Robinhood Chain is not an asset platform on CoinGecko — omitted deliberately
  // so a lookup reports "not listed" rather than guessing a neighbour chain.
};

export interface CoinGeckoCoin {
  id: string;
  symbol?: string;
  name?: string;
  categories?: (string | null)[];
  description?: { en?: string };
  links?: {
    homepage?: string[];
    whitepaper?: string;
    blockchain_site?: string[];
    official_forum_url?: string[];
    chat_url?: string[];
    twitter_screen_name?: string;
    telegram_channel_identifier?: string;
    repos_url?: { github?: string[] };
  };
  market_data?: {
    current_price?: Record<string, number>;
    market_cap?: Record<string, number>;
    fully_diluted_valuation?: Record<string, number>;
    total_volume?: Record<string, number>;
    circulating_supply?: number;
    total_supply?: number;
    max_supply?: number;
    ath?: Record<string, number>;
    ath_date?: Record<string, string>;
    price_change_percentage_24h?: number;
  };
  community_data?: { twitter_followers?: number; telegram_channel_user_count?: number };
  developer_data?: { stars?: number; forks?: number; commit_count_4_weeks?: number };
  genesis_date?: string;
  watchlist_portfolio_users?: number;
}

function headers(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  return key ? { "x-cg-demo-api-key": key } : {};
}

/** Look a token up by contract address. Null means "not listed", not "failed". */
export async function coinByContract(
  chain: ChainId,
  address: string,
  budget: Budget
): Promise<CoinGeckoCoin | null> {
  const platform = PLATFORM[chain];
  if (!platform) return null;
  await rateLimit("coingecko");
  return getJson<CoinGeckoCoin>(
    `${BASE}/coins/${platform}/contract/${address}` +
      `?localization=false&tickers=false&market_data=true&community_data=true&developer_data=true&sparkline=false`,
    budget,
    { headers: headers(), timeoutMs: 15_000 }
  );
}

export interface CoinGeckoSearchHit {
  id: string;
  name: string;
  symbol: string;
  market_cap_rank?: number | null;
}

/** Name/ticker search, for when the user typed a word rather than an address. */
export async function searchCoins(query: string, budget: Budget): Promise<CoinGeckoSearchHit[]> {
  await rateLimit("coingecko");
  const data = await getJson<{ coins?: CoinGeckoSearchHit[] }>(
    `${BASE}/search?query=${encodeURIComponent(query)}`,
    budget,
    { headers: headers() }
  );
  return data?.coins ?? [];
}

/** Full record by CoinGecko id — the follow-up to a search hit. */
export async function coinById(id: string, budget: Budget): Promise<CoinGeckoCoin | null> {
  await rateLimit("coingecko");
  return getJson<CoinGeckoCoin>(
    `${BASE}/coins/${id}` +
      `?localization=false&tickers=false&market_data=true&community_data=true&developer_data=true&sparkline=false`,
    budget,
    { headers: headers() }
  );
}

/** Every external link CoinGecko knows, flattened and de-duplicated. */
export function linksOf(coin: CoinGeckoCoin): string[] {
  const l = coin.links ?? {};
  const out = [
    ...(l.homepage ?? []),
    ...(l.official_forum_url ?? []),
    ...(l.chat_url ?? []),
    ...(l.repos_url?.github ?? []),
    l.whitepaper ?? "",
    l.twitter_screen_name ? `https://x.com/${l.twitter_screen_name}` : "",
    l.telegram_channel_identifier ? `https://t.me/${l.telegram_channel_identifier}` : "",
  ];
  return [...new Set(out.map((s) => (s ?? "").trim()).filter((s) => /^https?:\/\//.test(s)))];
}
