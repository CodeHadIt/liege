import { supabase } from "@/lib/supabase";
import { loadAlphaWallets } from "@/lib/api/alpha-wallets";
import {
  getRhLatestBlock,
  getTransfersToWallets,
  getTxInfo,
  getBlockTimeMs,
  getRhTokenDecimals,
  getEthUsdPrice,
  getNftCollection,
  getNftSaleStats,
  type AssetStandard,
} from "@/lib/api/rh-onchain";
import { rateLimit } from "@/lib/rate-limiter";
import { getOpenSeaCollectionStats } from "@/lib/api/opensea";
import {
  sendConfluenceAlert,
  sendConfluenceFollowUp,
  CONFLUENCE_WINDOW_MS,
  MIN_WALLETS_TO_ALERT,
  MAX_WALLETS_TO_ALERT,
  MIN_BUY_USD,
  WINDOW_REOPEN_COOLDOWN_MS,
  type AlphaBuyer,
  type ConfluenceToken,
} from "./alpha-alerts";

// ── Alpha wallet confluence watcher ───────────────────────────────────────────
// Watches every alpha wallet for buys on Robinhood Chain and alerts when two or
// more of them buy the SAME token inside the confluence window.
//
// Detection is one eth_getLogs per poll: ERC-20 Transfer with the indexed `to`
// OR-filtered across all alpha wallets. That covers the whole cohort in a single
// call regardless of how many wallets are on the list.
//
// A transfer in is not a buy, so each candidate is confirmed by checking the
// alpha wallet SENT the transaction that delivered the tokens. An airdrop, or a
// transfer from another of the owner's addresses, would otherwise count toward
// confluence — and a false confluence ping is worse than a missed one.

const CHAIN = "rh";
// After downtime, skip the gap rather than replaying it: a buy from hours ago is
// no longer actionable, and the window would have expired anyway.
const MAX_BLOCK_SPAN = 20_000;

let lastScannedBlock: number | null = null;

interface DexPair {
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
}

interface TokenMarket {
  symbol: string;
  name: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  totalSupply?: number | null;
  holders?: number | null;
  floorUsd?: number | null;
  floorEth?: number | null;
  floorSales?: number | null;
  floorSource?: "opensea" | "onchain" | null;
  openSeaUrl?: string | null;
}

/** Market snapshot for a token from its deepest Robinhood-chain pool. */
async function fetchTokenMarket(tokenAddress: string): Promise<TokenMarket> {
  const blank: TokenMarket = { symbol: "?", name: "", priceUsd: null, marketCapUsd: null, liquidityUsd: null };
  await rateLimit("dexscreener");
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${tokenAddress}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return blank;
    const data = await res.json();
    const pairs: DexPair[] = Array.isArray(data) ? data : (data?.pairs ?? []);
    const self = tokenAddress.toLowerCase();
    const asBase = pairs.filter((p) => (p.baseToken?.address ?? "").toLowerCase() === self);
    const pool = (asBase.length ? asBase : pairs).sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0];
    if (!pool) return blank;
    return {
      symbol: pool.baseToken?.symbol ?? "?",
      name: pool.baseToken?.name ?? "",
      priceUsd: pool.priceUsd ? parseFloat(pool.priceUsd) : null,
      marketCapUsd: pool.marketCap ?? pool.fdv ?? null,
      liquidityUsd: pool.liquidity?.usd ?? null,
    };
  } catch {
    return blank;
  }
}

interface DetectedBuy {
  walletId: string;
  walletAddress: string;
  label: string;
  tokenAddress: string;
  txHash: string;
  blockNumber: number;
  boughtAtMs: number;
  standard: AssetStandard;
  /** ERC-20: token amount. ERC-721: NFT count. */
  tokensReceived: number;
  /** ERC-721: native spend on the mint/purchase */
  valueWei: bigint;
  isMint: boolean;
}

/**
 * One poll: find alpha-wallet buys since the last scan, record them, and drive
 * the confluence state machine.
 */
