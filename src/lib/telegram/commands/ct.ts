import type { MyContext } from "../bot";
import { ctChainKeyboard } from "../utils/keyboards";
import {
  escapeHtml,
  formatPnl,
  truncateAddress,
  chainEmoji,
  chainLabel,
  splitPages,
} from "../utils/format";
import type { ChainId } from "@/types/chain";
import type { CommonTradersResponse } from "@/types/traders";

function fmtMc(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1)         return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

const _rawAppUrl =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://liege.up.railway.app";
const APP_URL = _rawAppUrl.startsWith("http")
  ? _rawAppUrl
  : `https://${_rawAppUrl}`;

const GMGN_CHAIN: Record<string, string> = {
  solana: "sol",
  base:   "base",
  bsc:    "bsc",
};

function gmgnWalletUrl(chain: ChainId, wallet: string): string {
  const slug = GMGN_CHAIN[chain] ?? chain;
  return `https://gmgn.ai/${slug}/address/${wallet}`;
}

export async function promptCtChain(ctx: MyContext): Promise<void> {
  // Clear any previous flow state
  ctx.session.ctFlow = undefined;

  await ctx.reply(
    "🔍 <b>Common Top Traders</b>\n\nWhich chain are the tokens on?",
    {
      parse_mode: "HTML",
      reply_markup: ctChainKeyboard(),
    }
  );
}

export async function handleCtChainSelected(
  ctx: MyContext,
  chain: ChainId
): Promise<void> {
  ctx.session.ctFlow = { step: "awaiting_addresses", chain };

  if (ctx.callbackQuery) await ctx.answerCallbackQuery();

  await ctx.reply(
    `${chainEmoji(chain)} <b>${chainLabel(chain)}</b> selected.\n\n` +
      `Now send me <b>2 to 10 token addresses</b>, one per line.\n\n` +
      `<i>Example:</i>\n<code>0xabc123...\n0xdef456...</code>`,
    { parse_mode: "HTML" }
  );
}

/** Core fetch-and-display logic, shared by both the session flow and direct invocation. */
async function runCommonTraders(
  ctx: MyContext,
  chain: ChainId,
  addresses: string[]
): Promise<void> {
  const loading = await ctx.reply(
    `⏳ Searching for common traders across <b>${addresses.length}</b> tokens on ${chainEmoji(chain)} ${chainLabel(chain)}…\n\n` +
      `<i>This may take a minute.</i>`,
    { parse_mode: "HTML" }
  );

  try {
    const tokens = addresses.map((address) => ({ chain, address }));

    const res = await fetch(`${APP_URL}/api/traders/common`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ ${escapeHtml((err as { error: string }).error ?? "Failed to fetch trader data.")}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const data = (await res.json()) as CommonTradersResponse;
    const { traders, tokensMeta } = data;

    if (traders.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "🤷 No common traders found across these tokens.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const tokenList = tokensMeta
      .map(
        (t) =>
          `  • <b>${escapeHtml(t.symbol)}</b> <code>${escapeHtml(t.address)}</code>`
      )
      .join("\n");

    const titleBase = `${chainEmoji(chain)} <b>Common Top Traders</b> · ${chainLabel(chain)}`;
    const preamble = `<i>Tokens analyzed:</i>\n${tokenList}\n\nFound <b>${traders.length}</b> common trader${traders.length === 1 ? "" : "s"}\n\n`;

    // Build a quick lookup: token address → { priceUsd, marketCap }
    const metaMap = new Map(
      tokensMeta.map((m) => [m.address.toLowerCase(), m])
    );

    // Build one entry string per trader
    const entries: string[] = traders.map((trader, i) => {
      const pnl = formatPnl(trader.totalPnlUsd);
      const pnlEmoji = trader.totalPnlUsd >= 0 ? "📈" : "📉";
      const walletUrl = gmgnWalletUrl(chain, trader.walletAddress);

      let entry = `${i + 1}. <a href="${walletUrl}">${escapeHtml(truncateAddress(trader.walletAddress))}</a>\n`;
      entry += `   ${pnlEmoji} Total PnL: <b>${escapeHtml(pnl)}</b> across ${trader.tokenCount} tokens\n`;

      trader.tokens.slice(0, 3).forEach((t) => {
        const tPnl = formatPnl(t.pnlUsd);
        const tEmoji = t.pnlUsd >= 0 ? "▲" : "▼";
        entry += `   ${tEmoji} ${escapeHtml(t.symbol)}: ${escapeHtml(tPnl)}`;
        if (t.buyCount !== undefined && t.sellCount !== undefined) {
          entry += ` (🟢${t.buyCount}/🔴${t.sellCount})`;
        }
        entry += "\n";

        const meta = metaMap.get(t.address.toLowerCase());
        const currentPrice = meta?.priceUsd ?? 0;
        const currentMc = meta?.marketCap ?? 0;

        // Avg buy / sell MC
        if (t.avgBuyPrice != null && t.avgBuyPrice > 0 && currentPrice > 0 && currentMc > 0) {
          const avgBuyMc = (t.avgBuyPrice / currentPrice) * currentMc;
          entry += `      📊 Buy MC: <b>${escapeHtml(fmtMc(avgBuyMc))}</b>`;
          if (t.avgSellPrice != null && t.avgSellPrice > 0) {
            const avgSellMc = (t.avgSellPrice / currentPrice) * currentMc;
            entry += `  · Sell MC: <b>${escapeHtml(fmtMc(avgSellMc))}</b>`;
          }
          entry += "\n";
        }

        // Total buy / sell amounts
        if (t.boughtUsd != null && t.boughtUsd > 0) {
          entry += `      💸 Bought: <b>${escapeHtml(fmtUsd(t.boughtUsd))}</b>`;
          if (t.soldUsd != null && t.soldUsd > 0) {
            entry += `  · Sold: <b>${escapeHtml(fmtUsd(t.soldUsd))}</b>`;
          }
          entry += "\n";
        }
      });

      entry += "\n";
      return entry;
    });

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
    console.error("[bot/ct]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to find common traders. Please try again."
    );
  }
}

/** Direct invocation: /common addr1 addr2 ... (addresses space- or newline-separated) */
export async function handleCtDirect(
  ctx: MyContext,
  chain: ChainId,
  addresses: string[]
): Promise<void> {
  await runCommonTraders(ctx, chain, addresses);
}

export async function handleCtAddresses(
  ctx: MyContext,
  text: string
): Promise<void> {
  const flow = ctx.session.ctFlow;
  if (!flow || flow.step !== "awaiting_addresses") return;

  const chain = flow.chain;

  const raw = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (raw.length < 2 || raw.length > 10) {
    await ctx.reply(
      `⚠️ Please send between <b>2 and 10</b> addresses (you sent ${raw.length}).`,
      { parse_mode: "HTML" }
    );
    return;
  }

  ctx.session.ctFlow = undefined;
  await runCommonTraders(ctx, chain, raw);
}
