import type { MyContext } from "../bot";
import { aggregateTokenData } from "@/lib/aggregator";
import { getTokenPairs, searchPairs, getTokenOrders } from "@/lib/api/dexscreener";
import { getTokenPools, getOHLCV } from "@/lib/api/geckoterminal";
import { CHAIN_CONFIGS } from "@/config/chains";
import { getChainProvider } from "@/lib/chains/registry";
import { scrapeGmgnTopHolders } from "@/lib/api/gmgn-scraper";
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
  solana: "🟣",
  base: "🔵",
  bsc: "🟡",
};

const GMGN_CHAIN: Record<ChainId, string> = {
  solana: "sol",
  base: "base",
  bsc: "bsc",
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
 * Fetch ATH price + timestamp using GeckoTerminal OHLCV.
 * Works for all chains including Solana — no Birdeye dependency.
 */
async function fetchATH(
  chain: ChainId,
  address: string
): Promise<{ price: number; timestamp: number } | null> {
  const doFetch = async () => {
    const network = CHAIN_CONFIGS[chain].geckoTerminalNetwork;
    const pools = await getTokenPools(network, address);
    const poolAddress = pools[0]?.attributes?.address;
    if (!poolAddress) return null;

    const bars = await getOHLCV(network, poolAddress, "day", 1);
    if (!bars?.length) return null;

    let athPrice = 0, athTs = 0;
    for (const bar of bars) {
      if (bar.high > athPrice) { athPrice = bar.high; athTs = bar.timestamp; }
    }
    return athPrice > 0 ? { price: athPrice, timestamp: athTs } : null;
  };

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), 10_000)
  );
  return Promise.race([doFetch().catch(() => null), timeout]);
}

/**
 * Fetch top 10 holders.
 * Returns { address, percentage }[] — first 5 shown as wallet links, all 10 used for concentration.
 */
async function fetchTopHolders(
  chain: ChainId,
  address: string
): Promise<Array<{ address: string; percentage: number }>> {
  const doFetch = async () => {
    if (chain === "solana") {
      const provider = getChainProvider("solana");
      const holders = await provider.getTopHolders(address, 10);
      return holders
        .filter((h) => h.percentage > 0)
        .slice(0, 10)
        .map((h) => ({ address: h.address, percentage: h.percentage }));
    }

    // EVM — use GMGN scraper (same as /holders command)
    const gmgnHolders = await scrapeGmgnTopHolders(chain, address);
    return gmgnHolders.slice(0, 10).map((h) => {
      const pct =
        h.supplyPercent > 0
          ? h.supplyPercent <= 1
            ? h.supplyPercent * 100
            : h.supplyPercent
          : 0;
      return { address: h.walletAddress, percentage: pct };
    });
  };

  const timeout = new Promise<Array<{ address: string; percentage: number }>>(
    (resolve) => setTimeout(() => resolve([]), 10_000)
  );
  return Promise.race([doFetch().catch(() => []), timeout]);
}

interface DexSocials {
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  discord: string | null;
}

/**
 * Fetch social links directly from DexScreener pair info.
 * More reliable than relying on chain provider metadata.
 */
async function fetchDexSocials(
  chain: ChainId,
  address: string
): Promise<DexSocials> {
  const empty: DexSocials = { twitter: null, telegram: null, website: null, discord: null };
  const doFetch = async (): Promise<DexSocials> => {
    const pairs = await getTokenPairs(chain, address);
    // Find the first pair that has social/website info
    const withInfo = pairs.find(
      (p) => p.info?.socials?.length || p.info?.websites?.length
    );
    if (!withInfo?.info) return empty;

    const socials = withInfo.info.socials ?? [];
    const websites = withInfo.info.websites ?? [];

    return {
      twitter: socials.find((s) => s.type === "twitter")?.url ?? null,
      telegram: socials.find((s) => s.type === "telegram")?.url ?? null,
      discord: socials.find((s) => s.type === "discord")?.url ?? null,
      website: websites[0]?.url ?? null,
    };
  };

  const timeout = new Promise<DexSocials>((resolve) =>
    setTimeout(() => resolve(empty), 8_000)
  );
  return Promise.race([doFetch().catch(() => empty), timeout]);
}

interface DexPaidResult {
  paid: boolean;
  paymentTimestamp: number | null;
}

/**
 * Check if this token has an approved DexScreener profile (DEX Paid).
 * Uses the /orders/v1 endpoint.
 */