export async function pollAlphaConfluence(): Promise<void> {
  const wallets = await loadAlphaWallets(CHAIN);
  if (wallets.size === 0) return;

  const latest = await getRhLatestBlock();
  if (latest == null) return;

  // Baseline on first run so a restart never replays history.
  if (lastScannedBlock == null) {
    lastScannedBlock = latest;
    await closeExpiredWindows();
    return;
  }
  if (latest <= lastScannedBlock) {
    await closeExpiredWindows();
    return;
  }

  const from = Math.max(lastScannedBlock + 1, latest - MAX_BLOCK_SPAN);
  const transfers = await getTransfersToWallets([...wallets.keys()], from, latest);
  // null = RPC failure, not a quiet range — hold the cursor and retry.
  if (transfers == null) return;
  lastScannedBlock = latest;

  await closeExpiredWindows();
  if (transfers.length === 0) return;

  // Collapse to one candidate per (tx, wallet, token): a single swap routinely
  // emits several Transfers of the same token to the same wallet, and that is
  // one purchase.
  const ZERO = "0x0000000000000000000000000000000000000000";
  const candidates = new Map<
    string,
    { tx: string; wallet: string; token: string; block: number; raw: bigint; standard: AssetStandard; count: number; mint: boolean }
  >();
  for (const t of transfers) {
    const key = `${t.txHash}:${t.to}:${t.tokenAddress}`;
    const ex = candidates.get(key);
    if (ex) {
      ex.raw += t.rawValue;
      ex.count += 1; // NFT mints arrive batched — 50 in one tx is routine
      ex.mint = ex.mint || t.from === ZERO;
    } else {
      candidates.set(key, {
        tx: t.txHash,
        wallet: t.to,
        token: t.tokenAddress,
        block: t.blockNumber,
        raw: t.rawValue,
        standard: t.standard,
        count: 1,
        mint: t.from === ZERO,
      });
    }
  }

  const buys: DetectedBuy[] = [];
  const senderCache = new Map<string, { from: string; valueWei: bigint } | null>();
  for (const c of candidates.values()) {
    const w = wallets.get(c.wallet);
    if (!w?.id) continue;

    if (!senderCache.has(c.tx)) senderCache.set(c.tx, await getTxInfo(c.tx));
    const info = senderCache.get(c.tx);
    if (!info || info.from !== c.wallet) continue; // received, but didn't act

    // ERC-721 has no decimals — the count of ids received IS the amount.
    const tokensReceived =
      c.standard === "erc721" ? c.count : Number(c.raw) / 10 ** (await getRhTokenDecimals(c.token));
    const ts = (await getBlockTimeMs(c.block)) ?? Date.now();

    buys.push({
      walletId: w.id,
      walletAddress: c.wallet,
      label: w.label,
      tokenAddress: c.token,
      txHash: c.tx,
      blockNumber: c.block,
      boughtAtMs: ts,
      standard: c.standard,
      tokensReceived,
      valueWei: info.valueWei,
      isMint: c.mint,
    });
  }
  if (buys.length === 0) return;

  // Oldest first, so a window opens on the genuinely first buy.
  buys.sort((a, b) => a.boughtAtMs - b.boughtAtMs);

  const marketCache = new Map<string, TokenMarket>();
  for (const b of buys) {
    const nft = b.standard === "erc721";

    // An NFT has no pool to price against: what the wallet spent is the native
    // value on the transaction, and supply/holders stand in for market cap.
    let m: TokenMarket;
    let amountUsd: number | null;
    let supplyPct: number | null;
    if (nft) {
      const col = await getNftCollection(b.tokenAddress);
      const eth = await getEthUsdPrice();
      // Prefer OpenSea's real floor (lowest ask). Only pay for the on-chain
      // scan when the collection isn't listed there — it costs ~25 RPC calls.
      const os = await getOpenSeaCollectionStats(CHAIN, b.tokenAddress);
      const sales = os?.floorNative == null ? await getNftSaleStats(b.tokenAddress, b.blockNumber) : null;
      const floorEth = os?.floorNative ?? sales?.lowEth ?? null;
      m = {
        symbol: col?.symbol ?? "?",
        name: col?.name ?? os?.name ?? "",
        priceUsd: null,
        marketCapUsd: null,
        liquidityUsd: null,
        totalSupply: col?.totalSupply ?? null,
        holders: col?.holders ?? os?.owners ?? null,
        floorEth,
        floorUsd: floorEth != null && eth != null ? floorEth * eth : null,
        floorSales: sales?.sales ?? null,
        floorSource: os?.floorNative != null ? "opensea" : sales ? "onchain" : null,
        openSeaUrl: os?.url ?? null,
      };
      const ethSpent = Number(b.valueWei) / 1e18;
      amountUsd = eth != null ? ethSpent * eth : null;
      supplyPct = col?.totalSupply ? (b.tokensReceived / col.totalSupply) * 100 : null;
    } else {
      if (!marketCache.has(b.tokenAddress)) marketCache.set(b.tokenAddress, await fetchTokenMarket(b.tokenAddress));
      m = marketCache.get(b.tokenAddress)!;
      amountUsd = m.priceUsd != null ? b.tokensReceived * m.priceUsd : null;
      supplyPct =
        m.marketCapUsd && m.priceUsd && m.priceUsd > 0
          ? (b.tokensReceived / (m.marketCapUsd / m.priceUsd)) * 100
          : null;
    }

    const { error } = await supabase.from("alpha_buys").upsert(
      {
        wallet_id: b.walletId,
        chain: CHAIN,
        token_address: b.tokenAddress,
        token_symbol: m.symbol,
        token_name: m.name,
        tx_hash: b.txHash,
        block_number: b.blockNumber,
        bought_at: new Date(b.boughtAtMs).toISOString(),
        amount_usd: amountUsd,
        market_cap_usd: m.marketCapUsd,
        supply_pct: supplyPct,
        liquidity_usd: m.liquidityUsd,
        asset_type: b.standard,
        quantity: nft ? b.tokensReceived : null,
        is_mint: b.isMint,
      },
      { onConflict: "tx_hash,wallet_id,token_address", ignoreDuplicates: true }
    );
    if (error) {
      console.error("[alpha] failed to record buy:", error.message);
      continue;
    }

    // The USD floor exists to filter dust from a fungible market, and does not
    // translate to NFTs: free mints are the norm there, and several alpha
    // wallets minting the same collection is exactly the signal wanted. NFT
    // noise is bounded by confluence, the 24h re-open cooldown and the 4-ping
    // cap instead.
    if (!nft) {
      if (amountUsd == null) {
        console.log(`[alpha] ${b.label} received ${b.tokenAddress.slice(0, 10)}… with no price — not counted`);
        continue;
      }
      if (amountUsd < MIN_BUY_USD) {
        console.log(`[alpha] ${b.label} bought ${m.symbol} for $${amountUsd.toFixed(0)} — below $${MIN_BUY_USD} floor, not counted`);
        continue;
      }
    }

    await advanceConfluence(b, m, nft);
  }
}

