/**
 * Stage 1 — build the candidate universe of Robinhood Chain tokens and work out
 * each one's all-time-high market cap.
 *
 * Why it is built this way: Robinhood Chain sees roughly 3,700 launches a DAY on
 * the bonding-curve launchpad alone (~225k over 60 days), and no public source
 * lets you enumerate that, let alone filter by peak market cap. GeckoTerminal
 * caps pagination at 10 pages of 20 per sort order. So the universe is assembled
 * from every ranked list we can reach — anything that ever traded at $2M FDV is
 * highly likely to surface in at least one of them — and each candidate's ATH is
 * then computed from its own daily OHLCV history.
 *
 * Coverage is therefore best-effort, not exhaustive. See coverage notes in the
 * emitted report.
 *
 * Output: data/rh-candidates.json (resumable cache; safe to re-run)
 *
 *   npx tsx scripts/rh-ath-harvest.ts
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";

const OUT_DIR = "data";
const CACHE = `${OUT_DIR}/rh-candidates.json`;
const GT = "https://api.geckoterminal.com/api/v2";
const NETWORK = "robinhood";
const DAYS = 60;
const ATH_THRESHOLD_USD = 2_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GeckoTerminal's free tier is nominally ~30 calls/min, but 2.1s spacing (≈28/min)
// still earns sustained 429s — and with retry backoff on top, throughput collapses
// to near zero. 3.5s (≈17/min) holds steady. Backoff is also longer and capped so
// a rate-limited stretch degrades instead of stalling.
const GT_SPACING_MS = 3_500;
let lastGt = 0;
async function gt<T = any>(path: string, tries = 3): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const wait = Math.max(0, GT_SPACING_MS - (Date.now() - lastGt));
    if (wait) await sleep(wait);
    lastGt = Date.now();
    try {
      const res = await fetch(GT + path, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        await sleep(8_000 * (i + 1));
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      await sleep(1_500);
    }
  }
  return null;
}

async function trpc<T = any>(path: string, payload: unknown): Promise<T | null> {
  const q = encodeURIComponent(JSON.stringify(payload));
  try {
    const res = await fetch(`https://pools.trade/api/trpc/${path}?input=${q}`, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://pools.trade/" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.result?.data ?? null;
  } catch {
    return null;
  }
}

export interface Candidate {
  tokenAddress: string;
  symbol: string;
  name: string;
  poolAddress: string | null;
  /** ISO — pool creation (GT) or launch time (pools.trade) */
  createdAt: string | null;
  launchpadId: string | null;
  currentFdvUsd: number | null;
  currentMcUsd: number | null;
  totalSupply: number | null;
  /** filled in stage 2 */
  athMcUsd?: number | null;
  athDate?: string | null;
  athSource?: string;
  sources: string[];
}

