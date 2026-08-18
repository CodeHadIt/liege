/**
 * BNB Chain alpha discovery, via Dune.
 *
 * Robinhood Chain gets its runners from GeckoTerminal's ranked pool lists and
 * its top traders from GMGN's page scraper. Neither works here:
 *
 *   - GT's ranked lists are a snapshot of what is busy NOW, which cannot find a
 *     token that peaked in July and died. A historical sweep needs history.
 *   - GT's internal wallet_tokens endpoint (the non-browser trader source) has
 *     no BSC coverage — the pool lookup returns null `base_token_id`.
 *   - GMGN's scraper does work on BSC, but it drives a real browser per token.
 *     Measured: three tokens produced no result in ten minutes, so a 739-token
 *     corpus is tens of hours. It stays available as a per-token fallback, never
 *     as the bulk path.
 *
 * Dune answers all three questions — which tokens peaked, who traded them, who
 * deployed them — from one dataset, in seconds, with no browser.
 */

const DUNE = "https://api.dune.com/api/v1";

/** Peak market cap that counts as a runner. Matches the Robinhood bar. */
export const BSC_ATH_THRESHOLD_USD = 2_000_000;

/**
 * Ceiling on a believable ATH. Thin pools print absurd highs — an early run of
 * this pipeline produced a token at 8.9e46 USD — and publishing one would
 * discredit the feed. Above this, hold back and log. Mirrors the Robinhood scan.
 */
export const BSC_PLAUSIBLE_MAX_ATH_USD = 500_000_000;

/** Top traders captured per token, matching Robinhood. */
export const BSC_TOP_N = 30;

/**
 * Assets that trade on BNB Chain but were not launched as memecoins here. They
 * clear $2M every day by definition and would otherwise dominate every scan.
 */
export const BSC_NOT_LAUNCHES = new Set([
  "usdt", "usdc", "busd", "dai", "usd1", "fdusd", "tusd", "usde", "susde",
  "wbnb", "bnb", "btcb", "btc", "eth", "weth", "wbeth", "steth", "weeth",
  "slisbnb", "ankrbnb", "stbnb", "cake", "xrp", "ada", "doge", "link", "matic",
  "dot", "ltc", "trx", "sol", "avax", "uni", "atom", "near", "fil", "icp",
  "etc", "bch", "mim",
]);