async function fetchDexPaid(
  chain: ChainId,
  address: string
): Promise<DexPaidResult> {
  const notPaid: DexPaidResult = { paid: false, paymentTimestamp: null };
  const doFetch = async (): Promise<DexPaidResult> => {
    const result = await getTokenOrders(chain, address);
    if (!result?.orders?.length) return notPaid;

    const profileOrder = result.orders
      .filter((o) => o.type === "tokenProfile" && o.status === "approved")
      .sort((a, b) => (b.paymentTimestamp ?? 0) - (a.paymentTimestamp ?? 0))[0];

    if (!profileOrder) return notPaid;
    return { paid: true, paymentTimestamp: profileOrder.paymentTimestamp ?? null };
  };

  const timeout = new Promise<DexPaidResult>((resolve) =>
    setTimeout(() => resolve(notPaid), 8_000)
  );
  return Promise.race([doFetch().catch(() => notPaid), timeout]);
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

  // aggregateTokenData wrapped in 25s timeout — guards against EVM provider hangs
  const aggregateWithTimeout = Promise.race([
    aggregateTokenData(chain, address),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 25_000)),
  ]);

  const [data, ath, topHolders, dexSocials, dexPaid] = await Promise.all([
    aggregateWithTimeout,
    fetchATH(chain, address),
    fetchTopHolders(chain, address),
    fetchDexSocials(chain, address),
    fetchDexPaid(chain, address),
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

  // ── Price ─────────────────────────────────────────────────────────────────
  msg += `💰 <b>Price</b>\n`;
  msg += `${formatPrice(data.priceUsd)}`;
  const changes: string[] = [];
  if (data.priceChange.h1  !== null) changes.push(`1h ${formatPercent(data.priceChange.h1)}`);
  if (data.priceChange.h24 !== null) changes.push(`24h ${formatPercent(data.priceChange.h24)}`);
  if (changes.length) msg += `  <i>${escapeHtml(changes.join("  ·  "))}</i>`;
  msg += "\n\n";

  // ── Market stats ──────────────────────────────────────────────────────────
  msg += `📊 <b>Market Cap</b>\n`;
  msg += `$${escapeHtml(formatCompact(data.marketCap))}\n\n`;

  msg += `💧 <b>Liquidity</b>  ·  <b>Vol 24h</b>\n`;
  msg += `$${escapeHtml(formatCompact(data.liquidity?.totalUsd ?? null))}`;
  msg += `  ·  $${escapeHtml(formatCompact(data.volume24h))}\n\n`;

  // ── ATH MC ────────────────────────────────────────────────────────────────
  if (ath && data.priceUsd && data.priceUsd > 0 && data.marketCap) {
    const athMc = (ath.price / data.priceUsd) * data.marketCap;
    msg += `📈 <b>ATH MC</b>\n`;
    msg += `$${escapeHtml(formatCompact(athMc))} <i>[${escapeHtml(formatTimeAgo(ath.timestamp))}]</i>\n\n`;
  }

  // ── Activity ──────────────────────────────────────────────────────────────
  if (data.txns24h) {
    const total = data.txns24h.buys + data.txns24h.sells;
    msg += `🔄 <b>Txns 24h</b>  ·  <b>Age</b>\n`;
    msg += `${escapeHtml(formatCompact(total))} (🟢${data.txns24h.buys} 🔴${data.txns24h.sells})`;
    msg += `  ·  ${escapeHtml(formatAge(data.createdAt))}\n\n`;
  } else {
    msg += `🕐 <b>Age</b>\n${escapeHtml(formatAge(data.createdAt))}\n\n`;
  }

  // ── Socials ───────────────────────────────────────────────────────────────
  // Merge aggregator socials with direct DexScreener fetch (DexScreener wins if both present)
  const tw  = dexSocials.twitter  ?? data.twitter  ?? null;
  const tg  = dexSocials.telegram ?? data.telegram ?? null;
  const web = dexSocials.website  ?? data.website  ?? null;
  const dis = dexSocials.discord;

  const socialLinks: string[] = [];
  if (tw)  socialLinks.push(`<a href="${tw}">𝕏 Twitter</a>`);
  if (tg)  socialLinks.push(`<a href="${tg}">💬 Telegram</a>`);
  if (dis) socialLinks.push(`<a href="${dis}">🎮 Discord</a>`);
  if (web) socialLinks.push(`<a href="${web}">🌍 Website</a>`);

  if (socialLinks.length > 0) {
    msg += `\n🌐 <b>Socials</b>\n`;
    msg += socialLinks.join("  ") + "\n";
  }

  // ── Security ──────────────────────────────────────────────────────────────
  msg += `\n🔒 <b>Security</b>\n`;

  // Top 5 wallet links
  const gmgnChain = GMGN_CHAIN[chain];
  const holderLinks = topHolders
    .slice(0, 5)
    .filter((h) => h.percentage > 0)
    .map(
      (h) =>
        `<a href="https://gmgn.ai/${gmgnChain}/address/${h.address}">${h.percentage.toFixed(1)}%</a>`
    )
    .join("  ");
  if (holderLinks) msg += `👥 <b>Top Holders:</b>  ${holderLinks}\n`;

  // Top 10 concentration
  if (topHolders.length > 0) {
    const top10Pct = topHolders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    const concEmoji = top10Pct <= 20 ? "🟢" : top10Pct <= 30 ? "🟡" : "🔴";
    msg += `📊 <b>Top 10%:</b>  ${top10Pct.toFixed(1)}% ${concEmoji}\n`;
  }

  // DEX Paid
  if (dexPaid.paid && dexPaid.paymentTimestamp) {
    const ts = dexPaid.paymentTimestamp > 1e12
      ? dexPaid.paymentTimestamp
      : dexPaid.paymentTimestamp * 1000;
    msg += `🏷️ <b>DEX Paid:</b>  ✅ ${escapeHtml(formatTimeAgo(ts))}\n`;
  } else {
    msg += `🏷️ <b>DEX Paid:</b>  ❌\n`;
  }

  // ── DD Score ──────────────────────────────────────────────────────────────
  if (dd) {
    msg += `\n${GRADE_EMOJI[dd.grade] ?? "⚪"} <b>DD Score:</b> ${dd.overall}/100 — Grade <b>${dd.grade}</b>\n`;
  }

  // ── Warnings ──────────────────────────────────────────────────────────────
  if (warns.length > 0) {
    msg += `⚠️ <b>Warnings</b>\n`;
    warns.slice(0, 3).forEach((f) => { msg += `• ${escapeHtml(f.label)}\n`; });
  }

  // ── Trading links ─────────────────────────────────────────────────────────
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

  await ctx.api.editMessageText(ctx.chat!.id, msgId, msg, {
    parse_mode: "HTML",
    reply_markup: tokenKeyboard(chain, address),
    link_preview_options: { is_disabled: true },
  });
}
