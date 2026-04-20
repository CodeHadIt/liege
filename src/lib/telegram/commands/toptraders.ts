import type { MyContext } from "../bot";
import { scrapeGmgnTopTraders } from "@/lib/api/gmgn-scraper";
import {
  escapeHtml,
  formatPnl,
  truncateAddress,
  chainEmoji,
  chainLabel,
  formatCompact,
  splitPages,
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
    "🔍 Fetching top traders… this may take a minute ⏳"
  );

  try {
    const traders = await scrapeGmgnTopTraders(chain, address).catch(() => []);

    if (traders.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "⚠️ No trader data available. Our servers may be temporarily busy — please try again."
      );
      return;
    }

    const titleBase = `${chainEmoji(chain)} <b>Top Traders</b> · ${chainLabel(chain)}\n<code>${escapeHtml(address)}</code>`;

    const entries: string[] = traders.map((t, i) => {
      const pnl = formatPnl(t.realizedProfitUsd);
      const pnlClass = t.realizedProfitUsd >= 0 ? "📈" : "📉";
      const url = gmgnWalletUrl(chain, t.walletAddress);
      let entry = `${i + 1}. <a href="${url}">${escapeHtml(truncateAddress(t.walletAddress))}</a>\n`;
      entry += `   ${pnlClass} PnL: <b>${escapeHtml(pnl)}</b>\n`;
      if (t.balanceUsd > 0) {
        entry += `   💼 Holding: $${escapeHtml(formatCompact(t.balanceUsd))}\n`;
      }
      entry += "\n";
      return entry;
    });

    const pages = splitPages(entries, (page, total) => {
      const pageLabel = total > 1 ? `  <i>${page}/${total}</i>` : "";
      return `${titleBase}${pageLabel}\n\n`;
    });

    for (let p = 0; p < pages.length; p++) {
      if (p === 0) {
        await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, pages[p], {
          parse_mode: "HTML",
          reply_markup: tokenKeyboard(chain, address),
          link_preview_options: { is_disabled: true },
        });
      } else {
        await ctx.reply(pages[p], {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
    }
  } catch (err) {
    console.error("[bot/toptraders]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to fetch trader data. Please try again."
    );
  }
}
