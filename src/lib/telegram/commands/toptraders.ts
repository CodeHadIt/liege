import type { MyContext } from "../bot";
import { getChainProvider } from "@/lib/chains/registry";
import { scrapeGmgnTopTraders } from "@/lib/api/gmgn-scraper";
import * as helius from "@/lib/api/helius";
import {
  escapeHtml,
  formatPnl,
  truncateAddress,
  chainEmoji,
  chainLabel,
  formatCompact,
} from "../utils/format";
import { tokenKeyboard } from "../utils/keyboards";
import type { ChainId } from "@/types/chain";

export async function handleTopTraders(
  ctx: MyContext,
  chain: ChainId,
  address: string
): Promise<void> {
  const loading = await ctx.reply(
    "🔍 Fetching top traders… this may take up to 60s ⏳"
  );

  try {
    if (chain !== "solana") {
      // EVM: GMGN provides full PnL data
      const traders = await scrapeGmgnTopTraders(chain, address).catch(() => []);

      if (traders.length === 0) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          "⚠️ No trader data available. GMGN may be temporarily unavailable — please try again."
        );
        return;
      }

      let msg = `${chainEmoji(chain)} <b>Top Traders</b> · ${chainLabel(chain)}\n`;
      msg += `<code>${escapeHtml(address)}</code>\n\n`;

      traders.slice(0, 10).forEach((t, i) => {
        const pnl = formatPnl(t.realizedProfitUsd);
        const pnlClass = t.realizedProfitUsd >= 0 ? "📈" : "📉";
        const trades = `${t.buyCount}B/${t.sellCount}S`;
        msg += `${i + 1}. <code>${escapeHtml(truncateAddress(t.walletAddress))}</code>\n`;
        msg += `   ${pnlClass} PnL: <b>${escapeHtml(pnl)}</b> · ${trades} trades\n`;
        if (t.balanceUsd > 0) {
          msg += `   💼 Holding: $${escapeHtml(formatCompact(t.balanceUsd))}\n`;
        }
      });

      await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
        parse_mode: "HTML",
        reply_markup: tokenKeyboard(chain, address),
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    // ── Solana: Helius swap history → real PnL ─────────────────────────────────

    const provider = getChainProvider("solana");
    const pairData = await provider.getPairData(address).catch(() => null);
    const priceUsd = pairData?.priceUsd ?? null;

    const holders = await provider.getTopHolders(address, 20);
    if (holders.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "⚠️ No holder data available for this token."
      );
      return;
    }

    // Resolve token accounts → wallet addresses
    const ownerMap = await helius.getMultipleAccountOwners(holders.map((h) => h.address));

    interface TraderResult {
      wallet: string;
      pnlUsd: number;
      buys: number;
      sells: number;
      balanceUsd: number;
    }

    const BATCH = 5;
    const results: TraderResult[] = [];

    for (let i = 0; i < holders.length; i += BATCH) {
      const batchHolders = holders.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batchHolders.map(async (holder): Promise<TraderResult | null> => {
          const walletAddr = ownerMap.get(holder.address) ?? holder.address;
          try {
            const history = await helius.getWalletHistoryAll(walletAddr, {
              maxPages: 1,
              limit: 100,
              type: "SWAP",
            });

            let totalBought = 0, totalSold = 0, buyCount = 0, sellCount = 0;
            for (const tx of history) {
              if (tx.error || !tx.timestamp) continue;
              const netChanges = new Map<string, number>();
              for (const bc of tx.balanceChanges) {
                netChanges.set(bc.mint, (netChanges.get(bc.mint) ?? 0) + bc.amount);
              }
              const delta = netChanges.get(address);
              if (!delta) continue;
              if (delta > 0) { totalBought += delta; buyCount++; }
              else { totalSold += Math.abs(delta); sellCount++; }
            }

            const remaining = holder.balance;
            const realizedPnlTokens = totalSold - totalBought + remaining;
            const pnlUsd = priceUsd ? realizedPnlTokens * priceUsd : 0;
            const balanceUsd = priceUsd ? remaining * priceUsd : 0;

            return { wallet: walletAddr, pnlUsd, buys: buyCount, sells: sellCount, balanceUsd };
          } catch {
            return null;
          }
        })
      );
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    results.sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd));

    let msg = `◎ <b>Top Traders</b> · Solana\n`;
    msg += `<code>${escapeHtml(address)}</code>\n\n`;

    results.slice(0, 10).forEach((t, i) => {
      const pnlClass = t.pnlUsd >= 0 ? "📈" : "📉";
      const trades = `${t.buys}B/${t.sells}S`;
      msg += `${i + 1}. <code>${escapeHtml(truncateAddress(t.wallet))}</code>\n`;
      msg += `   ${pnlClass} PnL: <b>${escapeHtml(formatPnl(t.pnlUsd))}</b> · ${trades} trades\n`;
      if (t.balanceUsd > 0) {
        msg += `   💼 Holding: $${escapeHtml(formatCompact(t.balanceUsd))}\n`;
      }
    });

    if (results.length === 0) {
      msg += "<i>No swap history found for top holders.</i>\n";
    }

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
      parse_mode: "HTML",
      reply_markup: tokenKeyboard(chain, address),
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("[bot/toptraders]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to fetch trader data. Please try again."
    );
  }
}