function headers(): Record<string, string> {
  const key = process.env.DUNE_API_KEY;
  if (!key) throw new Error("DUNE_API_KEY is not set");
  return { "X-Dune-API-Key": key, "Content-Type": "application/json" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Find this label's saved query, if it already exists.
 *
 * Queries are reused rather than created per run. The corpus has to be inlined
 * (Dune has no parameter type for "a few hundred addresses"), so an earlier
 * version created a fresh query each time — which hit `Max number of private
 * queries reached` after a handful of runs and would have broken the scheduled
 * scan permanently. One stable query per purpose, edited in place, has no cap.
 */
async function findQueryId(label: string): Promise<number | null> {
  try {
    const res = await fetch(`${DUNE}/queries?limit=200`, { headers: headers() });
    if (!res.ok) return null;
    const j = (await res.json()) as { queries?: { id: number; name: string }[] };
    return j.queries?.find((q) => q.name === `liege-${label}`)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Create-or-update, execute and drain one query.
 */
export async function duneQuery<T = Record<string, unknown>>(
  sql: string,
  label: string,
  opts: { limit?: number; timeoutMs?: number } = {}
): Promise<T[] | null> {
  const { limit = 20_000, timeoutMs = 900_000 } = opts;
  const h = headers();

  // The corpus is passed inline, so these request bodies run to tens of
  // kilobytes. A transient socket failure on one is normal and must not lose a
  // whole scan, so every leg retries rather than throwing.
  const post = async (url: string, body: string, what: string, method: "POST" | "PATCH" = "POST") => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(120_000) });
        if (res.ok) return await res.json();
        // 4xx other than rate limiting will not fix itself.
        if (res.status !== 429 && res.status < 500) {
          console.error(`[dune] ${what} ${label} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
          return null;
        }
      } catch (err) {
        console.warn(`[dune] ${what} ${label} attempt ${attempt + 1}: ${(err as Error).message}`);
      }
      await sleep(2_000 * (attempt + 1));
    }
    console.error(`[dune] ${what} ${label} failed after retries`);
    return null;
  };

  const existing = await findQueryId(label);
  let queryId: number;
  if (existing) {
    const updated = await post(
      `${DUNE}/query/${existing}`,
      JSON.stringify({ query_sql: sql }),
      "update",
      "PATCH"
    );
    if (!updated) return null;
    queryId = existing;
  } else {
    const created = (await post(
      `${DUNE}/query`,
      JSON.stringify({ name: `liege-${label}`, query_sql: sql, is_private: false }),
      "create"
    )) as { query_id: number } | null;
    if (!created) return null;
    queryId = created.query_id;
  }

  const started = (await post(
    `${DUNE}/query/${queryId}/execute`,
    // "large" is rejected on this plan; medium handles the whole-chain scans here.
    JSON.stringify({ performance: "medium" }),
    "execute"
  )) as { execution_id: string } | null;
  if (!started) return null;
  const { execution_id } = started;

  // Polling and draining are long-lived HTTP over minutes; a dropped socket here
  // is routine and must not abort a scan that has already done its work.
  const getJson = async (url: string, what: string): Promise<Record<string, unknown> | null> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, { headers: h, signal: AbortSignal.timeout(120_000) });
        if (res.ok) return await res.json();
        if (res.status !== 429 && res.status < 500) return null;
      } catch (err) {
        console.warn(`[dune] ${what} ${label} attempt ${attempt + 1}: ${(err as Error).message}`);
      }
      await sleep(2_000 * (attempt + 1));
    }
    return null;
  };

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(6_000);
    const s = (await getJson(`${DUNE}/execution/${execution_id}/status`, "status")) as
      | { state?: string; error?: unknown }
      | null;
    if (!s) continue; // transient — keep polling rather than lose the execution
    if (s.state === "QUERY_STATE_FAILED") {
      console.error(`[dune] ${label} failed:`, JSON.stringify(s.error ?? s).slice(0, 400));
      return null;
    }
    if (s.state !== "QUERY_STATE_COMPLETED") continue;

    const rows: T[] = [];
    const page = Math.min(limit, 20_000);
    for (let offset = 0; rows.length < limit; offset += page) {
      const r = (await getJson(
        `${DUNE}/execution/${execution_id}/results?limit=${page}&offset=${offset}`,
        "results"
      )) as { result?: { rows?: T[] } } | null;
      if (!r) return rows.length ? rows : null; // partial beats nothing, null beats a lie
      const batch = r.result?.rows ?? [];
      rows.push(...batch);
      if (batch.length < page) break;
    }
    return rows;
  }
  console.error(`[dune] ${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
  return null;
}

/** SQL VALUES list of token addresses, for joining a fixed corpus. */
function tokenValues(tokens: string[]): string {
  return tokens.map((t) => `(${t.toLowerCase()})`).join(",");
}

export interface BscCandidate {
  token: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  peak_price: number;
  p95_price: number;
  total_usd: number;
  trades: number;
  first_h: string;
  peak_h: string;
}

/**
 * Tokens worth pricing, with their peak hourly VWAP.
 *
 * The peak is a volume-weighted hourly price, not a per-trade max, and an hour
 * only counts with real activity behind it (`>= $5k` and `>= 25 trades`).
 * Without those guards a single thin print defines the all-time high and the
 * resulting market caps are nonsense rather than merely optimistic.
 *
 * Market cap is NOT computed here. Robinhood can assume 1e9 supply for every
 * launchpad token; BSC supplies vary by orders of magnitude, so the caller must
 * read `totalSupply` per token and multiply.
 */
export async function fetchBscCandidates(since: string, minVolumeUsd = 150_000) {
  return duneQuery<BscCandidate>(
    `
    WITH hourly AS (
      SELECT token_bought_address AS token,
             date_trunc('hour', block_time) AS h,
             sum(amount_usd) AS usd,
             sum(token_bought_amount) AS amt,
             count(*) AS trades
      FROM dex.trades
      WHERE blockchain='bnb'
        AND block_time >= TIMESTAMP '${since}'
        AND amount_usd BETWEEN 1 AND 5000000
        AND token_bought_amount > 0
      GROUP BY 1,2
      HAVING sum(amount_usd) >= 5000 AND count(*) >= 25
    ),
    agg AS (
      SELECT token,
             max(usd/amt) AS peak_price,
             approx_percentile(usd/amt, 0.95) AS p95_price,
             sum(usd) AS total_usd,
             sum(trades) AS trades,
             min(h) AS first_h,
             max_by(h, usd/amt) AS peak_h
      FROM hourly GROUP BY 1
    )
    SELECT a.token, t.symbol, t.name, t.decimals,
           a.peak_price, a.p95_price, a.total_usd, a.trades, a.first_h, a.peak_h
    FROM agg a
    LEFT JOIN tokens.erc20 t ON t.blockchain='bnb' AND t.contract_address=a.token
    WHERE a.total_usd >= ${minVolumeUsd}
    ORDER BY a.total_usd DESC
  `,
    "bsc-candidates",
    { limit: 20_000 }
  );
}

export interface BscTraderRow {
  token: string;
  wallet: string;
  bought_usd: number;
  sold_usd: number;
  trades: number;
  pnl_usd: number;
  rn: number;
}

/**
 * Top `BSC_TOP_N` traders per token by realised PnL.
 *
 * PnL is `sold_usd - bought_usd` over the window: cash out minus cash in. It is
 * not GMGN's "realized profit" and ignores tokens still held, so a wallet still
 * holding its winner scores lower here than it would on Robinhood. The $20k
 * promotion bar therefore means realised cash on BSC.
 *
 * The wallet is the transaction sender, not `taker` — aggregators and routers
 * appear as the taker on their own trades, which would credit the router.
 */
export async function fetchBscTopTraders(tokens: string[], since: string) {
  if (tokens.length === 0) return [];
  return duneQuery<BscTraderRow>(
    `
    WITH toks(token) AS (VALUES ${tokenValues(tokens)}),
    flows AS (
      SELECT d.tx_from AS wallet, d.token_bought_address AS token, d.amount_usd AS usd, 0 AS is_sell
      FROM dex.trades d JOIN toks t ON t.token = d.token_bought_address
      WHERE d.blockchain='bnb' AND d.block_time >= TIMESTAMP '${since}' AND d.amount_usd > 0
      UNION ALL
      SELECT d.tx_from AS wallet, d.token_sold_address AS token, d.amount_usd AS usd, 1 AS is_sell
      FROM dex.trades d JOIN toks t ON t.token = d.token_sold_address
      WHERE d.blockchain='bnb' AND d.block_time >= TIMESTAMP '${since}' AND d.amount_usd > 0
    ),
    per AS (
      SELECT token, wallet,
             sum(CASE WHEN is_sell=0 THEN usd ELSE 0 END) AS bought_usd,
             sum(CASE WHEN is_sell=1 THEN usd ELSE 0 END) AS sold_usd,
             count(*) AS trades
      FROM flows GROUP BY 1,2
    ),
    ranked AS (
      SELECT token, wallet, bought_usd, sold_usd, trades,
             (sold_usd - bought_usd) AS pnl_usd,
             row_number() OVER (PARTITION BY token ORDER BY (sold_usd - bought_usd) DESC) AS rn
      FROM per WHERE bought_usd > 0
    )
    SELECT token, wallet, bought_usd, sold_usd, trades, pnl_usd, rn
    FROM ranked WHERE rn <= ${BSC_TOP_N}
  `,
    "bsc-top-traders",
    { limit: tokens.length * BSC_TOP_N + 1000 }
  );
}

export interface BscDeployerRow {
  token: string;
  dev: string | null;
  factory: string | null;
  created_at: string;
}

/**
 * The wallet behind each token.
 *
 * `creation_traces."from"` is the *creating contract* for anything launched
 * through a factory — four.meme, a CREATE2 proxy — so using it names
 * infrastructure rather than a person. An early run of this produced a
 * "deployer" with 55 runners, which was a launchpad. The dev is the EOA that
 * sent the creation transaction; the factory is kept for launchpad attribution.
 */
export async function fetchBscDeployers(tokens: string[]) {
  if (tokens.length === 0) return [];
  return duneQuery<BscDeployerRow>(
    `
    WITH toks(token) AS (VALUES ${tokenValues(tokens)})
    SELECT ct.address AS token,
           tx."from"  AS dev,
           ct."from"  AS factory,
           ct.block_time AS created_at
    FROM bnb.creation_traces ct
    JOIN toks t ON t.token = ct.address
    LEFT JOIN bnb.transactions tx ON tx.hash = ct.tx_hash AND tx.block_time = ct.block_time
  `,
    "bsc-deployers",
    { limit: tokens.length + 1000 }
  );
}

/**
 * Minimum ratio of distinct selling wallets to distinct buying wallets.
 *
 * A honeypot lets people in and not out, so it shows many buyers and almost no
 * sellers. Healthy tokens run close to 1:1. Measured across 743 BNB Chain
 * runners, this bar removes ~30 tokens including several with 200+ buyers and
 * fewer than 5 sellers, while leaving every genuine runner in place.
 */
export const BSC_MIN_SELLER_RATIO = 0.10;

/** Below this, "market cap" is a handful of wallets trading with themselves. */
export const BSC_MIN_BUYERS = 25;

export interface BscExitLiquidity {
  token: string;
  buyers: number;
  sellers: number;
  buy_usd: number;
  sell_usd: number;
}

/**
 * Buy- and sell-side participation per token.
 *
 * Deliberately counts distinct WALLETS, not USD. Sell-USD/buy-USD is ~1.0 for
 * honeypots and healthy tokens alike — the wallets that can sell dump
 * everything — so the value ratio detects nothing. The wallet ratio is what
 * separates them.
 */
export async function fetchBscExitLiquidity(tokens: string[], since: string) {
  if (tokens.length === 0) return [];
  return duneQuery<BscExitLiquidity>(
    `
    WITH toks(token) AS (VALUES ${tokenValues(tokens)}),
    buys AS (
      SELECT d.token_bought_address AS token,
             count(distinct d.tx_from) AS buyers, sum(d.amount_usd) AS buy_usd
      FROM dex.trades d JOIN toks t ON t.token = d.token_bought_address
      WHERE d.blockchain='bnb' AND d.block_time >= TIMESTAMP '${since}' AND d.amount_usd > 0
      GROUP BY 1
    ),
    sells AS (
      SELECT d.token_sold_address AS token,
             count(distinct d.tx_from) AS sellers, sum(d.amount_usd) AS sell_usd
      FROM dex.trades d JOIN toks t ON t.token = d.token_sold_address
      WHERE d.blockchain='bnb' AND d.block_time >= TIMESTAMP '${since}' AND d.amount_usd > 0
      GROUP BY 1
    )
    SELECT b.token, b.buyers, coalesce(s.sellers,0) AS sellers,
           b.buy_usd, coalesce(s.sell_usd,0) AS sell_usd
    FROM buys b LEFT JOIN sells s ON s.token = b.token
  `,
    "bsc-exit-liquidity",
    { limit: tokens.length + 1000 }
  );
}
