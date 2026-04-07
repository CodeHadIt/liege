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

// ── Chain detection ───────────────────────────────────────────────────────────

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

// ── ATH (GeckoTerminal) ───────────────────────────────────────────────────────

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

  return Promise.race([
    doFetch().catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
  ]);
}

// ── Top holders ───────────────────────────────────────────────────────────────

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
    const gmgnHolders = await scrapeGmgnTopHolders(chain, address);
    return gmgnHolders.slice(0, 10).map((h) => {
      const pct =
        h.supplyPercent > 0
          ? h.supplyPercent <= 1 ? h.supplyPercent * 100 : h.supplyPercent
          : 0;
      return { address: h.walletAddress, percentage: pct };
    });
  };

  return Promise.race([
    doFetch().catch(() => []),
    new Promise<Array<{ address: string; percentage: number }>>((r) =>
      setTimeout(() => r([]), 10_000)
    ),
  ]);
}

// ── DexScreener token info (name + socials) ───────────────────────────────────

interface TokenInfo {
  /** Proper full name from DexScreener (not just symbol) */
  name: string | null;
  twitter:  string | null;
  telegram: string | null;
  discord:  string | null;
  website:  string | null;
}

async function fetchTokenInfo(chain: ChainId, address: string): Promise<TokenInfo> {
  const empty: TokenInfo = { name: null, twitter: null, telegram: null, discord: null, website: null };
  const doFetch = async (): Promise<TokenInfo> => {
    const pairs = await getTokenPairs(chain, address);
    if (!pairs.length) return empty;

    // Best pair by liquidity for accurate name
    const sorted  = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const primary  = sorted[0];
    const withInfo = sorted.find((p) => p.info?.socials?.length || p.info?.websites?.length);

    const socials  = withInfo?.info?.socials  ?? [];
    const websites = withInfo?.info?.websites ?? [];

    return {
      name:     primary.baseToken.name ?? null,
      twitter:  socials.find((s) => s.type === "twitter")?.url  ?? null,
      telegram: socials.find((s) => s.type === "telegram")?.url ?? null,
      discord:  socials.find((s) => s.type === "discord")?.url  ?? null,
      website:  websites[0]?.url ?? null,
    };
  };

  return Promise.race([
    doFetch().catch(() => empty),
    new Promise<TokenInfo>((r) => setTimeout(() => r(empty), 8_000)),
  ]);
}

// ── DEX Paid (DexScreener /orders/v1) ────────────────────────────────────────

interface DexPaidResult {
  paid: boolean;
  paymentTimestamp: number | null;
}

async function fetchDexPaid(chain: ChainId, address: string): Promise<DexPaidResult> {
  const notPaid: DexPaidResult = { paid: false, paymentTimestamp: null };
  const doFetch = async (): Promise<DexPaidResult> => {
    const result = await getTokenOrders(chain, address);
    if (!result?.orders?.length) return notPaid;

    const order = result.orders
      .filter((o) => o.type === "tokenProfile" && o.status === "approved")
      .sort((a, b) => (b.paymentTimestamp ?? 0) - (a.paymentTimestamp ?? 0))[0];

    if (!order) return notPaid;
    return { paid: true, paymentTimestamp: order.paymentTimestamp ?? null };
  };

  return Promise.race([
    doFetch().catch(() => notPaid),
    new Promise<DexPaidResult>((r) => setTimeout(() => r(notPaid), 8_000)),
  ]);
}

// ── Trading links ─────────────────────────────────────────────────────────────

