import type { MyContext } from "../bot";
import { scrapeGmgnTopTraders, scrapeGeckoTerminalTopTraders } from "@/lib/api/gmgn-scraper";
import type { GeckoTopTrader } from "@/lib/api/gmgn-scraper";
import { getTokenPools } from "@/lib/api/geckoterminal";
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

// ── TON: GeckoTerminal-based top traders ──────────────────────────────────────

async function handleTonTopTraders(
  ctx: MyContext,
  loadingMsgId: number,
  tokenAddress: string
): Promise<void> {
  const pools = await getTokenPools("ton", tokenAddress).catch(() => []);

  if (pools.length === 0) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loadingMsgId,
      "⚠️ No GeckoTerminal pool found for this TON token."
    );
    return;
  }

  // Pick the pool with highest liquidity
  const sorted = [...pools].sort(
    (a, b) =>
      (parseFloat(b.attributes.reserve_in_usd) || 0) -
      (parseFloat(a.attributes.reserve_in_usd) || 0)
  );
  const poolAddress = sorted[0].attributes.address;

  const traders: GeckoTopTrader[] = await scrapeGeckoTerminalTopTraders("ton", poolAddress).catch(() => []);

  if (traders.length === 0) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loadingMsgId,
      "⚠️ No trader data available. Our servers may be temporarily busy — please try again."
    );
    return;
  }

  const titleBase = `💎 <b>Top Traders</b> · TON\n<code>${escapeHtml(tokenAddress)}</code>`;

  // Up to 20; splitPages enforces the character limit automatically
  const entries: string[] = traders.slice(0, 20).map((t, i) => {
    const pnlSign   = t.pnlUsd >= 0 ? "📈" : "📉";
    const pnl       = formatPnl(t.pnlUsd);
    const walletUrl = `https://tonviewer.com/${t.walletAddress}`;
    const buyStr    = t.buyVolumeUsd  > 0 ? `$${escapeHtml(formatCompact(t.buyVolumeUsd))}`  : "—";
    const sellStr   = t.sellVolumeUsd > 0 ? `$${escapeHtml(formatCompact(t.sellVolumeUsd))}` : "—";

    let entry = `${i + 1}. <a href="${walletUrl}">${escapeHtml(truncateAddress(t.walletAddress))}</a>\n`;
    entry += `   🛒 <b>${buyStr}</b>  ·  💰 <b>${sellStr}</b>\n`;
    entry += `   ${pnlSign} PnL: <b>${escapeHtml(pnl)}</b>\n\n`;
    return entry;
  });

  const pages = splitPages(entries, (page, total) => {
    const pageLabel = total > 1 ? `  <i>${page}/${total}</i>` : "";
    return `${titleBase}${pageLabel}\n\n`;
  });

  for (let p = 0; p < pages.length; p++) {
    if (p === 0) {
      await ctx.api.editMessageText(ctx.chat!.id, loadingMsgId, pages[p], {
        parse_mode: "HTML",
        reply_markup: tokenKeyboard("ton", tokenAddress),
        link_preview_options: { is_disabled: true },
      });
    } else {
      await ctx.reply(pages[p], {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleTopTraders(
  ctx: MyContext,
  chain: ChainId,
  address: string
): Promise<void> {
  const loading = await ctx.reply(
    "🔍 Fetching top traders… this may take a minute ⏳"
  );

  try {
    if (chain === "ton") {
      await handleTonTopTraders(ctx, loading.message_id, address);
      return;
    }

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

    const entries: string[] = traders.slice(0, 20).map((t, i) => {
      const pnl      = formatPnl(t.realizedProfitUsd);
      const pnlClass = t.realizedProfitUsd >= 0 ? "📈" : "📉";
      const url      = gmgnWalletUrl(chain, t.walletAddress);
      const buyStr   = t.historyBoughtCostUsd  > 0 ? `$${escapeHtml(formatCompact(t.historyBoughtCostUsd))}`  : "—";
      const sellStr  = t.historySoldIncomeUsd  > 0 ? `$${escapeHtml(formatCompact(t.historySoldIncomeUsd))}` : "—";

      let entry = `${i + 1}. <a href="${url}">${escapeHtml(truncateAddress(t.walletAddress))}</a>\n`;
      entry += `   🛒 <b>${buyStr}</b>  ·  💰 <b>${sellStr}</b>\n`;
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
