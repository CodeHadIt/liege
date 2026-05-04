import type { MyContext } from "../bot";
import {
  getWalletBalances,
  getTransactionHistory,
  getWalletFirstTransaction,
  getParsedSwapsAll,
  getMintInfo,
  getAssetBatch,
  type HeliusTransaction,
  type ParsedTransaction,
} from "@/lib/api/helius";
import { scrapeGmgnWalletHoldings } from "@/lib/api/gmgn-scraper";
import { searchPairs } from "@/lib/api/dexscreener";
import {
  escapeHtml,
  formatCompact,
  chainEmoji,
  chainLabel,
  formatTimeAgo,
} from "../utils/format";
import type { ChainId } from "@/types/chain";

// ── Constants ─────────────────────────────────────────────────────────────────

const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",  // WETH (Wormhole)
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",  // BTC (Wormhole)
]);

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "BUSD", "FRAX", "TUSD", "USDH", "UXD", "PYUSD"]);

const EVM_STABLE_SYMBOLS = new Set(["USDC", "USDT", "BUSD", "DAI", "FRAX", "PYUSD"]);

// Moralis hex chain IDs (same as webapp)
const MORALIS_CHAIN: Record<string, string> = {
  base: "0x2105",
  bsc:  "0x38",
  eth:  "0x1",
};

const EVM_NATIVE_SYMBOL: Record<string, string> = {
  base: "ETH",
  bsc:  "BNB",
  eth:  "ETH",
};

const EVM_EXPLORER: Record<string, string> = {
  base: "https://basescan.org",
  bsc:  "https://bscscan.com",
  eth:  "https://etherscan.io",
};

// Moralis profitability endpoint only works on ETH + Base
const PROFITABILITY_CHAINS = new Set(["0x1", "0x2105"]);

// ── Address type detection ────────────────────────────────────────────────────

const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE    = /^0x[a-fA-F0-9]{40}$/;

export function getAddressType(address: string): "solana" | "evm" | null {
  if (SOLANA_RE.test(address)) return "solana";
  if (EVM_RE.test(address))    return "evm";
  return null;
}

/**
 * Returns true if the Solana address looks like a token mint rather than a wallet.
 * Uses getMintInfo — mints have supply/decimals; wallets don't.
 */
