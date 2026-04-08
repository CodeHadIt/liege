import type { MyContext } from "../bot";
import { getTokenOrders, getTokenPairs } from "@/lib/api/dexscreener";
import type { DexScreenerPair } from "@/lib/api/dexscreener";
import { detectChainFromAddress } from "@/lib/chains/registry";
import { detectEvmChain } from "./token";
import { escapeHtml, formatTimeAgo } from "../utils/format";
import type { ChainId } from "@/types/chain";

const ORDER_LABELS: Record<string, string> = {
  tokenProfile:       "Token Profile",
  communityTakeover:  "Community Takeover",
  tokenAd:            "Token Ad",
};

export async function handleDp(ctx: MyContext, address: string): Promise<void> {
  const loading = await ctx.reply("🔍 Checking DexScreener orders…");
  const chatId  = ctx.chat!.id;

  try {
    const rawChain = detectChainFromAddress(address);
    if (!rawChain) {
      await ctx.api.editMessageText(
        chatId, loading.message_id,
        "❌ Could not detect chain from this address."
      );
      return;
    }

    const chain: ChainId =
      rawChain === "base" ? await detectEvmChain(address) : rawChain;

    const [ordersResult, pairs] = await Promise.all([
      Promise.race([
        getTokenOrders(chain, address).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
      ]),
      Promise.race([
        getTokenPairs(chain, address).catch((): DexScreenerPair[] => []),
        new Promise<DexScreenerPair[]>((r) => setTimeout(() => r([]), 8_000)),
      ]),
    ]);

    // Resolve banner from highest-liquidity pair
    const sorted    = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const primary   = sorted[0];
    const bannerUrl = primary?.info?.header ?? primary?.info?.imageUrl ?? null;
    const tokenName = primary?.baseToken?.name ?? primary?.baseToken?.symbol ?? null;

    // ── Build message ───────────────────────────────────────────────────────

    let msg = `🏷️ <b>Dex Orders</b>\n`;
    if (tokenName) msg += `<b>${escapeHtml(tokenName)}</b>\n`;

    if (!ordersResult?.orders?.length) {
      msg += `\n❌ No orders found — token has not paid for any DexScreener placement.`;
    } else {
      const approved = ordersResult.orders.filter((o) => o.status === "approved");
      const pending  = ordersResult.orders.filter((o) => o.status !== "approved");

      if (approved.length > 0) {
        msg += `\n<b>✅ Approved</b>\n`;
        const rows = approved.map((o) => {
          const label = ORDER_LABELS[o.type] ?? o.type;
          const ts    = o.paymentTimestamp
            ? (o.paymentTimestamp > 1e12 ? o.paymentTimestamp : o.paymentTimestamp * 1000)
            : null;
          const when  = ts ? escapeHtml(formatTimeAgo(ts)) : "unknown";
          return `${escapeHtml(label)}: paid <i>${when}</i>`;
        });
        rows.forEach((row, i) => {
          msg += `${i === rows.length - 1 ? "└" : "├"} ${row}\n`;
        });
      } else {
        msg += `\n❌ No approved placements found.`;
      }

      if (pending.length > 0) {
        msg += `\n<b>⏳ Pending</b>\n`;
        const rows = pending.map((o) => {
          const label = ORDER_LABELS[o.type] ?? o.type;
          return `${escapeHtml(label)} (${escapeHtml(o.status)})`;
        });
        rows.forEach((row, i) => {
          msg += `${i === rows.length - 1 ? "└" : "├"} ${row}\n`;
        });
      }
    }

    // ── Send ────────────────────────────────────────────────────────────────

    if (bannerUrl) {
      await ctx.api.deleteMessage(chatId, loading.message_id).catch(() => null);
      await ctx.api.sendPhoto(chatId, bannerUrl, { caption: msg, parse_mode: "HTML" });
    } else {
      await ctx.api.editMessageText(chatId, loading.message_id, msg, { parse_mode: "HTML" });
    }
  } catch (err) {
    console.error("[bot/dp]", err);
    await ctx.api.editMessageText(
      chatId, loading.message_id,
      "❌ Failed to check DexScreener orders. Please try again."
    ).catch(() => null);
  }
}
