import type { MyContext } from "../bot";
import { getChainProvider } from "@/lib/chains/registry";
import { scrapeGmgnTopHolders } from "@/lib/api/gmgn-scraper";
import {
  escapeHtml,
  truncateAddress,
  chainEmoji,
  chainLabel,
  formatCompact,
} from "../utils/format";
import { viewOnSiteKeyboard } from "../utils/keyboards";
import type { ChainId } from "@/types/chain";
import type { HolderEntry } from "@/types/token";

export async function handleHolders(
  ctx: MyContext,
  chain: ChainId,
  address: string
): Promise<void> {
  const loading = await ctx.reply("🔍 Fetching top holders…");

  try {
    let holders: HolderEntry[] = [];

    if (chain === "solana") {
      const provider = getChainProvider("solana");
      holders = await provider.getTopHolders(address, 20);
    } else {
      // EVM — GMGN has true holder rankings
      const provider = getChainProvider(chain);
      const [gmgnHolders, pairData] = await Promise.all([
        scrapeGmgnTopHolders(chain, address).catch(() => []),
        provider.getPairData(address).catch(() => null),
      ]);

      if (gmgnHolders.length > 0) {
        const priceUsd = pairData?.priceUsd ?? null;
        const fdv = pairData?.fdv ?? null;
        const totalSupply =
          priceUsd && priceUsd > 0 && fdv && fdv > 0
            ? fdv / priceUsd
            : null;
        const totalHeld = gmgnHolders.reduce((s, t) => s + t.balance, 0);

        holders = gmgnHolders.slice(0, 20).map((t) => {
          let percentage = 0;
          if (t.supplyPercent > 0) {
            percentage =
              t.supplyPercent <= 1 ? t.supplyPercent * 100 : t.supplyPercent;
          } else if (totalSupply && totalSupply > 0) {
            percentage = (t.balance / totalSupply) * 100;
          } else if (totalHeld > 0) {
            percentage = (t.balance / totalHeld) * 100;
          }
          return {
            address: t.walletAddress,
            balance: t.balance,
            percentage,
            isContract: null,
            label: null,
          };
        });
      }
    }

    if (holders.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "⚠️ No holder data available for this token."
      );
      return;
    }

    let msg = `${chainEmoji(chain)} <b>Top Holders</b> · ${chainLabel(chain)}\n`;
    msg += `<code>${escapeHtml(address)}</code>\n\n`;

    // Concentration summary
    const top10 = holders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    msg += `📊 Top 10 hold <b>${top10.toFixed(1)}%</b> of supply\n\n`;

    holders.slice(0, 20).forEach((h, i) => {
      const rank = i + 1;
      const pct = h.percentage > 0 ? ` — ${h.percentage.toFixed(2)}%` : "";
      const bal =
        h.balance > 0 ? ` (${escapeHtml(formatCompact(h.balance))})` : "";
      msg += `${rank}. <code>${escapeHtml(truncateAddress(h.address))}</code>${pct}${bal}\n`;
    });

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
      parse_mode: "HTML",
      reply_markup: viewOnSiteKeyboard(chain, address),
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("[bot/holders]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to fetch holder data. Please try again."
    );
  }
}
