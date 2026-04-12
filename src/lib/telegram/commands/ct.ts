import type { MyContext } from "../bot";
import { ctChainKeyboard } from "../utils/keyboards";
import {
  escapeHtml,
  formatPnl,
  truncateAddress,
  chainEmoji,
  chainLabel,
} from "../utils/format";
import type { ChainId } from "@/types/chain";
import type { CommonTradersResponse } from "@/types/traders";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://liege.up.railway.app";

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
      `<i>This may take up to 60 seconds.</i>`,
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
          `  • <b>${escapeHtml(t.symbol)}</b> <code>${escapeHtml(truncateAddress(t.address))}</code>`
      )
      .join("\n");

    let msg = `${chainEmoji(chain)} <b>Common Top Traders</b> · ${chainLabel(chain)}\n`;
    msg += `<i>Tokens analyzed:</i>\n${tokenList}\n\n`;
    msg += `Found <b>${traders.length}</b> common trader${traders.length === 1 ? "" : "s"}\n\n`;

    traders.slice(0, 10).forEach((trader, i) => {
      const pnl = formatPnl(trader.totalPnlUsd);
      const pnlEmoji = trader.totalPnlUsd >= 0 ? "📈" : "📉";
      const walletUrl = `${APP_URL}/wallet/${chain}/${trader.walletAddress}`;

      msg += `${i + 1}. <a href="${walletUrl}">${escapeHtml(truncateAddress(trader.walletAddress))}</a>\n`;
      msg += `   ${pnlEmoji} Total PnL: <b>${escapeHtml(pnl)}</b> across ${trader.tokenCount} tokens\n`;

      trader.tokens.slice(0, 3).forEach((t) => {
        const tPnl = formatPnl(t.pnlUsd);
        const tEmoji = t.pnlUsd >= 0 ? "▲" : "▼";
        msg += `   ${tEmoji} ${escapeHtml(t.symbol)}: ${escapeHtml(tPnl)}`;
        if (t.buyCount !== undefined && t.sellCount !== undefined) {
          msg += ` (${t.buyCount}B/${t.sellCount}S)`;
        }
        msg += "\n";
      });

      msg += "\n";
    });

    if (traders.length > 10) {
      msg += `<i>…and ${traders.length - 10} more.</i>`;
    }

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
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