export async function isSolanaTokenMint(address: string): Promise<boolean> {
  const info = await getMintInfo(address).catch(() => null);
  return info !== null && typeof info.decimals === "number";
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  return `$${formatCompact(n)}`;
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${fmtUsd(n)}`;
}

function fmtDate(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return d.toUTCString().replace(" GMT", " UTC");
}

// ── Solana transaction helpers ────────────────────────────────────────────────

/**
 * Estimate USD value of a Solana transaction to filter out dust.
 */
function solanaTxValueUsd(
  tx: HeliusTransaction,
  walletAddress: string,
  mintToPrice: Map<string, number>,
  solPrice: number
): number {
  const SOL_LAMPORTS = 1_000_000_000;
  let maxVal = 0;

  const solSent = (tx.nativeTransfers ?? [])
    .filter((t) => t.fromUserAccount === walletAddress)
    .reduce((s, t) => s + t.amount, 0);
  const solReceived = (tx.nativeTransfers ?? [])
    .filter((t) => t.toUserAccount === walletAddress)
    .reduce((s, t) => s + t.amount, 0);

  maxVal = Math.max(maxVal, (Math.max(solSent, solReceived) / SOL_LAMPORTS) * solPrice);

  for (const t of tx.tokenTransfers ?? []) {
    const price = mintToPrice.get(t.mint);
    if (price && t.tokenAmount > 0) {
      maxVal = Math.max(maxVal, t.tokenAmount * price);
    }
  }

  return maxVal;
}

/**
 * Build a human-readable HTML description for a Solana transaction.
 */
function describeSolanaTx(
  tx: HeliusTransaction,
  walletAddress: string,
  mintToSymbol: Map<string, string>
): string {
  const SOL_LAMPORTS = 1_000_000_000;

  const tokensIn  = (tx.tokenTransfers ?? []).filter((t) => t.toUserAccount   === walletAddress);
  const tokensOut = (tx.tokenTransfers ?? []).filter((t) => t.fromUserAccount === walletAddress);

  const solSent = (tx.nativeTransfers ?? [])
    .filter((t) => t.fromUserAccount === walletAddress)
    .reduce((s, t) => s + t.amount, 0);
  const solReceived = (tx.nativeTransfers ?? [])
    .filter((t) => t.toUserAccount === walletAddress)
    .reduce((s, t) => s + t.amount, 0);

  if (solSent > 0 && tokensIn.length > 0) {
    const token = tokensIn[0];
    const sym   = mintToSymbol.get(token.mint) ?? token.mint.slice(0, 6) + "…";
    const sol   = (solSent / SOL_LAMPORTS).toFixed(3);
    return `🟢 Bought <b>${escapeHtml(sol)} SOL</b> of <b>${escapeHtml(sym)}</b> (<code>${escapeHtml(token.mint)}</code>)`;
  }

  if (solReceived > 0 && tokensOut.length > 0) {
    const token = tokensOut[0];
    const sym   = mintToSymbol.get(token.mint) ?? token.mint.slice(0, 6) + "…";
    const sol   = (solReceived / SOL_LAMPORTS).toFixed(3);
    return `🔴 Sold <b>${escapeHtml(sym)}</b> (<code>${escapeHtml(token.mint)}</code>) for <b>${escapeHtml(sol)} SOL</b>`;
  }

  if (tokensIn.length > 0 && tokensOut.length === 0) {
    const token = tokensIn[0];
    const sym   = mintToSymbol.get(token.mint) ?? token.mint.slice(0, 6) + "…";
    return `📥 Received <b>${escapeHtml(sym)}</b> (<code>${escapeHtml(token.mint)}</code>)`;
  }

  if (tokensOut.length > 0 && tokensIn.length === 0) {
    const token = tokensOut[0];
    const sym   = mintToSymbol.get(token.mint) ?? token.mint.slice(0, 6) + "…";
    return `📤 Sent <b>${escapeHtml(sym)}</b> (<code>${escapeHtml(token.mint)}</code>)`;
  }

  if (solReceived > 0 && tokensIn.length === 0 && tokensOut.length === 0) {
    return `📥 Received <b>${escapeHtml((solReceived / SOL_LAMPORTS).toFixed(3))} SOL</b>`;
  }

  if (solSent > 0 && tokensIn.length === 0 && tokensOut.length === 0) {
    return `📤 Sent <b>${escapeHtml((solSent / SOL_LAMPORTS).toFixed(3))} SOL</b>`;
  }

  if (tx.description) return escapeHtml(tx.description.slice(0, 100));
  const label = tx.type
    ? tx.type.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    : "Transaction";
  return escapeHtml(label);
}

// ── Moralis helpers ───────────────────────────────────────────────────────────

async function fetchMoralis<T>(path: string): Promise<T | null> {
  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://deep-index.moralis.io/api/v2.2${path}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

interface MoralisTokenBalance {
  token_address: string;
  symbol: string;
  name: string;
  logo: string | null;
  thumbnail: string | null;
  balance_formatted: string;
  usd_price: number | null;
  usd_value: number | null;
  possible_spam: boolean;
  native_token: boolean;
}

interface MoralisTokensResponse {
  result: MoralisTokenBalance[];
  native_balance?: { balance_formatted: string; usd: string | null };
}

interface MoralisSwapSide {
  address: string;
  symbol: string;
  logo: string | null;
  usdAmount: number;
  amount: string;
}

interface MoralisSwap {
  transactionType: "buy" | "sell";
  blockTimestamp: string;
  transactionHash: string;
  bought: MoralisSwapSide;
  sold: MoralisSwapSide;
  totalValueUsd: number;
}

interface MoralisProfEntry {
  token_address: string;
  token_symbol: string;
  realized_profit_usd: string | null;
  total_usd_invested: string | null;
  total_sold_usd: string | null;
  last_trade: string | null;
}

interface MoralisNetWorthResponse {
  total_networth_usd: string;
  chains: {
    native_balance_formatted: string;
    native_balance_usd: string;
    token_balance_usd: string;
    networth_usd: string;
  }[];
}

// ── Solana cost-basis PnL ─────────────────────────────────────────────────────

const SOL_MINTS_SET = new Set([
  "So11111111111111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
]);

/**
 * Compute realized PnL per token from SWAP transactions using FIFO cost basis.
 * Returns a list sorted by most recent sell, capped at `limit` entries.
 */
function computeSwapPnl(
  swapTxns: ParsedTransaction[],
  walletAddress: string,
  solPriceUsd: number,
  mintToSymbol: Map<string, string>
): Array<{ symbol: string; mint: string; realizedPnlUsd: number; timestamp: number }> {
  // Process in chronological order (oldest first) so buys come before sells
  const txns = [...swapTxns].reverse();

  // cost ledger: mint → { totalBoughtAmount, totalCostUsd }
  const costLedger = new Map<string, { totalBoughtAmount: number; totalCostUsd: number }>();
  // realized PnL per mint: latest sell timestamp + cumulative PnL
  const pnlMap = new Map<string, { pnlUsd: number; timestamp: number }>();

  for (const tx of txns) {
    if (!tx.timestamp) continue;

    // Net token flows for this wallet
    const netChanges = new Map<string, number>();
    for (const tt of tx.tokenTransfers) {
      let delta = 0;
      if (tt.toUserAccount === walletAddress)   delta += tt.tokenAmount;
      if (tt.fromUserAccount === walletAddress) delta -= tt.tokenAmount;
      if (delta !== 0) netChanges.set(tt.mint, (netChanges.get(tt.mint) ?? 0) + delta);
    }

    // Identify cost (SOL or stables spent) and proceeds (SOL or stables received)
    let costUsd = 0;
    let receivedUsd = 0;
    let boughtMint: string | null = null;
    let boughtAmount = 0;
    let soldMint: string | null = null;
    let soldAmount = 0;

    for (const [mint, amount] of netChanges) {
      if (SOL_MINTS_SET.has(mint)) {
        if (amount < 0) costUsd     += Math.abs(amount) * solPriceUsd;
        if (amount > 0) receivedUsd += amount * solPriceUsd;
        continue;
      }
      if (STABLE_MINTS.has(mint)) {
        if (amount < 0) costUsd     += Math.abs(amount);
        if (amount > 0) receivedUsd += Math.abs(amount);
        continue;
      }
      if (amount > 0) { boughtMint = mint; boughtAmount = amount; }
      else            { soldMint   = mint; soldAmount   = Math.abs(amount); }
    }

    // Record buy → update cost basis
    if (boughtMint && boughtAmount > 0 && costUsd > 0) {
      const prev = costLedger.get(boughtMint) ?? { totalBoughtAmount: 0, totalCostUsd: 0 };
      costLedger.set(boughtMint, {
        totalBoughtAmount: prev.totalBoughtAmount + boughtAmount,
        totalCostUsd:      prev.totalCostUsd + costUsd,
      });
    }

    // Record sell → compute realized PnL
    if (soldMint && soldAmount > 0 && receivedUsd > 0) {
      const ledger = costLedger.get(soldMint);
      let costBasis = 0;
      if (ledger && ledger.totalBoughtAmount > 0) {
        const avgCost = ledger.totalCostUsd / ledger.totalBoughtAmount;
        costBasis = avgCost * soldAmount;
        // Reduce ledger proportionally
        const remaining = ledger.totalBoughtAmount - soldAmount;
        if (remaining > 0) {
          costLedger.set(soldMint, {
            totalBoughtAmount: remaining,
            totalCostUsd: ledger.totalCostUsd - costBasis,
          });
        } else {
          costLedger.delete(soldMint);
        }
      }
      const realized = receivedUsd - costBasis;
      const prev = pnlMap.get(soldMint) ?? { pnlUsd: 0, timestamp: 0 };
      pnlMap.set(soldMint, {
        pnlUsd: prev.pnlUsd + realized,
        timestamp: Math.max(prev.timestamp, tx.timestamp),
      });
    }
  }

  const results: Array<{ symbol: string; mint: string; realizedPnlUsd: number; timestamp: number }> = [];
  for (const [mint, { pnlUsd, timestamp }] of pnlMap) {
    if (Math.abs(pnlUsd) < 0.01) continue;
    results.push({ mint, symbol: mintToSymbol.get(mint) ?? mint.slice(0, 6) + "…", realizedPnlUsd: pnlUsd, timestamp });
  }
  results.sort((a, b) => b.timestamp - a.timestamp);
  return results;
}

// ── Solana handler ────────────────────────────────────────────────────────────

async function handleSolanaWallet(
  ctx: MyContext,
  address: string,
  loadingMsgId: number
): Promise<void> {
  const [balancesRes, allTxns, firstTx, swapTxns] = await Promise.all([
    getWalletBalances(address).catch(() => null),
    getTransactionHistory(address, 20).catch(() => []),  // fetch 20, filter to 5 ≥ $1
    getWalletFirstTransaction(address, 3).catch(() => null),
    getParsedSwapsAll(address, { maxPages: 3, limit: 100 }).catch(() => [] as ParsedTransaction[]),
  ]);

  if (!balancesRes) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loadingMsgId,
      "❌ Could not fetch wallet data. Make sure this is a valid Solana wallet address."
    );
    return;
  }

  const { balances, totalUsdValue } = balancesRes;
  const SOL_MINT = "So11111111111111111111111111111111111111112";

  const solBalance = balances.find((b) => b.mint === SOL_MINT || b.symbol === "SOL");
  const solPrice   = solBalance?.pricePerToken ?? 0;

  // Lookup maps
  const mintToSymbol = new Map<string, string>(
    balances.filter((b) => b.symbol).map((b) => [b.mint, b.symbol])
  );
  const mintToPrice = new Map<string, number>(
    balances.filter((b) => b.pricePerToken).map((b) => [b.mint, b.pricePerToken!])
  );

  // Resolve symbols for mints that appear in transactions but aren't in current portfolio
  // (e.g. old/sold tokens) via Helius DAS batch lookup
  const allMints = [...new Set([
    ...allTxns.flatMap((tx) => (tx.tokenTransfers ?? []).map((t) => t.mint)),
    ...swapTxns.flatMap((tx) => (tx.tokenTransfers ?? []).map((t) => t.mint)),
  ].filter((m) => !mintToSymbol.has(m) && m !== SOL_MINT && !STABLE_MINTS.has(m) && !SOL_MINTS_SET.has(m)))];
  if (allMints.length > 0) {
    const resolved = await getAssetBatch(allMints).catch(() => new Map());
    for (const [mint, info] of resolved) {
      if (info.symbol && info.symbol !== "???") mintToSymbol.set(mint, info.symbol);
    }
  }

  // Filter txns ≥ $1
  const meaningfulTxns = allTxns
    .filter((tx) => solanaTxValueUsd(tx, address, mintToPrice, solPrice) >= 1)
    .slice(0, 5);

  const lastTxTime = allTxns[0]?.timestamp ?? null;

  // Portfolio
  const tokenBalances    = balances.filter((b) => b.mint !== SOL_MINT);
  const tokensAbove1     = tokenBalances.filter((b) => (b.usdValue ?? 0) >= 1);
  const stables          = balances.filter((b) => STABLE_MINTS.has(b.mint) || STABLE_SYMBOLS.has((b.symbol ?? "").toUpperCase()));
  const stableTotal      = stables.reduce((s, b) => s + (b.usdValue ?? 0), 0);
  const nonStable        = balances
    .filter((b) => b.mint !== SOL_MINT && b.symbol !== "SOL" && !STABLE_MINTS.has(b.mint) && !STABLE_SYMBOLS.has((b.symbol ?? "").toUpperCase()) && (b.usdValue ?? 0) > 0)
    .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
    .slice(0, 10);

  // Cost-basis PnL from swap history (more accurate than GMGN for exited positions)
  const recentPnl = computeSwapPnl(swapTxns, address, solPrice, mintToSymbol).slice(0, 5);

  // Build message
  const gmgnUrl    = `https://gmgn.ai/sol/address/${address}`;
  const solscanUrl = `https://solscan.io/account/${address}`;

  let msg = `◎ <b>Wallet Analysis</b> · Solana\n`;
  msg += `<a href="${solscanUrl}"><code>${escapeHtml(address)}</code></a>\n\n`;

  if (firstTx) {
    msg += `🕰 <b>Wallet Age:</b> ${escapeHtml(formatTimeAgo(firstTx.timestamp))}${firstTx.isExact ? "" : "+"}\n`;
    msg += `   <i>First tx: ${escapeHtml(fmtDate(firstTx.timestamp))}</i>\n`;
  } else {
    msg += `🕰 <b>Wallet Age:</b> —\n`;
  }

  if (lastTxTime) {
    msg += `⏱ <b>Last Active:</b> ${escapeHtml(formatTimeAgo(lastTxTime))}\n`;
    msg += `   <i>${escapeHtml(fmtDate(lastTxTime))}</i>\n`;
  } else {
    msg += `⏱ <b>Last Active:</b> —\n`;
  }

  msg += "\n💼 <b>Portfolio</b>\n";
  msg += `   Total: <b>${escapeHtml(fmtUsd(totalUsdValue))}</b>\n`;
  if (solBalance && (solBalance.balance ?? 0) > 0) {
    msg += `   SOL: <b>${escapeHtml(solBalance.balance?.toFixed(3) ?? "0")} SOL</b>`;
    if ((solBalance.usdValue ?? 0) > 0) msg += ` (${escapeHtml(fmtUsd(solBalance.usdValue ?? 0))})`;
    msg += "\n";
  }
  msg += `   No of tokens held: <b>${tokensAbove1.length}</b>\n`;
  if (stableTotal > 0) {
    const breakdown = stables
      .filter((b) => (b.usdValue ?? 0) >= 1)
      .map((b) => `${escapeHtml(b.symbol ?? "?")} ${escapeHtml(fmtUsd(b.usdValue ?? 0))}`)
      .join(", ");
    msg += `   Stables: <b>${escapeHtml(fmtUsd(stableTotal))}</b>`;
    if (breakdown) msg += ` <i>(${breakdown})</i>`;
    msg += "\n";
  } else {
    msg += `   Stables: —\n`;
  }

  msg += "\n";

  if (nonStable.length > 0) {
    msg += `🏆 <b>Top Holdings</b>\n`;
    nonStable.forEach((b, i) => {
      msg += `   ${i + 1}. <b>${escapeHtml(b.symbol || "???")}</b> — ${escapeHtml(fmtUsd(b.usdValue ?? 0))}\n`;
    });
    msg += "\n";
  }

  msg += `📊 <b>Recent PnL</b>\n`;
  if (recentPnl.length > 0) {
    recentPnl.forEach((h, i) => {
      const pnlEmoji = h.realizedPnlUsd >= 0 ? "📈" : "📉";
      const active   = h.timestamp ? ` · ${escapeHtml(formatTimeAgo(h.timestamp))}` : "";
      msg += `   ${i + 1}. ${pnlEmoji} <b>${escapeHtml(h.symbol)}</b> ${escapeHtml(fmtPnl(h.realizedPnlUsd))}${active}\n`;
    });
  } else {
    msg += `   —\n`;
  }
  msg += "\n";

  if (meaningfulTxns.length > 0) {
    msg += `🔁 <b>Recent Transactions</b>\n`;
    meaningfulTxns.forEach((tx, i) => {
      const desc          = describeSolanaTx(tx, address, mintToSymbol);
      const solscanTxUrl  = `https://solscan.io/tx/${tx.signature}`;
      msg += `   ${i + 1}. ${desc} · <a href="${solscanTxUrl}"><i>${escapeHtml(formatTimeAgo(tx.timestamp))}</i></a>\n`;
    });
    msg += "\n";
  }

  msg += `<a href="${gmgnUrl}">GMGN</a> · <a href="${solscanUrl}">Solscan</a>`;

  await ctx.api.editMessageText(ctx.chat!.id, loadingMsgId, msg, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// ── EVM handler ───────────────────────────────────────────────────────────────

async function handleEvmWallet(
  ctx: MyContext,
  chain: ChainId,
  address: string,
  loadingMsgId: number
): Promise<void> {
  const moralisChain  = MORALIS_CHAIN[chain];
  const nativeSymbol  = EVM_NATIVE_SYMBOL[chain] ?? "ETH";
  const explorerUrl   = EVM_EXPLORER[chain] ?? "https://etherscan.io";
  const supportsProf  = PROFITABILITY_CHAINS.has(moralisChain);
  const addr          = address.toLowerCase();

  const [tokensData, swapsData, profData, netWorthData, gmgnHoldings, firstTxData] = await Promise.all([
    fetchMoralis<MoralisTokensResponse>(`/wallets/${addr}/tokens?chain=${moralisChain}&exclude_spam=true`),
    fetchMoralis<{ result: MoralisSwap[]; cursor: string | null }>(`/wallets/${addr}/swaps?chain=${moralisChain}&limit=50`),
    supportsProf
      ? fetchMoralis<{ result: MoralisProfEntry[] }>(`/wallets/${addr}/profitability?chain=${moralisChain}&days=30`)
      : Promise.resolve(null),
    fetchMoralis<MoralisNetWorthResponse>(`/wallets/${addr}/net-worth?chains[]=${moralisChain}&exclude_spam=true`),
    scrapeGmgnWalletHoldings(chain, address).catch(() => []),
    fetchMoralis<{ result: Array<{ block_timestamp: string }> }>(`/wallets/${addr}/history?chain=${moralisChain}&limit=1&order=ASC`),
  ]);

  const firstTxTs = firstTxData?.result?.[0]?.block_timestamp
    ? Math.floor(new Date(firstTxData.result[0].block_timestamp).getTime() / 1000)
    : null;

  // ── Net worth / native balance ─────────────────────────────────────────────
  const netWorthChain = netWorthData?.chains?.[0];
  const nativeBal     = tokensData?.native_balance;
  const nativeBalance = parseFloat(netWorthChain?.native_balance_formatted ?? nativeBal?.balance_formatted ?? "0") || 0;
  const nativeBalUsd  = parseFloat(netWorthChain?.native_balance_usd ?? nativeBal?.usd ?? "0") || 0;
  const totalNetWorth = parseFloat(netWorthData?.total_networth_usd ?? "0") || 0;

  // ── Tokens ─────────────────────────────────────────────────────────────────
  const stablecoins: { symbol: string; usd: number }[] = [];
  let   stableTotal  = 0;
  const positions: { symbol: string; address: string; usd: number }[] = [];

  for (const tok of tokensData?.result ?? []) {
    if (tok.possible_spam || tok.native_token) continue;
    const bal = parseFloat(tok.balance_formatted) || 0;
    if (bal <= 0) continue;
    const usd = tok.usd_value ?? 0;

    if (EVM_STABLE_SYMBOLS.has(tok.symbol.toUpperCase())) {
      const stableUsd = usd > 0 ? usd : bal;
      stablecoins.push({ symbol: tok.symbol, usd: stableUsd });
      stableTotal += stableUsd;
    } else if (usd >= 1) {
      positions.push({ symbol: tok.symbol, address: tok.token_address, usd });
    }
  }
  positions.sort((a, b) => b.usd - a.usd);
  const tokensAbove1  = positions.length;
  const top10         = positions.slice(0, 10);

  // ── Swaps → last active + recent activity ─────────────────────────────────
  const swaps = swapsData?.result ?? [];
  const lastSwapTs = swaps.length > 0
    ? Math.floor(new Date(swaps[0].blockTimestamp).getTime() / 1000)
    : null;

  // Filter swaps ≥ $1 for Recent Transactions
  const meaningfulSwaps = swaps
    .filter((s) => Math.abs(s.transactionType === "buy" ? s.sold.usdAmount : s.bought.usdAmount) >= 1)
    .slice(0, 5);

  // ── PnL ────────────────────────────────────────────────────────────────────
  const recentPnl: { symbol: string; pnl: number; when: number }[] = [];

  if (supportsProf && profData) {
    for (const e of profData.result) {
      const pnl = parseFloat(e.realized_profit_usd ?? "0") || 0;
      if (pnl === 0) continue;
      recentPnl.push({
        symbol: e.token_symbol,
        pnl,
        when: e.last_trade ? Math.floor(new Date(e.last_trade).getTime() / 1000) : 0,
      });
    }
    recentPnl.sort((a, b) => b.when - a.when);
  } else {
    // BSC: derive from sell swaps
    const seenTokens = new Set<string>();
    for (const s of swaps) {
      if (s.transactionType !== "sell") continue;
      const tokenAddr = s.sold.address.toLowerCase();
      if (seenTokens.has(tokenAddr)) continue;
      seenTokens.add(tokenAddr);
      recentPnl.push({
        symbol: s.sold.symbol,
        pnl: Math.abs(s.bought.usdAmount),
        when: Math.floor(new Date(s.blockTimestamp).getTime() / 1000),
      });
    }
  }

  // Also fold in GMGN PnL if available
  const gmgnPnl = gmgnHoldings
    .filter((h) => Math.abs(h.realizedPnlUsd) > 0)
    .sort((a, b) => (b.lastActiveTimestamp ?? 0) - (a.lastActiveTimestamp ?? 0))
    .slice(0, 5);

  // Use GMGN if richer (has more entries)
  const pnlSource = gmgnPnl.length >= recentPnl.length ? "gmgn" : "moralis";
  const pnlEntries = pnlSource === "gmgn" ? gmgnPnl.slice(0, 5) : recentPnl.slice(0, 5);

  // ── Build message ──────────────────────────────────────────────────────────
  const explorerAddrUrl = `${explorerUrl}/address/${address}`;
  const gmgnChainMap: Record<string, string> = { base: "base", bsc: "bsc", eth: "eth" };
  const gmgnChain       = gmgnChainMap[chain] ?? chain;
  const gmgnUrl         = `https://gmgn.ai/${gmgnChain}/address/${address}`;
  const emoji           = chainEmoji(chain);
  const label           = chainLabel(chain);

  let msg = `${emoji} <b>Wallet Analysis</b> · ${escapeHtml(label)}\n`;
  msg += `<a href="${explorerAddrUrl}"><code>${escapeHtml(address)}</code></a>\n\n`;

  if (firstTxTs) {
    msg += `🕰 <b>Wallet Age:</b> ${escapeHtml(formatTimeAgo(firstTxTs))}\n`;
    msg += `   <i>First tx: ${escapeHtml(fmtDate(firstTxTs))}</i>\n`;
  } else {
    msg += `🕰 <b>Wallet Age:</b> —\n`;
  }

  if (lastSwapTs) {
    msg += `⏱ <b>Last Active:</b> ${escapeHtml(formatTimeAgo(lastSwapTs))}\n`;
    msg += `   <i>${escapeHtml(fmtDate(lastSwapTs))}</i>\n`;
  } else {
    msg += `⏱ <b>Last Active:</b> —\n`;
  }

  msg += "\n💼 <b>Portfolio</b>\n";
  msg += `   Total: <b>${escapeHtml(fmtUsd(totalNetWorth))}</b>\n`;
  if (nativeBalance > 0) {
    msg += `   ${escapeHtml(nativeSymbol)}: <b>${escapeHtml(nativeBalance.toFixed(4))} ${escapeHtml(nativeSymbol)}</b>`;
    if (nativeBalUsd > 0) msg += ` (${escapeHtml(fmtUsd(nativeBalUsd))})`;
    msg += "\n";
  }
  msg += `   No of tokens held: <b>${tokensAbove1}</b>\n`;
  if (stableTotal > 0) {
    const breakdown = stablecoins
      .filter((s) => s.usd >= 1)
      .map((s) => `${escapeHtml(s.symbol)} ${escapeHtml(fmtUsd(s.usd))}`)
      .join(", ");
    msg += `   Stables: <b>${escapeHtml(fmtUsd(stableTotal))}</b>`;
    if (breakdown) msg += ` <i>(${breakdown})</i>`;
    msg += "\n";
  } else {
    msg += `   Stables: —\n`;
  }

  msg += "\n";

  if (top10.length > 0) {
    msg += `🏆 <b>Top Holdings</b>\n`;
    top10.forEach((p, i) => {
      msg += `   ${i + 1}. <b>${escapeHtml(p.symbol)}</b> — ${escapeHtml(fmtUsd(p.usd))}\n`;
    });
    msg += "\n";
  }

  msg += `📊 <b>Recent PnL</b>\n`;
  if (pnlEntries.length > 0) {
    if (pnlSource === "gmgn") {
      gmgnPnl.forEach((h, i) => {
        const pnlEmoji = h.realizedPnlUsd >= 0 ? "📈" : "📉";
        const active   = h.lastActiveTimestamp ? ` · ${escapeHtml(formatTimeAgo(h.lastActiveTimestamp))}` : "";
        msg += `   ${i + 1}. ${pnlEmoji} <b>${escapeHtml(h.symbol || "???")}</b> ${escapeHtml(fmtPnl(h.realizedPnlUsd))}${active}\n`;
      });
    } else {
      recentPnl.slice(0, 5).forEach((e, i) => {
        const pnlEmoji = e.pnl >= 0 ? "📈" : "📉";
        const active   = e.when ? ` · ${escapeHtml(formatTimeAgo(e.when))}` : "";
        msg += `   ${i + 1}. ${pnlEmoji} <b>${escapeHtml(e.symbol)}</b> ${escapeHtml(fmtPnl(e.pnl))}${active}\n`;
      });
    }
  } else {
    msg += `   —\n`;
  }
  msg += "\n";

  if (meaningfulSwaps.length > 0) {
    msg += `🔁 <b>Recent Transactions</b>\n`;
    meaningfulSwaps.forEach((s, i) => {
      const ts        = Math.floor(new Date(s.blockTimestamp).getTime() / 1000);
      const timeAgo   = escapeHtml(formatTimeAgo(ts));
      const txUrl     = `${explorerUrl}/tx/${s.transactionHash}`;
      let desc: string;
      if (s.transactionType === "buy") {
        const amtUsd = fmtUsd(Math.abs(s.sold.usdAmount));
        desc = `🟢 Bought <b>${escapeHtml(amtUsd)}</b> of <b>${escapeHtml(s.bought.symbol)}</b> (<code>${escapeHtml(s.bought.address)}</code>)`;
      } else {
        const amtUsd = fmtUsd(Math.abs(s.bought.usdAmount));
        desc = `🔴 Sold <b>${escapeHtml(s.sold.symbol)}</b> (<code>${escapeHtml(s.sold.address)}</code>) for <b>${escapeHtml(amtUsd)}</b>`;
      }
      msg += `   ${i + 1}. ${desc} · <a href="${txUrl}"><i>${timeAgo}</i></a>\n`;
    });
    msg += "\n";
  }

  msg += `<a href="${gmgnUrl}">GMGN</a> · <a href="${explorerAddrUrl}">${escapeHtml(label === "Ethereum" ? "Etherscan" : label === "BNB Chain" ? "BSCScan" : "Basescan")}</a>`;

  await ctx.api.editMessageText(ctx.chat!.id, loadingMsgId, msg, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function handleWallet(
  ctx: MyContext,
  chain: ChainId,
  address: string
): Promise<void> {
  const isSolana = chain === "solana";
  const emoji    = isSolana ? "◎" : chainEmoji(chain);

  const loading = await ctx.reply(
    `${emoji} <b>Analyzing wallet…</b>\n<code>${escapeHtml(address)}</code>\n\n<i>Fetching portfolio &amp; history…</i>`,
    { parse_mode: "HTML" }
  );

  try {
    if (isSolana) {
      await handleSolanaWallet(ctx, address, loading.message_id);
    } else {
      await handleEvmWallet(ctx, chain, address, loading.message_id);
    }
  } catch (err) {
    console.error("[bot/wallet]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to analyze wallet. Please try again."
    );
  }
}
