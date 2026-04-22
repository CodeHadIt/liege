import type { MyContext } from "../bot";
import { getChainProvider } from "@/lib/chains/registry";
import { scrapeGmgnHoldersPaginated } from "@/lib/api/gmgn-scraper";
import {
  escapeHtml,
  truncateAddress,
  chainEmoji,
  chainLabel,
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

const TOP_N = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1)         return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtDate(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return d.toUTCString().replace(" GMT", " UTC");
}

function fmtHoldDuration(openTimestamp: number): string {
  const secs = Math.floor(Date.now() / 1000) - openTimestamp;
  const days   = Math.floor(secs / 86400);
  const months = Math.floor(days / 30);
  const years  = Math.floor(days / 365);
  if (years > 0)  return `${years}y ${days % 365 < 30 ? "" : `${Math.floor((days % 365) / 30)}m`}`.trim();
  if (months > 0) return `${months}mo ${days % 30}d`.trim();
  if (days > 0)   return `${days}d`;
  return `${Math.floor(secs / 3600)}h`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleDiamond(
  ctx: MyContext,
  chain: ChainId,
  tokenAddress: string
): Promise<void> {
  const loading = await ctx.reply(
    `💎 <b>Finding longest holders…</b>\n<code>${escapeHtml(tokenAddress)}</code>\n\n<i>Fetching holder history…</i>`,
    { parse_mode: "HTML" }
  );

  try {
    const provider = getChainProvider(chain);
    const [pairData, holders] = await Promise.all([
      provider.getPairData(tokenAddress).catch(() => null),
      scrapeGmgnHoldersPaginated(chain, tokenAddress, 5).catch(() => []),
    ]);

    const tokenSymbol = pairData?.primaryPair?.baseToken?.symbol ?? tokenAddress.slice(0, 8);

    if (holders.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "❌ Could not fetch holder data for this token."
      );
      return;
    }

    // Only holders with a known openTimestamp and still holding
    const withTimestamp = holders.filter(
      (h) => h.openTimestamp !== null && h.openTimestamp > 0 && h.balance > 0
    );

    if (withTimestamp.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "❌ No hold-time data available for this token's holders."
      );
      return;
    }

    // Sort oldest first (smallest openTimestamp = held longest)
    withTimestamp.sort((a, b) => (a.openTimestamp ?? 0) - (b.openTimestamp ?? 0));

    const top = withTimestamp.slice(0, TOP_N);
    const gmgnSlug = GMGN_CHAIN[chain] ?? chain;

    const entries: string[] = top.map((h, i) => {
      const gmgnUrl   = `https://gmgn.ai/${gmgnSlug}/address/${h.walletAddress}`;
      const addrLabel = escapeHtml(truncateAddress(h.walletAddress));
      const buyDate   = escapeHtml(fmtDate(h.openTimestamp!));
      const holdDur   = escapeHtml(fmtHoldDuration(h.openTimestamp!));

      let entry = `${i + 1}. <a href="${gmgnUrl}">${addrLabel}</a>\n`;
      entry += `   📅 Holding since: <b>${buyDate}</b> <i>(${holdDur})</i>\n`;
      entry += `   💰 Invested: <b>${escapeHtml(fmtUsd(h.historyBoughtCostUsd))}</b>`;
      if (h.historySoldIncomeUsd > 0) {
        entry += `  |  💸 Sold: <b>${escapeHtml(fmtUsd(h.historySoldIncomeUsd))}</b>`;
      }
      entry += "\n";
      entry += `   🔄 Txns: <b>${h.buyCount}B / ${h.sellCount}S</b>\n`;
      entry += `   📦 Holding now: <b>${escapeHtml(fmtUsd(h.balanceUsd))}</b>\n`;
      entry += "\n";
      return entry;
    });

    const emoji     = chainEmoji(chain);
    const chainName = chainLabel(chain);
    const titleBase = `💎 <b>Diamond Hands</b> · ${escapeHtml(tokenSymbol)} · ${emoji} ${escapeHtml(chainName)}`;
    const preamble  = `Top ${top.length} holders by hold duration (scanned ${holders.length})\n\n`;

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