/** Close any window whose 4h has elapsed — we stop watching the token entirely. */
async function closeExpiredWindows(): Promise<void> {
  const { error } = await supabase
    .from("alpha_confluence")
    .update({ is_closed: true })
    .eq("chain", CHAIN)
    .eq("is_closed", false)
    .lt("window_expires_at", new Date().toISOString());
  if (error) console.error("[alpha] failed to expire windows:", error.message);
}

/**
 * Open or extend the confluence window for a token and fire the alert when a new
 * alpha wallet joins. Alerts run from the 2nd distinct wallet to the 5th, after
 * which the window closes.
 */
async function advanceConfluence(buy: DetectedBuy, market: TokenMarket, nft: boolean): Promise<void> {
  const now = new Date(buy.boughtAtMs);

  const { data: openRows } = await supabase
    .from("alpha_confluence")
    .select("*")
    .eq("chain", CHAIN)
    .eq("token_address", buy.tokenAddress)
    .eq("is_closed", false)
    .gt("window_expires_at", now.toISOString())
    .order("first_buy_at", { ascending: false })
    .limit(1);

  let row = openRows?.[0];

  if (!row) {
    // Don't re-open straight after a window closed — see WINDOW_REOPEN_COOLDOWN_MS.
    const { data: recent } = await supabase
      .from("alpha_confluence")
      .select("window_expires_at")
      .eq("chain", CHAIN)
      .eq("token_address", buy.tokenAddress)
      .gte("window_expires_at", new Date(buy.boughtAtMs - WINDOW_REOPEN_COOLDOWN_MS).toISOString())
      .limit(1);
    if (recent && recent.length > 0) return;
  }

  if (!row) {
    // First alpha buy for this token — start watching, but stay silent. One
    // wallet is not confluence.
    const { data, error } = await supabase
      .from("alpha_confluence")
      .insert({
        chain: CHAIN,
        token_address: buy.tokenAddress,
        token_symbol: market.symbol,
        token_name: market.name,
        asset_type: buy.standard,
        first_buy_at: now.toISOString(),
        window_expires_at: new Date(buy.boughtAtMs + CONFLUENCE_WINDOW_MS).toISOString(),
        wallet_count: 1,
        alerts_sent: 0,
      })
      .select()
      .single();
    if (error) {
      console.error("[alpha] failed to open window:", error.message);
      return;
    }
    console.log(`[alpha] watching ${market.symbol} — first buy by ${buy.label}`);
    row = data;
    return;
  }

  // Distinct wallets that have bought inside this window, in buy order.
  const { data: windowBuys } = await supabase
    .from("alpha_buys")
    .select("wallet_id, amount_usd, market_cap_usd, supply_pct, bought_at, quantity, is_mint")
    .eq("chain", CHAIN)
    .eq("token_address", buy.tokenAddress)
    .gte("bought_at", row.first_buy_at)
    .order("bought_at", { ascending: true });

  interface WindowBuy {
    wallet_id: string;
    amount_usd: number | null;
    market_cap_usd: number | null;
    supply_pct: number | null;
    bought_at: string;
    quantity: number | null;
    is_mint: boolean | null;
  }
  const order: string[] = [];
  const perWallet = new Map<string, WindowBuy>();
  for (const r of (windowBuys ?? []) as WindowBuy[]) {
    if (!perWallet.has(r.wallet_id)) {
      perWallet.set(r.wallet_id, r);
      order.push(r.wallet_id);
    }
  }
  const distinct = order.length;
  if (distinct <= row.wallet_count) return; // this wallet already counted
  if (distinct > MAX_WALLETS_TO_ALERT) return; // cap reached

  const wallets = await loadAlphaWallets(CHAIN);
  const byId = new Map([...wallets.values()].map((w) => [w.id, w]));
  const buyerOf = (walletId: string): AlphaBuyer | null => {
    const w = byId.get(walletId);
    const r = perWallet.get(walletId);
    if (!w || !r) return null;
    return {
      label: w.label,
      address: w.address,
      amountUsd: r.amount_usd,
      marketCapUsd: r.market_cap_usd,
      supplyPct: r.supply_pct,
      quantity: r.quantity,
      isMint: r.is_mint ?? false,
    };
  };

  const token: ConfluenceToken = {
    chain: CHAIN,
    address: buy.tokenAddress,
    symbol: market.symbol,
    name: market.name,
    liquidityUsd: market.liquidityUsd,
    currentMcUsd: market.marketCapUsd,
    firstAlertMcUsd: row.first_alert_mc_usd ?? null,
    assetType: nft ? "erc721" : "erc20",
    totalSupply: market.totalSupply ?? null,
    holders: market.holders ?? null,
    floorUsd: market.floorUsd ?? null,
    floorEth: market.floorEth ?? null,
    floorSales: market.floorSales ?? null,
    floorSource: market.floorSource ?? null,
    openSeaUrl: market.openSeaUrl ?? null,
  };

  const patch: Record<string, unknown> = { wallet_count: distinct };

  if (distinct === MIN_WALLETS_TO_ALERT) {
    const buyers = order.map(buyerOf).filter((b): b is AlphaBuyer => b !== null);
    await sendConfluenceAlert(token, buyers);
    patch.alerts_sent = (row.alerts_sent ?? 0) + 1;
    patch.first_alert_mc_usd = market.marketCapUsd; // baseline for "up N x"
    patch.last_alert_at = new Date().toISOString();
    console.log(`[alpha] CONFLUENCE ${market.symbol}: ${buyers.map((b) => b.label).join(" + ")}`);
  } else if (distinct > MIN_WALLETS_TO_ALERT) {
    const joiner = buyerOf(order[order.length - 1]);
    const previous = order.slice(0, -1).map(buyerOf).filter((b): b is AlphaBuyer => b !== null);
    if (joiner) {
      await sendConfluenceFollowUp(token, joiner, previous);
      patch.alerts_sent = (row.alerts_sent ?? 0) + 1;
      patch.last_alert_at = new Date().toISOString();
      console.log(`[alpha] alpha #${distinct} joined ${market.symbol}: ${joiner.label}`);
    }
  }

  // Cap reached — stop watching this token.
  if (distinct >= MAX_WALLETS_TO_ALERT) patch.is_closed = true;

  const { error } = await supabase.from("alpha_confluence").update(patch).eq("id", row.id);
  if (error) console.error("[alpha] failed to update window:", error.message);
}
