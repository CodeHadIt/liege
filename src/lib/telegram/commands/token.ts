import type { MyContext } from "../bot";
import { aggregateTokenData } from "@/lib/aggregator";
import { getChainProvider } from "@/lib/chains/registry";
import { getTokenPairs, searchPairs } from "@/lib/api/dexscreener";
import {
  escapeHtml,
  formatPrice,
  formatCompact,
  formatPercent,
  formatAge,
  formatTimeAgo,
  chainLabel,
} from "../utils/format";
import { tokenKeyboard } from "../utils/keyboards";
import type { ChainId } from "@/types/chain";

const GRADE_EMOJI: Record<string, string> = {
  A: "🟢", B: "🟡", C: "🟠", D: "🔴", F: "⚫",
};

const CHAIN_LOGO: Record<ChainId, string> = {
  solana: "◎",
  base: "🔵",
  bsc: "🟡",
};

/**
 * Auto-detect whether a 0x address lives on Base or BSC.
 *
 * Strategy (most-to-least reliable):
 * 1. DexScreener search — returns pairs across all chains, we filter to base/bsc
 *    and pick whichever has higher total liquidity.
 * 2. Direct per-chain getTokenPairs queries as a fallback.
 * Falls back to "base" if nothing is found on either chain.
 */
export async function detectEvmChain(address: string): Promise<ChainId> {
  try {
    // Try search first — it's one call and covers all chains
    const results = await searchPairs(address).catch(() => []);
    const evmPairs = results.filter((p) => {
      const c = p.chainId?.toLowerCase();
      return c === "base" || c === "bsc";
    });

    if (evmPairs.length > 0) {
      const liq: Record<string, number> = { base: 0, bsc: 0 };
      for (const p of evmPairs) {
        const c = p.chainId?.toLowerCase() as "base" | "bsc";
        liq[c] = (liq[c] ?? 0) + (p.liquidity?.usd ?? 0);
      }
      return liq.bsc > liq.base ? "bsc" : "base";
    }
  } catch {
    // fall through to direct queries
  }

  // Fallback: query each chain directly in parallel
  try {
    const [basePairs, bscPairs] = await Promise.all([
      getTokenPairs("base", address).catch(() => []),
      getTokenPairs("bsc",  address).catch(() => []),
    ]);
    const baseLiq = basePairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
    const bscLiq  = bscPairs.reduce( (s, p) => s + (p.liquidity?.usd ?? 0), 0);
    if (bscLiq > 0 || baseLiq > 0) return bscLiq > baseLiq ? "bsc" : "base";
  } catch {
    // ignore
  }

  return "base"; // last resort default
}

/** Fetch the all-time high price + its timestamp from daily OHLCV history */
async function fetchATH(
  chain: ChainId,
  address: string
): Promise<{ price: number; timestamp: number } | null> {
  try {
    const bars = await getChainProvider(chain).getPriceHistory(address, "1d");
    if (!bars?.length) return null;
    let athPrice = 0, athTs = 0;
    for (const bar of bars) {
      if (bar.high > athPrice) { athPrice = bar.high; athTs = bar.timestamp; }
    }
    return athPrice > 0 ? { price: athPrice, timestamp: athTs } : null;
  } catch {
    return null;
  }
}

/**
 * Build the token analysis message and send it.
 * - Pass `editMsgId` to update an existing message (used by refresh callback).
 * - Without it a fresh "Analyzing…" loading message is sent first, then edited.
 */
