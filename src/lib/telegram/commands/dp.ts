import type { MyContext } from "../bot";
import { getTokenOrders } from "@/lib/api/dexscreener";
import { detectChainFromAddress } from "@/lib/chains/registry";
import { detectEvmChain } from "./token";
import { escapeHtml, formatTimeAgo } from "../utils/format";
import type { ChainId } from "@/types/chain";

const ORDER_LABELS: Record<string, string> = {
  tokenProfile: "Token Profile",
  communityTakeover: "Community Takeover",
  tokenAd: "Token Ad",
};

export async function handleDp(ctx: MyContext, address: string): Promise<void> {
  const loading = await ctx.reply("🔍 Checking DexScreener orders…");

  try {
    const rawChain = detectChainFromAddress(address);
    if (!rawChain) {
      await ctx.api.editMessageText(
        ctx.chat!.id, loading.message_id,
        "❌ Could not detect chain from this address."
      );
      return;
    }

    const chain: ChainId =
      rawChain === "base" ? await detectEvmChain(address) : rawChain;

    const result = await Promise.race([
      getTokenOrders(chain, address),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);

    if (!result || !result.orders?.length) {
      await ctx.api.editMessageText(
        ctx.chat!.id, loading.message_id,
        `🏷️ <b>DexScreener Orders</b>\n<code>${escapeHtml(address)}</code>\n\n❌ No orders found — token has not paid for any DexScreener placement.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const approved = result.orders.filter((o) => o.status === "approved");
    const pending  = result.orders.filter((o) => o.status !== "approved");

    let msg = `🏷️ <b>DexScreener Orders</b>\n`;
    msg += `<code>${escapeHtml(address)}</code>\n\n`;

    if (approved.length > 0) {
      msg += `<b>✅ Approved</b>\n`;
      for (const o of approved) {
        const label = ORDER_LABELS[o.type] ?? o.type;
        const ts    = o.paymentTimestamp
          ? (o.paymentTimestamp > 1e12 ? o.paymentTimestamp : o.paymentTimestamp * 1000)
          : null;
        const when = ts ? escapeHtml(formatTimeAgo(ts)) : "unknown";
        msg += `├ ${escapeHtml(label)}: paid <i>${when}</i>\n`;
      }
    }

    if (pending.length > 0) {
      msg += `\n<b>⏳ Pending</b>\n`;
      for (const o of pending) {
        const label = ORDER_LABELS[o.type] ?? o.type;
        msg += `├ ${escapeHtml(label)} (${escapeHtml(o.status)})\n`;
      }
    }

    if (approved.length === 0) {
      msg += `❌ No approved placements found.`;
    }

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("[bot/dp]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id, loading.message_id,
      "❌ Failed to check DexScreener orders. Please try again."
    );
  }
}
