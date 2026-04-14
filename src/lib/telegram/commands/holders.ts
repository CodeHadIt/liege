import type { MyContext } from "../bot";
import { getChainProvider } from "@/lib/chains/registry";
import { scrapeGmgnTopHolders } from "@/lib/api/gmgn-scraper";
import {
  escapeHtml,
  truncateAddress,
  chainEmoji,
  chainLabel,
  formatAge,
  splitPages,
} from "../utils/format";
import { tokenKeyboard } from "../utils/keyboards";
import type { ChainId } from "@/types/chain";

const GMGN_CHAIN: Record<string, string> = {
  solana: "sol",
  base:   "base",
  bsc:    "bsc",
};

const CHAIN_COLOR: Record<string, string> = {
  solana: "🟣",
  base:   "🔵",
  bsc:    "🟡",
};

type WealthTier = "whale" | "dolphin" | "fish" | "shrimp" | "unknown";

function wealthTier(balanceUsd: number | null): WealthTier {
  if (balanceUsd == null) return "unknown";
  if (balanceUsd >= 10_000) return "whale";
  if (balanceUsd >= 1_000)  return "dolphin";
  if (balanceUsd >= 100)    return "fish";
  return "shrimp";
}

const TIER_EMOJI: Record<WealthTier, string> = {
  whale:   "🐋",
  dolphin: "🐬",
  fish:    "🐟",
  shrimp:  "🦐",
  unknown: "•",
};

interface RichHolder {
  address: string;
  percentage: number;
  balanceUsd: number | null;
  openTimestamp: number | null;
}

export async function handleHolders(
  ctx: MyContext,
  chain: ChainId,
  address: string
): Promise<void> {
  const loading = await ctx.reply("🔍 Fetching top holders…");

  try {
    const provider = getChainProvider(chain);

    // Fetch pair data for token name + price (Solana needs price for USD calc)
    const pairData = await provider.getPairData(address).catch(() => null);
    const tokenSymbol = pairData?.primaryPair?.baseToken?.symbol ?? null;
    const priceUsd = pairData?.priceUsd ?? null;

    let holders: RichHolder[] = [];

    if (chain === "solana") {
      const rawHolders = await provider.getTopHolders(address, 20);
      holders = rawHolders.map((h) => ({
        address: h.address,
        percentage: h.percentage,
        balanceUsd: priceUsd && h.balance > 0 ? h.balance * priceUsd : null,
        openTimestamp: null,
      }));
    } else {
      // EVM — use GMGN for true holder rankings with USD values
      const gmgnHolders = await scrapeGmgnTopHolders(chain, address).catch(() => []);

      if (gmgnHolders.length > 0) {
        const fdv = pairData?.fdv ?? null;
        const totalSupply =
          priceUsd && priceUsd > 0 && fdv && fdv > 0 ? fdv / priceUsd : null;
        const totalHeld = gmgnHolders.reduce((s, t) => s + t.balance, 0);

        holders = gmgnHolders.slice(0, 20).map((t) => {
          let percentage = 0;
          if (t.supplyPercent > 0) {
            percentage = t.supplyPercent <= 1 ? t.supplyPercent * 100 : t.supplyPercent;
          } else if (totalSupply && totalSupply > 0) {
            percentage = (t.balance / totalSupply) * 100;
          } else if (totalHeld > 0) {
            percentage = (t.balance / totalHeld) * 100;
          }
          return {
            address: t.walletAddress,
            percentage,
            balanceUsd: t.balanceUsd > 0 ? t.balanceUsd : null,
            openTimestamp: t.openTimestamp,
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

    const gmgnChain = GMGN_CHAIN[chain] ?? chain;
    const chainColor = CHAIN_COLOR[chain] ?? chainEmoji(chain);

    // Build summary stats (always on page 1 as preamble)
    const tokenLabel = tokenSymbol ? ` <b>${escapeHtml(tokenSymbol)}</b> ·` : "";
    const titleBase = `${chainColor}${tokenLabel} Top Holders · ${chainLabel(chain)}\n<code>${escapeHtml(address)}</code>`;

    const top10pct = holders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    let preamble = `📊 Top 10 hold <b>${top10pct.toFixed(1)}%</b> of supply\n`;

    const tiers: WealthTier[] = ["whale", "dolphin", "fish", "shrimp"];
    const tierStats = tiers.map((tier) => {
      const group = holders.filter((h) => wealthTier(h.balanceUsd) === tier);
      const pct = group.reduce((s, h) => s + h.percentage, 0);
      return { tier, count: group.length, pct };
    }).filter((t) => t.count > 0);

    if (tierStats.length > 0) {
      preamble += tierStats.map((t) => `${TIER_EMOJI[t.tier]} ${t.count} (${t.pct.toFixed(1)}%)`).join("  ") + "\n";
    }
    preamble += "\n";

    // Build one entry per holder
    const entries: string[] = holders.map((h, i) => {
      const tier = wealthTier(h.balanceUsd);
      const emoji = TIER_EMOJI[tier];
      const pct = h.percentage > 0 ? ` — ${h.percentage.toFixed(2)}%` : "";
      const holdDur = h.openTimestamp ? `  · <i>${formatAge(h.openTimestamp)}</i>` : "";
      const gmgnUrl = `https://gmgn.ai/${gmgnChain}/address/${h.address}`;
      const addrLabel = escapeHtml(truncateAddress(h.address));
      return `${i + 1}. <a href="${gmgnUrl}">${addrLabel}</a>${pct}  ${emoji}${holdDur}\n`;
    });

    const pages = splitPages(entries, (page, total) => {
      const pageLabel = total > 1 ? `  <i>${page}/${total}</i>` : "";
      const header = `${titleBase}${pageLabel}\n\n`;
      return page === 1 ? header + preamble : header;
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
    console.error("[bot/holders]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to fetch holder data. Please try again."
    ).catch(() => null);
  }
}