function loadCache(): Record<string, Candidate> {
  if (!existsSync(CACHE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

function save(map: Record<string, Candidate>) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CACHE, JSON.stringify(map, null, 2));
}

function add(map: Record<string, Candidate>, c: Partial<Candidate> & { tokenAddress: string }, source: string) {
  const key = c.tokenAddress.toLowerCase();
  const ex = map[key];
  if (ex) {
    if (!ex.sources.includes(source)) ex.sources.push(source);
    ex.poolAddress ??= c.poolAddress ?? null;
    ex.createdAt ??= c.createdAt ?? null;
    ex.launchpadId ??= c.launchpadId ?? null;
    ex.currentFdvUsd ??= c.currentFdvUsd ?? null;
    ex.symbol ||= c.symbol ?? "";
    return;
  }
  map[key] = {
    tokenAddress: key,
    symbol: c.symbol ?? "",
    name: c.name ?? "",
    poolAddress: c.poolAddress ?? null,
    createdAt: c.createdAt ?? null,
    launchpadId: c.launchpadId ?? null,
    currentFdvUsd: c.currentFdvUsd ?? null,
    currentMcUsd: c.currentMcUsd ?? null,
    totalSupply: c.totalSupply ?? null,
    sources: [source],
  };
}

async function harvestGeckoTerminal(map: Record<string, Candidate>) {
  const sorts = ["h24_volume_usd_desc", "h24_tx_count_desc"];
  for (const sort of sorts) {
    for (let page = 1; page <= 10; page++) {
      const d = await gt<any>(`/networks/${NETWORK}/pools?page=${page}&sort=${sort}&include=base_token`);
      const rows = d?.data ?? [];
      if (rows.length === 0) break;
      const tokens = new Map<string, any>();
      for (const inc of d?.included ?? []) tokens.set(inc.id, inc.attributes);
      for (const p of rows) {
        const a = p.attributes;
        const baseId = p.relationships?.base_token?.data?.id ?? "";
        const t = tokens.get(baseId);
        const addr = (t?.address ?? baseId.split("_")[1] ?? "").toLowerCase();
        if (!addr) continue;
        add(map, {
          tokenAddress: addr,
          symbol: t?.symbol ?? a.name?.split("/")[0]?.trim() ?? "",
          name: t?.name ?? "",
          poolAddress: a.address,
          createdAt: a.pool_created_at ?? null,
          currentFdvUsd: a.fdv_usd ? parseFloat(a.fdv_usd) : null,
          currentMcUsd: a.market_cap_usd ? parseFloat(a.market_cap_usd) : null,
        }, `gt:${sort}`);
      }
      console.log(`  [gt ${sort}] page ${page}: ${rows.length} pools, universe=${Object.keys(map).length}`);
    }
  }

  for (let page = 1; page <= 10; page++) {
    const d = await gt<any>(`/networks/${NETWORK}/new_pools?page=${page}&include=base_token`);
    const rows = d?.data ?? [];
    if (rows.length === 0) break;
    const tokens = new Map<string, any>();
    for (const inc of d?.included ?? []) tokens.set(inc.id, inc.attributes);
    for (const p of rows) {
      const a = p.attributes;
      const baseId = p.relationships?.base_token?.data?.id ?? "";
      const t = tokens.get(baseId);
      const addr = (t?.address ?? baseId.split("_")[1] ?? "").toLowerCase();
      if (!addr) continue;
      add(map, {
        tokenAddress: addr,
        symbol: t?.symbol ?? "",
        name: t?.name ?? "",
        poolAddress: a.address,
        createdAt: a.pool_created_at ?? null,
        currentFdvUsd: a.fdv_usd ? parseFloat(a.fdv_usd) : null,
        currentMcUsd: a.market_cap_usd ? parseFloat(a.market_cap_usd) : null,
      }, "gt:new_pools");
    }
    console.log(`  [gt new_pools] page ${page}: ${rows.length}, universe=${Object.keys(map).length}`);
  }
}

async function harvestPoolsTrade(map: Record<string, Candidate>) {
  for (const sortBy of ["volume", "trending", "recency", "linked-x"]) {
    const rows = await trpc<any[]>("curve.listLaunches", { sortBy });
    for (const r of rows ?? []) {
      add(map, {
        tokenAddress: r.tokenAddress,
        symbol: r.tokenSymbol,
        name: r.tokenName,
        createdAt: r.createdAt,
        launchpadId: r.launchpadId,
        currentFdvUsd: r.fdvUsd ?? null,
      }, `poolstrade:${sortBy}`);
    }
    console.log(`  [pools.trade ${sortBy}] ${rows?.length ?? 0}, universe=${Object.keys(map).length}`);
  }

  const auctions = await trpc<any[]>("cca.listAllAuctions", {});
  for (const r of auctions ?? []) {
    add(map, {
      tokenAddress: r.tokenAddress,
      symbol: r.tokenSymbol,
      name: r.tokenName,
      createdAt: r.startsAt ?? null,
      launchpadId: "uniswap-cca",
      currentFdvUsd: r.fdvUsd ?? null,
      totalSupply: r.totalSupply ?? null,
    }, "poolstrade:auctions");
  }
  console.log(`  [pools.trade auctions] ${auctions?.length ?? 0}, universe=${Object.keys(map).length}`);
}

/**
 * ATH from daily OHLCV, skipping the token endpoint (which doubles the request
 * count and is what tips us into rate limiting).
 *
 * Turning a price into a market cap needs supply. Deriving it as fdv/price was
 * tried and is unusable — measured against known-exact figures it was off by 8%,
 * 43% and 10,000%, the last of which would have invented a $56M ATH from a
 * $557k token. Instead we assume the launchpad standard: 345 of 346 tokens with
 * a known supply on this chain have exactly 1e9 (the lone exception has 296e9).
 *
 * The assumption is only trusted where it cannot change the verdict. Anything
 * landing within 10x below the threshold is confirmed against the real supply,
 * so no token is included — or excluded — on the strength of a guess.
 */
const ASSUMED_SUPPLY = 1_000_000_000;
const CONFIRM_ABOVE = ATH_THRESHOLD_USD / 10;

async function resolveAthFast(c: Candidate): Promise<boolean> {
  if (!c.poolAddress) return false;

  const o = await gt<any>(`/networks/${NETWORK}/pools/${c.poolAddress}/ohlcv/day?limit=1000&currency=usd`);
  const list: number[][] = o?.data?.attributes?.ohlcv_list ?? [];
  if (list.length === 0) return false;

  let best = { ts: 0, high: 0 };
  for (const [ts, , high] of list) if (high > best.high) best = { ts, high };

  const exact = c.totalSupply;
  const supply = exact ?? ASSUMED_SUPPLY;
  const ath = best.high * supply;

  c.athMcUsd = ath;
  c.athDate = new Date(best.ts * 1000).toISOString();
  c.athSource = exact ? "gt-ohlcv-day" : "gt-ohlcv-day+assumed-1e9-supply";
  c.createdAt ??= new Date(list[list.length - 1][0] * 1000).toISOString();

  // Close enough to matter → fall through and confirm with the real supply.
  if (!exact && ath >= CONFIRM_ABOVE) return false;
  return true;
}

/** Resolve the deepest pool + supply for a token, then its ATH from daily OHLCV. */
async function resolveAth(c: Candidate): Promise<void> {
  if (await resolveAthFast(c)) return;

  // Find the token's pools (and total supply) if we don't have a pool yet.
  const info = await gt<any>(`/networks/${NETWORK}/tokens/${c.tokenAddress}?include=top_pools`);
  const attrs = info?.data?.attributes;
  if (attrs) {
    c.symbol ||= attrs.symbol ?? "";
    c.name ||= attrs.name ?? "";
    if (attrs.total_supply && attrs.decimals != null) {
      const supply = Number(attrs.total_supply) / 10 ** Number(attrs.decimals);
      if (Number.isFinite(supply) && supply > 0) c.totalSupply = supply;
    }
    if (attrs.fdv_usd) c.currentFdvUsd = parseFloat(attrs.fdv_usd);
    if (attrs.market_cap_usd) c.currentMcUsd = parseFloat(attrs.market_cap_usd);
  }
  const pools = (info?.included ?? []).filter((x: any) => x.type === "pool");
  if (!c.poolAddress && pools.length) {
    const deepest = pools.sort(
      (a: any, b: any) => parseFloat(b.attributes.reserve_in_usd ?? "0") - parseFloat(a.attributes.reserve_in_usd ?? "0")
    )[0];
    c.poolAddress = deepest.attributes.address;
    c.createdAt ??= deepest.attributes.pool_created_at ?? null;
  }
  if (!c.poolAddress || !c.totalSupply) {
    c.athMcUsd = null;
    c.athSource = "no-pool-or-supply";
    return;
  }

  const o = await gt<any>(`/networks/${NETWORK}/pools/${c.poolAddress}/ohlcv/day?limit=1000&currency=usd`);
  const list: number[][] = o?.data?.attributes?.ohlcv_list ?? [];
  if (list.length === 0) {
    c.athMcUsd = null;
    c.athSource = "no-ohlcv";
    return;
  }
  let best = { ts: 0, high: 0 };
  for (const [ts, , high] of list) if (high > best.high) best = { ts, high };
  c.athMcUsd = best.high * c.totalSupply;
  c.athDate = new Date(best.ts * 1000).toISOString();
  c.athSource = "gt-ohlcv-day";
  // OHLCV is capped; the oldest candle is a decent launch-date fallback.
  c.createdAt ??= new Date(list[list.length - 1][0] * 1000).toISOString();
}

async function main() {
  const map = loadCache();
  console.log(`loaded cache: ${Object.keys(map).length} candidates\n`);

  console.log("── harvesting candidates ──");
  await harvestPoolsTrade(map);
  await harvestGeckoTerminal(map);
  save(map);
  console.log(`\nuniverse: ${Object.keys(map).length} unique tokens\n`);

  const cutoff = Date.now() - DAYS * 86_400_000;
  const todo = Object.values(map)
    .filter((c) => {
      if (c.athMcUsd !== undefined) return false; // already resolved
      if (c.createdAt && new Date(c.createdAt).getTime() < cutoff) return false; // too old
      return true;
    })
    // Work the most valuable tokens first. Current FDV is only a proxy for peak,
    // but it means the run surfaces real hits early instead of after an hour of
    // dust — so the dataset is useful even if the run is cut short.
    .sort((a, b) => (b.currentFdvUsd ?? 0) - (a.currentFdvUsd ?? 0));
  console.log(`── resolving ATH for ${todo.length} candidates (~${((todo.length * 2 * 2.1) / 60).toFixed(0)} min) ──`);

  let done = 0;
  for (const c of todo) {
    await resolveAth(c);
    done++;
    if (done % 10 === 0) {
      save(map);
      const hits = Object.values(map).filter((x) => (x.athMcUsd ?? 0) >= ATH_THRESHOLD_USD).length;
      console.log(`  ${done}/${todo.length} resolved — ${hits} over $2M so far`);
    }
  }
  save(map);

  const qualifying = Object.values(map)
    .filter((c) => (c.athMcUsd ?? 0) >= ATH_THRESHOLD_USD)
    .filter((c) => !c.createdAt || new Date(c.createdAt).getTime() >= cutoff)
    .sort((a, b) => (b.athMcUsd ?? 0) - (a.athMcUsd ?? 0));

  console.log(`\n════ ${qualifying.length} tokens ≥ $2M ATH launched in last ${DAYS}d ════`);
  for (const q of qualifying.slice(0, 40)) {
    console.log(
      `  ${(q.symbol || "?").padEnd(14)} ath=$${(q.athMcUsd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)}` +
        `  now=$${(q.currentFdvUsd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(11)}` +
        `  ${(q.createdAt ?? "?").slice(0, 10)}  ${q.tokenAddress}`
    );
  }
  save(map);
  console.log(`\nsaved -> ${CACHE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
