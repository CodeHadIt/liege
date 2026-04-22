import type { MyContext } from "../bot";
import { getChainProvider } from "@/lib/chains/registry";
import { scrapeGmgnHoldersPaginated } from "@/lib/api/gmgn-scraper";
import {
  escapeHtml,
  truncateAddress,
  chainEmoji,
  chainLabel,
  formatTimeAgo,
  splitPages,
} from "../utils/format";
import type { ChainId } from "@/types/chain";

// ── Constants ─────────────────────────────────────────────────────────────────

const GMGN_CHAIN: Record<string, string> = {
  solana: "sol",
  base:   "base",
  bsc:    "bsc",
  eth:    "eth",
};

const DIAMOND_MULTIPLIER = 20; // avgBuyMC must be ≥ 20× currentMC

// ── Wealth tier ───────────────────────────────────────────────────────────────

type WealthTier = "whale" | "dolphin" | "fish" | "shrimp";

function wealthTier(usd: number): WealthTier {
  if (usd >= 10_000) return "whale";
  if (usd >= 1_000)  return "dolphin";
  if (usd >= 100)    return "fish";
  return "shrimp";
}

const TIER_EMOJI: Record<WealthTier, string> = {
  whale:   "🐋",
  dolphin: "🐬",
  fish:    "🐟",
  shrimp:  "🦐",
};

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1)         return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtMc(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleDiamond(
  ctx: MyContext,
  chain: ChainId,
  tokenAddress: string
): Promise<void> {
  const loading = await ctx.reply(
    `💎 <b>Scanning for diamond hands…</b>\n<code>${escapeHtml(tokenAddress)}</code>\n\n<i>Fetching holders &amp; market data…</i>`,
    { parse_mode: "HTML" }
  );

  try {
    // ── Fetch token price + MC in parallel with holder scrape ─────────────────
    const provider = getChainProvider(chain);
    const [pairData, holders] = await Promise.all([
      provider.getPairData(tokenAddress).catch(() => null),
      scrapeGmgnHoldersPaginated(chain, tokenAddress, 5).catch(() => []),
    ]);

    const tokenSymbol = pairData?.primaryPair?.baseToken?.symbol ?? tokenAddress.slice(0, 8);
    const currentPrice = pairData?.priceUsd ?? 0;
    const currentMc    = pairData?.marketCap ?? pairData?.fdv ?? 0;

    if (currentPrice <= 0 || currentMc <= 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "❌ Could not fetch token market data. Make sure this is a valid token address."
      );
      return;
    }

    if (holders.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "❌ Could not fetch holder data for this token."
      );
      return;
    }

    // ── Filter diamond hands ──────────────────────────────────────────────────
    // Diamond hand: avgCostUsd >= DIAMOND_MULTIPLIER × currentPrice
    // (equivalent to avgBuyMC >= DIAMOND_MULTIPLIER × currentMC)
    const diamondHands = holders.filter(
      (h) =>
        h.avgCostUsd > 0 &&
        h.balance > 0 &&                              // still holding
        h.avgCostUsd >= DIAMOND_MULTIPLIER * currentPrice
    );

    if (diamondHands.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `💎 <b>Diamond Hands — ${escapeHtml(tokenSymbol)}</b>\n\n` +
        `No holders found with an average buy MC ≥ ${DIAMOND_MULTIPLIER}× the current MC (${escapeHtml(fmtMc(currentMc))}).\n\n` +
        `<i>Scanned ${holders.length} holders.</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Sort by multiple (highest avgBuyMC / currentMC first)
    diamondHands.sort((a, b) => b.avgCostUsd - a.avgCostUsd);

    // ── Build entries ─────────────────────────────────────────────────────────
    const gmgnSlug    = GMGN_CHAIN[chain] ?? chain;
    const nowSec      = Math.floor(Date.now() / 1000);

    const entries: string[] = diamondHands.map((h, i) => {
      const gmgnUrl      = `https://gmgn.ai/${gmgnSlug}/address/${h.walletAddress}`;
      const addrLabel    = escapeHtml(truncateAddress(h.walletAddress));
      const tier         = TIER_EMOJI[wealthTier(h.balanceUsd)];
      const multiple     = (h.avgCostUsd / currentPrice).toFixed(1);
      const avgBuyMc     = (h.avgCostUsd / currentPrice) * currentMc;

      const holdSecs     = h.openTimestamp ? nowSec - h.openTimestamp : null;
      const holdTime     = holdSecs
        ? escapeHtml(formatTimeAgo(h.openTimestamp ?? 0))
        : "—";

      let entry = `${i + 1}. <a href="${gmgnUrl}">${addrLabel}</a> ${tier}\n`;
      entry += `   💰 Bought: <b>${escapeHtml(fmtUsd(h.historyBoughtCostUsd))}</b>`;
      if (h.historySoldIncomeUsd > 0) {
        entry += `  |  💸 Sold: <b>${escapeHtml(fmtUsd(h.historySoldIncomeUsd))}</b>`;
      }
      entry += "\n";
      entry += `   📦 Holding: <b>${escapeHtml(fmtUsd(h.balanceUsd))}</b>\n`;
      entry += `   ⏳ Hold Time: <b>${holdTime}</b>\n`;
      entry += `   📈 Avg Buy MC: <b>${escapeHtml(fmtMc(avgBuyMc))}</b> <i>(${escapeHtml(multiple)}× current)</i>\n`;
      entry += "\n";
      return entry;
    });

    // ── Paginate & send ───────────────────────────────────────────────────────
    const emoji     = chainEmoji(chain);
    const chainName = chainLabel(chain);
    const titleBase = `💎 <b>Diamond Hands</b> · ${escapeHtml(tokenSymbol)} · ${emoji} ${escapeHtml(chainName)}`;
    const preamble  =
      `Current MC: <b>${escapeHtml(fmtMc(currentMc))}</b> · Filter: ≥${DIAMOND_MULTIPLIER}× avg buy MC\n` +
      `Found <b>${diamondHands.length}</b> diamond hand${diamondHands.length === 1 ? "" : "s"} (scanned ${holders.length})\n\n`;

    const pages = splitPages(entries, (page, total) => {
      const pageLabel = total > 1 ? `  <i>${page}/${total}</i>` : "";
      const header = `${titleBase}${pageLabel}\n`;
      return page === 1 ? header + preamble : header + "\n";
    });

    for (let p = 0; p < pages.length; p++) {
      if (p === 0) {
        await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, pages[p], {
          parse_mode: "HTML",
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
    console.error("[bot/diamond]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to fetch diamond hands. Please try again."
    );
  }
}
