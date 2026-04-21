import type { MyContext } from "../bot";
import {
  getWalletBalances,
  getTransactionHistory,
  getWalletFirstTransaction,
  getMintInfo,
} from "@/lib/api/helius";
import { scrapeGmgnWalletHoldings } from "@/lib/api/gmgn-scraper";
import {
  escapeHtml,
  formatCompact,
  chainEmoji,
  chainLabel,
  formatTimeAgo,
} from "../utils/format";
import type { ChainId } from "@/types/chain";

// ── Constants ─────────────────────────────────────────────────────────────────

// Solana stablecoin mints
const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",  // WETH (Wormhole)
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",  // BTC (Wormhole)
]);

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "BUSD", "FRAX", "TUSD", "USDH", "UXD"]);

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

// ── Formatting helpers ────────────────────────────────────────────────────────

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

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleWallet(
  ctx: MyContext,
  chain: ChainId,
  address: string
): Promise<void> {
  // Only Solana is fully supported for now
  if (chain !== "solana") {
    await ctx.reply(
      `⚠️ EVM wallet analysis is coming soon. Only Solana is supported right now.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const loading = await ctx.reply(
    `◎ <b>Analyzing wallet…</b>\n<code>${escapeHtml(address)}</code>\n\n<i>Fetching portfolio &amp; history…</i>`,
    { parse_mode: "HTML" }
  );

  try {
    // All data sources in parallel
    const [balancesRes, recentTxns, firstTx, gmgnHoldings] = await Promise.all([
      getWalletBalances(address).catch(() => null),
      getTransactionHistory(address, 1).catch(() => []),
      getWalletFirstTransaction(address, 3).catch(() => null),
      scrapeGmgnWalletHoldings("solana", address).catch(() => []),
    ]);

    if (!balancesRes) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "❌ Could not fetch wallet data. Make sure this is a valid Solana wallet address."
      );
      return;
    }

    const { balances, totalUsdValue } = balancesRes;

    // ── Portfolio stats ───────────────────────────────────────────────────────

    // Tokens with ≥$1 (exclude native SOL for token count)
    const tokenBalances = balances.filter(
      (b) => b.mint !== "So11111111111111111111111111111111111111112" // wrapped SOL / native SOL placeholder
    );
    const tokensAbove1 = tokenBalances.filter((b) => (b.usdValue ?? 0) >= 1);

    // Stablecoins
    const stables = balances.filter(
      (b) =>
        STABLE_MINTS.has(b.mint) ||
        STABLE_SYMBOLS.has((b.symbol ?? "").toUpperCase())
    );
    const stableTotal = stables.reduce((s, b) => s + (b.usdValue ?? 0), 0);

    // Top 5 non-stable tokens by USD value
    const nonStable = balances
      .filter(
        (b) =>
          !STABLE_MINTS.has(b.mint) &&
          !STABLE_SYMBOLS.has((b.symbol ?? "").toUpperCase()) &&
          (b.usdValue ?? 0) > 0
      )
      .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
      .slice(0, 5);

    // SOL balance
    const solBalance = balances.find(
      (b) =>
        b.mint === "So11111111111111111111111111111111111111112" ||
        b.symbol === "SOL"
    );

    // ── Transaction stats ─────────────────────────────────────────────────────

    const lastTx = recentTxns[0] ?? null;
    const lastTxTime = lastTx?.timestamp ?? null;

    // ── PnL (top 5 recent trades from GMGN) ──────────────────────────────────

    const recentPnl = gmgnHoldings
      .filter((h) => h.investedUsd > 0 || Math.abs(h.realizedPnlUsd) > 0)
      .sort((a, b) => (b.lastActiveTimestamp ?? 0) - (a.lastActiveTimestamp ?? 0))
      .slice(0, 5);

    // ── Build message ─────────────────────────────────────────────────────────

    const gmgnUrl = `https://gmgn.ai/sol/address/${address}`;
    const solscanUrl = `https://solscan.io/account/${address}`;

    let msg = `◎ <b>Wallet Analysis</b> · Solana\n`;
    msg += `<a href="${solscanUrl}"><code>${escapeHtml(address)}</code></a>\n\n`;

    // Age
    if (firstTx) {
      const ageStr = formatTimeAgo(firstTx.timestamp);
      const dateStr = fmtDate(firstTx.timestamp);
      msg += `🕰 <b>Wallet Age:</b> ${escapeHtml(ageStr)}${firstTx.isExact ? "" : "+"}\n`;
      msg += `   <i>First tx: ${escapeHtml(dateStr)}</i>\n`;
    } else {
      msg += `🕰 <b>Wallet Age:</b> —\n`;
    }

    // Last transaction
    if (lastTxTime) {
      msg += `⏱ <b>Last Active:</b> ${escapeHtml(formatTimeAgo(lastTxTime))}\n`;
      msg += `   <i>${escapeHtml(fmtDate(lastTxTime))}</i>\n`;
    } else {
      msg += `⏱ <b>Last Active:</b> —\n`;
    }

    msg += "\n";

    // Portfolio summary
    msg += `💼 <b>Portfolio</b>\n`;
    msg += `   Total: <b>${escapeHtml(fmtUsd(totalUsdValue))}</b>\n`;
    if (solBalance && (solBalance.balance ?? 0) > 0) {
      msg += `   SOL: <b>${escapeHtml(solBalance.balance?.toFixed(3) ?? "0")} SOL</b>`;
      if ((solBalance.usdValue ?? 0) > 0) msg += ` (${escapeHtml(fmtUsd(solBalance.usdValue ?? 0))})`;
      msg += "\n";
    }
    msg += `   Tokens ≥$1: <b>${tokensAbove1.length}</b>\n`;
    if (stableTotal > 0) {
      const stableBreakdown = stables
        .filter((b) => (b.usdValue ?? 0) >= 1)
        .map((b) => `${escapeHtml(b.symbol ?? "?")} ${escapeHtml(fmtUsd(b.usdValue ?? 0))}`)
        .join(", ");
      msg += `   Stables: <b>${escapeHtml(fmtUsd(stableTotal))}</b>`;
      if (stableBreakdown) msg += ` <i>(${stableBreakdown})</i>`;
      msg += "\n";
    } else {
      msg += `   Stables: —\n`;
    }

    msg += "\n";

    // Top 5 tokens
    if (nonStable.length > 0) {
      msg += `🏆 <b>Top Holdings</b>\n`;
      nonStable.forEach((b, i) => {
        const sym = escapeHtml(b.symbol || "???");
        const usd = escapeHtml(fmtUsd(b.usdValue ?? 0));
        msg += `   ${i + 1}. <b>${sym}</b> — ${usd}\n`;
      });
      msg += "\n";
    }

    // Top 5 recent PnL
    if (recentPnl.length > 0) {
      msg += `📊 <b>Recent PnL</b>\n`;
      recentPnl.forEach((h, i) => {
        const sym = escapeHtml(h.symbol || "???");
        const pnl = escapeHtml(fmtPnl(h.realizedPnlUsd));
        const pnlEmoji = h.realizedPnlUsd >= 0 ? "📈" : "📉";
        const active = h.lastActiveTimestamp
          ? ` · ${escapeHtml(formatTimeAgo(h.lastActiveTimestamp))}`
          : "";
        msg += `   ${i + 1}. ${pnlEmoji} <b>${sym}</b> ${pnl}${active}\n`;
      });
      msg += "\n";
    }

    // Footer links
    msg += `<a href="${gmgnUrl}">GMGN</a> · <a href="${solscanUrl}">Solscan</a>`;

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("[bot/wallet]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to analyze wallet. Please try again."
    );
  }
}
