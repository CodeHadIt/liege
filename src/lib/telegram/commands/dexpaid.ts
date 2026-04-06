import type { MyContext } from "../bot";
import { getDexProfiles } from "@/lib/api/dex-orders-cache";
import {
  escapeHtml,
  formatCompact,
  formatPrice,
  formatAge,
} from "../utils/format";
import { dexPaidPeriodKeyboard } from "../utils/keyboards";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://liege.up.railway.app";

type Period = "30m" | "1h" | "2h" | "4h" | "8h";
const VALID_PERIODS: Period[] = ["30m", "1h", "2h", "4h", "8h"];

export async function promptDexPaidPeriod(ctx: MyContext): Promise<void> {
  await ctx.reply(
    "📋 <b>DEX Paid Profiles</b>\n\nSelect a time window to view tokens that have paid for a DexScreener profile:",
    {
      parse_mode: "HTML",
      reply_markup: dexPaidPeriodKeyboard(),
    }
  );
}

export async function handleDexPaid(
  ctx: MyContext,
  period: string
): Promise<void> {
  if (!VALID_PERIODS.includes(period as Period)) {
    await ctx.reply("❌ Invalid period. Use: 30m, 1h, 2h, 4h, 8h");
    return;
  }

  // Acknowledge the callback query so Telegram stops showing the spinner
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();

  const loading = await ctx.reply(
    `🔍 Fetching DEX Paid profiles for the last <b>${period}</b>…`,
    { parse_mode: "HTML" }
  );

  try {
    const tokens = await getDexProfiles(period as Period);

    if (tokens.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `⚠️ No DEX Paid profiles found in the last <b>${period}</b>.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Display first 15 tokens — Telegram message limit
    const display = tokens.slice(0, 15);

    let msg = `🏷️ <b>DEX Paid Profiles — Last ${period}</b>\n`;
    msg += `<i>${tokens.length} token${tokens.length === 1 ? "" : "s"} found</i>\n\n`;

    display.forEach((t, i) => {
      const name = escapeHtml(t.symbol || t.name || t.address.slice(0, 8));
      const price = formatPrice(t.priceUsd);
      const fdv = t.fdv ? `$${escapeHtml(formatCompact(t.fdv))}` : "—";
      const liq = t.liquidity
        ? `$${escapeHtml(formatCompact(t.liquidity))}`
        : "—";
      const age = formatAge(
        t.createdAt ? new Date(t.createdAt).getTime() : null
      );
      const analyzeUrl = `${APP_URL}/token/solana/${t.address}`;

      msg += `${i + 1}. <b>${name}</b>\n`;
      msg += `   Price: ${price} · FDV: ${fdv} · Liq: ${liq} · Age: ${age}\n`;
      msg += `   <a href="${analyzeUrl}">Analyze →</a> | <code>${escapeHtml(t.address.slice(0, 16))}…</code>\n\n`;
    });

    if (tokens.length > 15) {
      msg += `<i>…and ${tokens.length - 15} more. <a href="${APP_URL}/dex-orders">View all on Liège →</a></i>`;
    }

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("[bot/dexpaid]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to fetch DEX Paid data. Please try again."
    );
  }
}
