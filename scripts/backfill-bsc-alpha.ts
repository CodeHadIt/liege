/**
 * Backfill BNB Chain alpha wallets and deployers from a window of $2M runners.
 *
 *   npx tsx scripts/backfill-bsc-alpha.ts                 # dry run, writes nothing
 *   npx tsx scripts/backfill-bsc-alpha.ts --write
 *   npx tsx scripts/backfill-bsc-alpha.ts --write --since 2026-07-01
 *
 * Mirrors the Robinhood pipeline's *rules* (top 30 per runner, 2+ appearances,
 * $20k combined PnL, bots and contracts excluded) but not its *sources* — see
 * `dune-bsc.ts` for why GMGN's scraper cannot carry a corpus this size.
 *
 * Dry run is the default: this writes to the tables that drive live alerts.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { supabase } from "../src/lib/supabase";
import {
  fetchBscCandidates,
  fetchBscTopTraders,
  fetchBscDeployers,
  BSC_ATH_THRESHOLD_USD,
  BSC_PLAUSIBLE_MAX_ATH_USD,
  BSC_NOT_LAUNCHES,
  BSC_MIN_SELLER_RATIO,
  BSC_MIN_BUYERS,
  fetchBscExitLiquidity,
} from "../src/lib/api/dune-bsc";
import { getBscTotalSupplies, getBscContractFlags } from "../src/lib/api/bsc-onchain";
import {
  buildLabel,
  dedupeLabels,
  upsertAlphaWallets,
  MIN_COMBINED_PNL_USD,
  type AlphaWallet,
} from "../src/lib/api/alpha-wallets";

const CHAIN = "bsc";
const WRITE = process.argv.includes("--write");
const sinceArg = process.argv.indexOf("--since");
const SINCE = sinceArg > -1 ? process.argv[sinceArg + 1] : "2026-07-01";
const SINCE_TS = `${SINCE} 00:00:00`;

/**
 * Trades on a single token above which the wallet is automation rather than a
 * trader. Same bar as Robinhood, where the median top-30 trader makes ~23.
 */
const BOT_MAX_TX_ON_ANY_TOKEN = 1_000;
/** A deployer needs this many $2M runners to be worth watching. */
const MIN_ATH_TOKENS_FOR_DEPLOYER = 2;

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