function tradingLinks(chain: ChainId, address: string, dexUrl?: string | null) {
  const gmgnChain:     Record<ChainId, string> = { solana: "sol",    base: "base", bsc: "bsc" };
  const axiomChain:    Record<ChainId, string> = { solana: "sol",    base: "base", bsc: "bsc" };
  const terminalChain: Record<ChainId, string> = { solana: "solana", base: "base", bsc: "bsc" };

  return {
    axi: `https://axiom.trade/t/${address}/@genes?chain=${axiomChain[chain]}`,
    tro: `https://trojan.com/terminal?token=${address}&ref=garriwenes`,
    tem: `https://trade.padre.gg/trade/${terminalChain[chain]}/${address}?rk=warri`,
    dex: dexUrl ?? `https://dexscreener.com/${chain}/${address}`,
    gmg: `https://gmgn.ai/${gmgnChain[chain]}/token/${address}`,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

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

  // 25s guard on aggregateTokenData — EVM provider can hang without API keys
  const aggregateWithTimeout = Promise.race([
    aggregateTokenData(chain, address),
    new Promise<null>((r) => setTimeout(() => r(null), 25_000)),
  ]);

  const [data, ath, topHolders, tokenInfo, dexPaid] = await Promise.all([
    aggregateWithTimeout,
    fetchATH(chain, address),
    fetchTopHolders(chain, address),
    fetchTokenInfo(chain, address),
    fetchDexPaid(chain, address),
  ]);

  if (!data) {
    await ctx.api.editMessageText(
      ctx.chat!.id, msgId,
      "❌ Token not found. Check the address and chain."
    );
    return;
  }

  // DexScreener gives the proper full name; aggregator may only have the symbol
  const displayName = tokenInfo.name ?? data.name;

  const dd    = data.ddScore;
  const flags = data.safetySignals?.flags ?? [];
  const warns = flags.filter((f) => f.severity === "warning");

  // ── Header ────────────────────────────────────────────────────────────────
  let msg = `${CHAIN_LOGO[chain]} <b>${escapeHtml(displayName)}</b>`;
  msg += ` <code>(${escapeHtml(data.symbol)})</code> · ${chainLabel(chain)}\n`;
  msg += `<code>${escapeHtml(address)}</code>\n`;

  // ── Stats section ─────────────────────────────────────────────────────────
  msg += `\n<b>📊 Stats</b>\n`;

  msg += `💰 Price: <b>${formatPrice(data.priceUsd)}</b>`;
  const changes: string[] = [];
  if (data.priceChange.h1  !== null) changes.push(`1h ${formatPercent(data.priceChange.h1)}`);
  if (data.priceChange.h24 !== null) changes.push(`24h ${formatPercent(data.priceChange.h24)}`);
  if (changes.length) msg += `  <i>(${escapeHtml(changes.join(" · "))})</i>`;
  msg += "\n";

  msg += `📈 MC: <b>$${escapeHtml(formatCompact(data.marketCap))}</b>\n`;
  msg += `💧 Liq: <b>$${escapeHtml(formatCompact(data.liquidity?.totalUsd ?? null))}</b>`;
  msg += `  ·  Vol: <b>$${escapeHtml(formatCompact(data.volume24h))}</b>\n`;

  if (ath && data.priceUsd && data.priceUsd > 0 && data.marketCap) {
    const athMc = (ath.price / data.priceUsd) * data.marketCap;
    msg += `🏆 ATH MC: <b>$${escapeHtml(formatCompact(athMc))}</b>`;
    msg += ` <i>(${escapeHtml(formatTimeAgo(ath.timestamp))})</i>\n`;
  }

  if (data.txns24h) {
    const total = data.txns24h.buys + data.txns24h.sells;
    msg += `🔄 Txns: <b>${escapeHtml(formatCompact(total))}</b>`;
    msg += ` (🟢${escapeHtml(formatCompact(data.txns24h.buys))} 🔴${escapeHtml(formatCompact(data.txns24h.sells))})\n`;
  }

  msg += `🕐 Age: <b>${escapeHtml(formatAge(data.createdAt))}</b>\n`;

  // ── Socials section ───────────────────────────────────────────────────────
  const tw  = tokenInfo.twitter  ?? data.twitter  ?? null;
  const tg  = tokenInfo.telegram ?? data.telegram ?? null;
  const web = tokenInfo.website  ?? data.website  ?? null;
  const dis = tokenInfo.discord;

  const socialLinks: string[] = [];
  if (tw)  socialLinks.push(`<a href="${tw}">𝕏</a>`);
  if (tg)  socialLinks.push(`<a href="${tg}">💬 Telegram</a>`);
  if (dis) socialLinks.push(`<a href="${dis}">🎮 Discord</a>`);
  if (web) socialLinks.push(`<a href="${web}">🌍 Website</a>`);

  if (socialLinks.length > 0) {
    msg += `\n<b>🌐 Socials</b>\n`;
    msg += socialLinks.join("  ") + "\n";
  }

  // ── Security section ──────────────────────────────────────────────────────
  msg += `\n<b>🔒 Security</b>\n`;

  // Top 5 wallet links
  const gmgnChain   = GMGN_CHAIN[chain];
  const holderLinks = topHolders
    .slice(0, 5)
    .filter((h) => h.percentage > 0)
    .map(
      (h) =>
        `<a href="https://gmgn.ai/${gmgnChain}/address/${h.address}">${h.percentage.toFixed(1)}%</a>`
    )
    .join("  ");
  if (holderLinks) msg += `👥 Top Holders: ${holderLinks}\n`;

  // Top 10 concentration
  if (topHolders.length > 0) {
    const top10Pct  = topHolders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    const concEmoji = top10Pct <= 20 ? "🟢" : top10Pct <= 30 ? "🟡" : "🔴";
    msg += `📊 Top 10 hold: <b>${top10Pct.toFixed(1)}%</b> ${concEmoji}\n`;
  }

  // DEX Paid
  if (dexPaid.paid && dexPaid.paymentTimestamp) {
    const ts = dexPaid.paymentTimestamp > 1e12
      ? dexPaid.paymentTimestamp
      : dexPaid.paymentTimestamp * 1000;
    msg += `🏷️ DEX Paid: ✅ <i>${escapeHtml(formatTimeAgo(ts))}</i>\n`;
  } else {
    msg += `🏷️ DEX Paid: ❌\n`;
  }

  // ── DD Score ──────────────────────────────────────────────────────────────
  if (dd) {
    msg += `\n${GRADE_EMOJI[dd.grade] ?? "⚪"} DD Score: <b>${dd.overall}/100</b> — Grade <b>${dd.grade}</b>\n`;
  }

  if (warns.length > 0) {
    msg += `⚠️ <b>Warnings</b>\n`;
    warns.slice(0, 3).forEach((f) => { msg += `• ${escapeHtml(f.label)}\n`; });
  }

  // ── Trading links ─────────────────────────────────────────────────────────
  const t = tradingLinks(chain, address, data.primaryPair
    ? `https://dexscreener.com/${chain}/${data.primaryPair.pairAddress}`
    : null
  );
  msg += `\n<a href="${t.axi}">AXI</a>  `;
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
