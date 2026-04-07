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
 * Uses DexScreener search (cross-chain) first, then direct queries as fallback.
 */
export async function detectEvmChain(address: string): Promise<ChainId> {
  try {
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
  } catch { /* fall through */ }

  try {
    const [basePairs, bscPairs] = await Promise.all([
      getTokenPairs("base", address).catch(() => []),
      getTokenPairs("bsc",  address).catch(() => []),
    ]);
    const baseLiq = basePairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
    const bscLiq  = bscPairs.reduce( (s, p) => s + (p.liquidity?.usd ?? 0), 0);
    if (bscLiq > 0 || baseLiq > 0) return bscLiq > baseLiq ? "bsc" : "base";
  } catch { /* ignore */ }

  return "base";
}

/**
 * Fetch ATH price + timestamp from daily OHLCV with a hard 8s timeout.
 * The timeout prevents Solana/Birdeye hangs from stalling the whole command.
 */
async function fetchATH(
  chain: ChainId,
  address: string
): Promise<{ price: number; timestamp: number } | null> {
  const fetch = async () => {
    const bars = await getChainProvider(chain).getPriceHistory(address, "1d");
    if (!bars?.length) return null;
    let athPrice = 0, athTs = 0;
    for (const bar of bars) {
      if (bar.high > athPrice) { athPrice = bar.high; athTs = bar.timestamp; }
    }
    return athPrice > 0 ? { price: athPrice, timestamp: athTs } : null;
  };

  // Hard 8-second timeout — if the underlying API hangs, we skip ATH gracefully
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), 8_000)
  );

  return Promise.race([fetch().catch(() => null), timeout]);
}

/** Build trading platform URLs matching the Liège web app */
function tradingLinks(chain: ChainId, address: string, dexUrl?: string | null) {
  const gmgnChain: Record<ChainId, string> = { solana: "sol", base: "base", bsc: "bsc" };
  const axiomChain: Record<ChainId, string> = { solana: "sol", base: "base", bsc: "bsc" };
  const terminalChain: Record<ChainId, string> = { solana: "solana", base: "base", bsc: "bsc" };

  return {
    axi: `https://axiom.trade/t/${address}/@genes?chain=${axiomChain[chain]}`,
    tro: `https://trojan.com/terminal?token=${address}&ref=garriwenes`,
    tem: `https://trade.padre.gg/trade/${terminalChain[chain]}/${address}?rk=warri`,
    dex: dexUrl ?? `https://dexscreener.com/${chain}/${address}`,
    gmg: `https://gmgn.ai/${gmgnChain[chain]}/token/${address}`,
  };
}

/**
 * Build and send (or refresh in-place) the full token analysis message.
 * Pass `editMsgId` to update an existing message (refresh callback).
 */
export async function handleToken(
  ctx: MyContext,
  chain: ChainId,
  address: string,
  editMsgId?: number
): Promise<void> {
  let msgId: number;
  if (editMsgId !== undefined) {
    msgId = editMsgId;
    await ctx.api.editMessageText(ctx.chat!.id, msgId, "🔄 Refreshing…");
  } else {
    const loading = await ctx.reply("🔍 Analyzing token…");
    msgId = loading.message_id;
  }

  // ATH runs with a hard timeout so a slow/missing Birdeye key never hangs Solana
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

  // ── ATH MC ────────────────────────────────────────────────────────────────
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

  // ── Warnings only (criticals removed) ────────────────────────────────────
  if (warns.length > 0) {
    msg += `\n⚠️ <b>Warnings:</b>\n`;
    warns.slice(0, 3).forEach((f) => { msg += `  • ${escapeHtml(f.label)}\n`; });
  }

  // ── Trading links (inline hyperlinks in message body) ────────────────────
  const t = tradingLinks(chain, address, data.primaryPair
    ? `https://dexscreener.com/${chain}/${data.primaryPair.pairAddress}`
    : null
  );
  msg += `\n`;
  msg += `<a href="${t.axi}">AXI</a>  `;
  msg += `<a href="${t.tro}">TRO</a>  `;
  msg += `<a href="${t.tem}">TEM</a>  `;
  msg += `<a href="${t.dex}">DEX</a>  `;
  msg += `<a href="${t.gmg}">GMG</a>\n`;

  // ── Social links ──────────────────────────────────────────────────────────
  const socials: string[] = [];
  if (data.twitter)  socials.push(`<a href="${data.twitter}">𝕏</a>`);
  if (data.telegram) socials.push(`<a href="${data.telegram}">TG</a>`);
  if (data.website)  socials.push(`<a href="${data.website}">WEB</a>`);
  if (socials.length > 0) msg += `${socials.join("  ")}\n`;

  await ctx.api.editMessageText(ctx.chat!.id, msgId, msg, {
    parse_mode: "HTML",
    reply_markup: tokenKeyboard(chain, address),
    link_preview_options: { is_disabled: true },
  });
}