async function main() {
  console.log(`BSC alpha backfill — since ${SINCE}, ${WRITE ? "WRITING" : "DRY RUN"}\n`);

  // 1. Candidate universe -----------------------------------------------------
  const candidates = await fetchBscCandidates(SINCE_TS);
  if (!candidates) throw new Error("candidate query failed");
  console.log(`1. candidates with real volume: ${candidates.length}`);

  // 2. Real supply → peak market cap ------------------------------------------
  // Robinhood assumes 1e9 supply for every token. BSC supplies vary by orders of
  // magnitude, so an assumed supply would invent the entire metric.
  const supplies = await getBscTotalSupplies(
    candidates.map((c) => ({ address: c.token, decimals: c.decimals }))
  );
  console.log(`2. supply resolved: ${supplies.size}/${candidates.length}`);

  const priced = candidates.map((c) => {
    const supply = supplies.get(c.token.toLowerCase()) ?? null;
    return {
      ...c,
      supply,
      athMcUsd: supply != null ? supply * Number(c.peak_price) : null,
    };
  });

  const infra = priced.filter((p) => BSC_NOT_LAUNCHES.has(String(p.symbol ?? "").toLowerCase()));
  const rest = priced.filter(
    (p) => !BSC_NOT_LAUNCHES.has(String(p.symbol ?? "").toLowerCase()) && p.athMcUsd != null
  );
  const implausible = rest.filter((p) => p.athMcUsd! > BSC_PLAUSIBLE_MAX_ATH_USD);
  const runners = rest
    .filter((p) => p.athMcUsd! >= BSC_ATH_THRESHOLD_USD && p.athMcUsd! <= BSC_PLAUSIBLE_MAX_ATH_USD)
    .sort((a, b) => b.athMcUsd! - a.athMcUsd!);

  console.log(
    `3. runners >= ${usd(BSC_ATH_THRESHOLD_USD)}: ${runners.length}` +
      `   (infra excluded ${infra.length}, implausible held back ${implausible.length})`
  );
  for (const r of runners.slice(0, 5)) {
    console.log(`     ${String(r.symbol ?? "?").padEnd(12)} ${usd(r.athMcUsd!)}  ${r.token}`);
  }
  if (runners.length === 0) return;

  // 3. Honeypots ---------------------------------------------------------------
  // A contract that accepts buys and blocks sells still prints a price, so it
  // reaches this point looking like a runner. Left in, it contributes "top
  // traders" who never traded and its deployer counts toward a promotion.
  const exitRows = await fetchBscExitLiquidity(
    runners.map((r) => r.token),
    SINCE_TS
  );
  if (!exitRows) throw new Error("exit-liquidity query failed");
  const exitOf = new Map(exitRows.map((e) => [String(e.token).toLowerCase(), e]));

  const withExit = runners.map((r) => {
    const e = exitOf.get(r.token.toLowerCase());
    const buyers = Number(e?.buyers ?? 0);
    const sellers = Number(e?.sellers ?? 0);
    return { ...r, buyers, sellers, buyUsd: Number(e?.buy_usd ?? 0), sellUsd: Number(e?.sell_usd ?? 0),
             sellerRatio: buyers > 0 ? sellers / buyers : 0 };
  });
  const honeypots = withExit.filter(
    (r) => r.sellerRatio < BSC_MIN_SELLER_RATIO || r.buyers < BSC_MIN_BUYERS
  );
  const clean = withExit.filter(
    (r) => r.sellerRatio >= BSC_MIN_SELLER_RATIO && r.buyers >= BSC_MIN_BUYERS
  );
  console.log(
    `4. exit-liquidity filter: ${clean.length} kept, ${honeypots.length} rejected ` +
      `(sellers/buyers < ${BSC_MIN_SELLER_RATIO} or < ${BSC_MIN_BUYERS} buyers)`
  );
  for (const h of honeypots.sort((a, b) => b.athMcUsd! - a.athMcUsd!).slice(0, 5)) {
    console.log(
      `     rejected ${String(h.symbol ?? "?").padEnd(12)} ${usd(h.athMcUsd!)}  ` +
        `${h.buyers} buyers / ${h.sellers} sellers`
    );
  }
  runners.length = 0;
  runners.push(...(clean as typeof runners));
  if (runners.length === 0) return;

  const tokens = runners.map((r) => r.token);

  // 4. Traders and deployers --------------------------------------------------
  // Sequential, not parallel: both bodies carry the whole corpus inline, and
  // firing them together was enough to drop a connection.
  const traders = await fetchBscTopTraders(tokens, SINCE_TS);
  const devs = await fetchBscDeployers(tokens);
  if (!traders || !devs) throw new Error("trader/deployer query failed");
  console.log(`5. trader rows: ${traders.length}   deployer rows: ${devs.length}`);

  const symbolOf = new Map(runners.map((r) => [r.token.toLowerCase(), String(r.symbol ?? "?")]));
  const devOf = new Map(
    devs.filter((d) => d.dev).map((d) => [String(d.token).toLowerCase(), String(d.dev).toLowerCase()])
  );

  // 4. Wallets appearing on two or more runners -------------------------------
  interface Appearance {
    token: string;
    symbol: string;
    pnl: number;
    trades: number;
    bought: number;
  }
  const byWallet = new Map<string, Appearance[]>();
  for (const t of traders) {
    const w = String(t.wallet).toLowerCase();
    const token = String(t.token).toLowerCase();
    if (!byWallet.has(w)) byWallet.set(w, []);
    byWallet.get(w)!.push({
      token,
      symbol: symbolOf.get(token) ?? "?",
      pnl: Number(t.pnl_usd) || 0,
      trades: Number(t.trades) || 0,
      bought: Number(t.bought_usd) || 0,
    });
  }

  const repeats = [...byWallet.entries()].filter(([, a]) => a.length >= 2);
  const scored = repeats.map(([wallet, apps]) => ({
    wallet,
    apps,
    winners: [...apps].sort((a, b) => b.pnl - a.pnl),
    combined: apps.reduce((s, a) => s + Math.max(0, a.pnl), 0),
    maxTx: Math.max(...apps.map((a) => a.trades)),
  }));
  const overBar = scored.filter((s) => s.combined >= MIN_COMBINED_PNL_USD);
  const human = overBar.filter((s) => s.maxTx <= BOT_MAX_TX_ON_ANY_TOKEN);

  console.log(
    `6. wallets: ${byWallet.size} seen → ${repeats.length} on 2+ runners → ` +
      `${overBar.length} over ${usd(MIN_COMBINED_PNL_USD)} → ${human.length} after bot filter`
  );

  const flags = await getBscContractFlags(human.map((h) => h.wallet));
  const eoas = human.filter((h) => flags.get(h.wallet) === false);
  console.log(`7. contracts excluded: ${human.length - eoas.length}  →  alpha wallets: ${eoas.length}`);

  const labels = dedupeLabels(
    eoas.map((e) => buildLabel(CHAIN, e.winners.map((w) => w.symbol), e.combined))
  );
  const wallets: AlphaWallet[] = eoas.map((e, i) => ({
    label: labels[i],
    address: e.wallet,
    chain: CHAIN,
    tokenCount: e.apps.length,
    tokens: e.apps.map((a) => a.token),
    totalPnlUsd: e.combined,
    totalInvestedUsd: e.apps.reduce((s, a) => s + a.bought, 0),
    aggregateRoiPct: null,
    bestRank: null,
    maxTxOnAToken: e.maxTx,
    source: `dune-backfill-${SINCE}`,
    isActive: true,
  }));

  // 5. Deployers with two or more runners -------------------------------------
  const byDev = new Map<string, string[]>();
  for (const [token, dev] of devOf) {
    if (!byDev.has(dev)) byDev.set(dev, []);
    byDev.get(dev)!.push(token);
  }
  const devFlags = await getBscContractFlags([...byDev.keys()]);
  const alphaDevs = [...byDev.entries()]
    .filter(([d, t]) => t.length >= MIN_ATH_TOKENS_FOR_DEPLOYER && devFlags.get(d) === false)
    .sort((a, b) => b[1].length - a[1].length);
  console.log(
    `8. deployers: ${byDev.size} distinct → ${alphaDevs.length} with ` +
      `${MIN_ATH_TOKENS_FOR_DEPLOYER}+ runners (contracts excluded)`
  );

  if (!WRITE) {
    // Current market cap for the headline runners, priced the same way the ATH
    // was (price x the supply we read), so the two numbers are comparable.
    const top = runners.slice(0, 10);
    const now = new Map<string, number>();
    for (const r of top) {
      try {
        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${r.token}`,
          { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
        );
        if (res.ok) {
          const j = await res.json();
          const price = parseFloat(j?.data?.attributes?.price_usd ?? "");
          if (Number.isFinite(price) && r.supply) now.set(r.token, price * r.supply);
        }
      } catch {
        /* leave unknown */
      }
      await new Promise((x) => setTimeout(x, 2200)); // GeckoTerminal free tier
    }
    console.log(`\nTOP ${top.length} RUNNERS`);
    console.log(
      `${"SYMBOL".padEnd(14)}${"ATH MC".padStart(14)}${"NOW MC".padStart(14)}` +
        `${"OFF ATH".padStart(9)}  ${"BUY/SELL WALLETS".padEnd(20)}CONTRACT`
    );
    for (const r of top) {
      const cur = now.get(r.token);
      const off = cur != null && r.athMcUsd ? `${(100 - (cur / r.athMcUsd) * 100).toFixed(0)}%` : "—";
      const e = r as unknown as { buyers: number; sellers: number };
      console.log(
        `${String(r.symbol ?? "?").slice(0, 13).padEnd(14)}` +
          `${usd(r.athMcUsd!).padStart(14)}` +
          `${(cur != null ? usd(cur) : "—").padStart(14)}` +
          `${off.padStart(9)}  ` +
          `${`${e.buyers} / ${e.sellers}`.padEnd(20)}${r.token}`
      );
    }
    console.log("\nDRY RUN — nothing written. Re-run with --write.");
    console.log(`  would write ${runners.length} tokens, ${traders.length} trader rows,`);
    console.log(`  ${wallets.length} alpha wallets, ${alphaDevs.length} alpha deployers`);
    for (const w of wallets.slice(0, 8)) {
      console.log(`   ${w.label.padEnd(40)} tokens=${w.tokenCount} pnl=${usd(w.totalPnlUsd ?? 0)}`);
    }
    return;
  }

  // 6. Write ------------------------------------------------------------------
  console.log("\nwriting…");

  const tokenRows = runners.map((r) => ({
    chain: CHAIN,
    token_address: r.token,
    symbol: r.symbol,
    name: r.name,
    deployer_address: devOf.get(r.token.toLowerCase()) ?? null,
    ath_mc_usd: r.athMcUsd,
    ath_at: r.peak_h,
    total_supply: r.supply,
    launched_at: r.first_h,
    distinct_buyers: (r as { buyers?: number }).buyers ?? null,
    distinct_sellers: (r as { sellers?: number }).sellers ?? null,
    buy_volume_usd: (r as { buyUsd?: number }).buyUsd ?? null,
    sell_volume_usd: (r as { sellUsd?: number }).sellUsd ?? null,
    source: `dune-backfill-${SINCE}`,
    traders_captured_at: new Date().toISOString(),
  }));
  for (let i = 0; i < tokenRows.length; i += 500) {
    const { error } = await supabase
      .from("ath_tokens")
      .upsert(tokenRows.slice(i, i + 500), { onConflict: "chain,token_address" });
    if (error) throw new Error(`ath_tokens: ${error.message}`);
  }
  console.log(`  ath_tokens: ${tokenRows.length}`);

  const { data: idRows } = await supabase
    .from("ath_tokens")
    .select("id, token_address")
    .eq("chain", CHAIN);
  const idOf = new Map((idRows ?? []).map((r) => [String(r.token_address).toLowerCase(), r.id]));

  const traderRows = traders
    .filter((t) => idOf.has(String(t.token).toLowerCase()))
    .map((t) => {
      const token = String(t.token).toLowerCase();
      const trades = Number(t.trades) || 0;
      return {
        token_id: idOf.get(token),
        chain: CHAIN,
        token_address: token,
        token_symbol: symbolOf.get(token) ?? null,
        wallet_address: String(t.wallet).toLowerCase(),
        rank: Number(t.rn) || null,
        amount_invested_usd: Number(t.bought_usd) || 0,
        amount_sold_usd: Number(t.sold_usd) || 0,
        realized_pnl_usd: Number(t.pnl_usd) || 0,
        total_pnl_usd: Number(t.pnl_usd) || 0,
        tx_count: trades,
        // Kept rather than dropped, so the threshold can be revisited without
        // re-running the whole corpus.
        is_bot: trades > BOT_MAX_TX_ON_ANY_TOKEN,
        bot_reason: trades > BOT_MAX_TX_ON_ANY_TOKEN ? `${trades} trades on one token` : null,
      };
    });
  for (let i = 0; i < traderRows.length; i += 500) {
    const { error } = await supabase
      .from("ath_token_traders")
      .upsert(traderRows.slice(i, i + 500), { onConflict: "token_address,wallet_address" });
    if (error) throw new Error(`ath_token_traders: ${error.message}`);
  }
  console.log(`  ath_token_traders: ${traderRows.length}`);

  const n = await upsertAlphaWallets(wallets);
  console.log(`  alpha_wallets upserted: ${n}`);

  // Wallets promoted by an earlier, dirtier run may no longer qualify once
  // honeypots are removed from the corpus. Deactivate rather than delete: the
  // confluence watcher only loads is_active rows, and the evidence stays.
  const keep = new Set(wallets.map((w) => w.address.toLowerCase()));
  const { data: existing } = await supabase
    .from("alpha_wallets")
    .select("id,address,is_active")
    .eq("chain", CHAIN);
  const stale = (existing ?? []).filter(
    (r) => r.is_active && !keep.has(String(r.address).toLowerCase())
  );
  if (stale.length) {
    const { error } = await supabase
      .from("alpha_wallets")
      .update({ is_active: false, notes: `deactivated ${new Date().toISOString().slice(0, 10)}: no longer qualifies` })
      .in("id", stale.map((r) => r.id));
    if (error) throw new Error(`deactivate alpha_wallets: ${error.message}`);
  }
  console.log(`  alpha_wallets deactivated (no longer qualify): ${stale.length}`);

  const devRows = alphaDevs.map(([address, toks]) => ({
    chain: CHAIN,
    address,
    ath_token_count: toks.length,
    ath_token_symbols: toks.map((t) => symbolOf.get(t) ?? "?").slice(0, 10),
    label: `BSC_${(symbolOf.get(toks[0]) ?? "na").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}_${(
      symbolOf.get(toks[1]) ?? "na"
    )
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 12)}_Dep`,
    is_alpha: true,
    promoted_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  }));
  const seenDevLabels = new Map<string, number>();
  for (const d of devRows) {
    const k = (seenDevLabels.get(d.label) ?? 0) + 1;
    seenDevLabels.set(d.label, k);
    if (k > 1) d.label = `${d.label}_${d.address.slice(2, 6)}`;
  }
  if (devRows.length) {
    const { error } = await supabase
      .from("token_deployers")
      .upsert(devRows, { onConflict: "chain,address" });
    if (error) throw new Error(`token_deployers: ${error.message}`);
  }
  console.log(`  token_deployers (alpha): ${devRows.length}`);

  console.log("\ndone");
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