export async function handleToken(
  ctx: MyContext,
  chain: ChainId,
  address: string,
  editMsgId?: number
): Promise<void> {
  // Determine the message we'll be editing
  let msgId: number;
  if (editMsgId !== undefined) {
    msgId = editMsgId;
    await ctx.api.editMessageText(ctx.chat!.id, msgId, "🔄 Refreshing…");
  } else {
    const loading = await ctx.reply("🔍 Analyzing token…");
    msgId = loading.message_id;
  }

  // Fetch token data and ATH in parallel
  const [data, ath] = await Promise.all([
    aggregateTokenData(chain, address),
    fetchATH(chain, address),
  ]);

  if (!data) {
    await ctx.api.editMessageText(
      ctx.chat!.id, msgId,
      "❌ Token not found. Check the address and chain."
    );
    return;
  }

  const dd    = data.ddScore;
  const flags = data.safetySignals?.flags ?? [];
  const crits = flags.filter((f) => f.severity === "critical");
  const warns = flags.filter((f) => f.severity === "warning");

  // ── Header ────────────────────────────────────────────────────────────────
  let msg = `${CHAIN_LOGO[chain]} <b>${escapeHtml(data.name)}</b>`;
  msg += ` <code>(${escapeHtml(data.symbol)})</code> · ${chainLabel(chain)}\n`;
  msg += `<code>${escapeHtml(address)}</code>\n\n`;

  // ── Price + changes ───────────────────────────────────────────────────────
  msg += `💰 <b>${formatPrice(data.priceUsd)}</b>`;
  const changes: string[] = [];
  if (data.priceChange.h1  !== null) changes.push(`1h ${formatPercent(data.priceChange.h1)}`);
  if (data.priceChange.h24 !== null) changes.push(`24h ${formatPercent(data.priceChange.h24)}`);
  if (changes.length) msg += `  <i>${escapeHtml(changes.join("  ·  "))}</i>`;
  msg += "\n";

  // ── Stats ─────────────────────────────────────────────────────────────────
  msg += `📊 MC: <b>$${escapeHtml(formatCompact(data.marketCap))}</b>\n`;
  msg += `💧 LP: <b>$${escapeHtml(formatCompact(data.liquidity?.totalUsd ?? null))}</b>`;
  msg += `  |  Vol: <b>$${escapeHtml(formatCompact(data.volume24h))}</b>\n`;

  // ── ATH (in market cap terms) ─────────────────────────────────────────────
  if (ath && data.priceUsd && data.priceUsd > 0 && data.marketCap) {
    const athMc = (ath.price / data.priceUsd) * data.marketCap;
    msg += `📈 ATH MC: <b>$${escapeHtml(formatCompact(athMc))}</b>`;
    msg += ` [${escapeHtml(formatTimeAgo(ath.timestamp))}]\n`;
  }

  // ── Activity ──────────────────────────────────────────────────────────────
  if (data.txns24h) {
    msg += `🔄 Txns: ${data.txns24h.buys + data.txns24h.sells}`;
    msg += ` (${data.txns24h.buys}B / ${data.txns24h.sells}S)\n`;
  }
  msg += `🕐 Age: ${escapeHtml(formatAge(data.createdAt))}\n`;

  // ── DD Score ──────────────────────────────────────────────────────────────
  if (dd) {
    msg += `\n${GRADE_EMOJI[dd.grade] ?? "⚪"} DD Score: <b>${dd.overall}/100</b> — Grade <b>${dd.grade}</b>\n`;
  }

  // ── Safety flags ──────────────────────────────────────────────────────────
  if (crits.length > 0) {
    msg += `\n🚨 <b>Critical:</b>\n`;
    crits.slice(0, 3).forEach((f) => { msg += `  • ${escapeHtml(f.label)}\n`; });
  }
  if (warns.length > 0) {
    msg += `⚠️ <b>Warnings:</b>\n`;
    warns.slice(0, 3).forEach((f) => { msg += `  • ${escapeHtml(f.label)}\n`; });
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const dexUrl = data.primaryPair
    ? `https://dexscreener.com/${chain}/${data.primaryPair.pairAddress}`
    : null;

  await ctx.api.editMessageText(ctx.chat!.id, msgId, msg, {
    parse_mode: "HTML",
    reply_markup: tokenKeyboard(chain, address, {
      dexUrl,
      twitter:  data.twitter,
      telegram: data.telegram,
      website:  data.website,
    }),
    link_preview_options: { is_disabled: true },
  });
}
