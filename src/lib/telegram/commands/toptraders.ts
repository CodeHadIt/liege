import type { MyContext } from "../bot";
import { scrapeGmgnTopTraders } from "@/lib/api/gmgn-scraper";
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

const GMGN_CHAIN: Record<string, string> = {
  solana: "sol",
  base:   "base",
  bsc:    "bsc",
  eth:    "eth",
};

function gmgnWalletUrl(chain: ChainId, wallet: string): string {
  const slug = GMGN_CHAIN[chain] ?? chain;
  return `https://gmgn.ai/${slug}/address/${wallet}`;
}

export async function handleTopTraders(
  ctx: MyContext,
  chain: ChainId,
  address: string
): Promise<void> {
  const loading = await ctx.reply(
    "🔍 Fetching top traders… this may take up to 2 mins ⏳"
  );

  try {
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
      const url = gmgnWalletUrl(chain, t.walletAddress);
      msg += `${i + 1}. <a href="${url}">${escapeHtml(truncateAddress(t.walletAddress))}</a>\n`;
      msg += `   ${pnlClass} PnL: <b>${escapeHtml(pnl)}</b>\n`;
      if (t.balanceUsd > 0) {
        msg += `   💼 Holding: $${escapeHtml(formatCompact(t.balanceUsd))}\n`;
      }
    });

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
