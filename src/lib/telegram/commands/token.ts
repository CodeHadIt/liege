import type { MyContext } from "../bot";
import { aggregateTokenData } from "@/lib/aggregator";
import {
  escapeHtml,
  formatPrice,
  formatCompact,
  formatPercent,
  formatAge,
  chainEmoji,
  chainLabel,
} from "../utils/format";
import { viewOnSiteKeyboard } from "../utils/keyboards";
import type { ChainId } from "@/types/chain";

const GRADE_EMOJI: Record<string, string> = {
  A: "🟢",
  B: "🟡",
  C: "🟠",
  D: "🔴",
  F: "⚫",
};

export async function handleToken(
  ctx: MyContext,
  chain: ChainId,
  address: string
): Promise<void> {
  const loading = await ctx.reply("🔍 Analyzing token…");

  try {
    const data = await aggregateTokenData(chain, address);

    if (!data) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        "❌ Token not found. Check the address and chain."
      );
      return;
    }

    const dd = data.ddScore;
    const flags = data.safetySignals?.flags ?? [];
    const criticals = flags.filter((f) => f.severity === "critical");
    const warnings = flags.filter((f) => f.severity === "warning");

    let msg = `${chainEmoji(chain)} <b>${escapeHtml(data.name)}</b> (${escapeHtml(data.symbol)}) · ${chainLabel(chain)}\n`;
    msg += `<code>${escapeHtml(address)}</code>\n\n`;

    msg += `💰 <b>Price:</b> ${formatPrice(data.priceUsd)}\n`;
    if (data.priceChange.h1 !== null)
      msg += `   1h: ${formatPercent(data.priceChange.h1)}`;
    if (data.priceChange.h24 !== null)
      msg += `  24h: ${formatPercent(data.priceChange.h24)}`;
    if (data.priceChange.h1 !== null || data.priceChange.h24 !== null)
      msg += "\n";

    msg += `📊 <b>Market Cap:</b> $${escapeHtml(formatCompact(data.marketCap))}\n`;
    msg += `💎 <b>FDV:</b> $${escapeHtml(formatCompact(data.fdv))}\n`;
    msg += `💧 <b>Liquidity:</b> $${escapeHtml(formatCompact(data.liquidity?.totalUsd ?? null))}\n`;
    msg += `📦 <b>Volume 24h:</b> $${escapeHtml(formatCompact(data.volume24h))}\n`;

    if (data.txns24h) {
      msg += `🔄 <b>Txns 24h:</b> ${data.txns24h.buys + data.txns24h.sells}`;
      msg += ` (${data.txns24h.buys}B / ${data.txns24h.sells}S)\n`;
    }

    msg += `🕐 <b>Age:</b> ${escapeHtml(formatAge(data.createdAt))}\n`;

    if (dd) {
      const emoji = GRADE_EMOJI[dd.grade] ?? "⚪";
      msg += `\n${emoji} <b>DD Score:</b> ${dd.overall}/100 — Grade <b>${dd.grade}</b>\n`;
    }

    if (criticals.length > 0) {
      msg += `\n🚨 <b>Critical flags:</b>\n`;
      criticals.slice(0, 3).forEach((f) => {
        msg += `  • ${escapeHtml(f.label)}\n`;
      });
    }

    if (warnings.length > 0) {
      msg += `\n⚠️ <b>Warnings:</b>\n`;
      warnings.slice(0, 3).forEach((f) => {
        msg += `  • ${escapeHtml(f.label)}\n`;
      });
    }

    // Socials
    const links: string[] = [];
    if (data.twitter) links.push(`<a href="${data.twitter}">Twitter</a>`);
    if (data.telegram) links.push(`<a href="${data.telegram}">Telegram</a>`);
    if (data.website) links.push(`<a href="${data.website}">Website</a>`);
    if (links.length > 0) msg += `\n🔗 ${links.join(" · ")}\n`;

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
      parse_mode: "HTML",
      reply_markup: viewOnSiteKeyboard(chain, address),
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("[bot/token]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to fetch token data. Please try again."
    );
  }
}
