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
  name:      string | null;
  twitter:   string | null;
  telegram:  string | null;
  discord:   string | null;
  website:   string | null;
  /** Rectangular banner image (1500×500) — best for photo messages */
  headerUrl: string | null;
  /** Square token logo fallback */
  imageUrl:  string | null;
}

async function fetchTokenInfo(chain: ChainId, address: string): Promise<TokenInfo> {
  const empty: TokenInfo = {
    name: null, twitter: null, telegram: null, discord: null,
    website: null, headerUrl: null, imageUrl: null,
  };
  const doFetch = async (): Promise<TokenInfo> => {
    const pairs = await getTokenPairs(chain, address);
    if (!pairs.length) return empty;

    // Best pair by liquidity for accurate name + image
    const sorted   = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const primary  = sorted[0];
    const withInfo = sorted.find((p) => p.info?.socials?.length || p.info?.websites?.length);

    const socials  = withInfo?.info?.socials  ?? [];
    const websites = withInfo?.info?.websites ?? [];

    return {
      name:      primary.baseToken.name ?? null,
      twitter:   socials.find((s) => s.type === "twitter")?.url  ?? null,
      telegram:  socials.find((s) => s.type === "telegram")?.url ?? null,
      discord:   socials.find((s) => s.type === "discord")?.url  ?? null,
      website:   websites[0]?.url ?? null,
      headerUrl: primary.info?.header   ?? null,
      imageUrl:  primary.info?.imageUrl ?? null,
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

// ── Message builder ───────────────────────────────────────────────────────────
// Photo captions are limited to 1024 chars — no <b>/<i>, plain holder percentages.
// Text-only messages can use full formatting with holder wallet hyperlinks.

function buildMessage(opts: {
  chain:       ChainId;
  address:     string;
  data:        Awaited<ReturnType<typeof aggregateTokenData>>;
  ath:         { price: number; timestamp: number } | null;
  topHolders:  Array<{ address: string; percentage: number }>;
  tokenInfo:   TokenInfo;
  dexPaid:     { paid: boolean; paymentTimestamp: number | null };
  isCaption:   boolean;  // true = photo caption (1024 char limit, no bold, plain holder %)
}): string {
  const { chain, address, data, ath, topHolders, tokenInfo, dexPaid, isCaption } = opts;
  if (!data) return "";

  const displayName = tokenInfo.name ?? data.name;
  const dd    = data.ddScore;
  const flags = data.safetySignals?.flags ?? [];
  const warns = flags.filter((f) => f.severity === "warning");

  const b  = (s: string) => isCaption ? s : `<b>${s}</b>`;
  const it = (s: string) => isCaption ? s : `<i>${s}</i>`;

  // ── Header ──────────────────────────────────────────────────────────────
  let msg = `${CHAIN_LOGO[chain]} ${b(escapeHtml(displayName))}`;
  msg += ` (${escapeHtml(data.symbol)}) · ${chainLabel(chain)}\n`;
  msg += `${escapeHtml(address)}\n`;

  // ── Stats ────────────────────────────────────────────────────────────────
  msg += `\n📊 Stats\n`;

  msg += `💰 Price: ${b(formatPrice(data.priceUsd))}`;
  const changes: string[] = [];
  if (data.priceChange.h1  !== null) changes.push(`1h ${formatPercent(data.priceChange.h1)}`);
  if (data.priceChange.h24 !== null) changes.push(`24h ${formatPercent(data.priceChange.h24)}`);
  if (changes.length) msg += `  ${it(`(${escapeHtml(changes.join(" · "))})`)}`;
  msg += "\n";

  msg += `📈 MC: ${b(`$${escapeHtml(formatCompact(data.marketCap))}`)}\n`;
  msg += `💧 Liq: ${b(`$${escapeHtml(formatCompact(data.liquidity?.totalUsd ?? null))}`)}`;
  msg += `  ·  Vol: ${b(`$${escapeHtml(formatCompact(data.volume24h))}`)}\n`;

  if (ath && data.priceUsd && data.priceUsd > 0 && data.marketCap) {
    const athMc = (ath.price / data.priceUsd) * data.marketCap;
    msg += `🏆 ATH MC: ${b(`$${escapeHtml(formatCompact(athMc))}`)}`;
    msg += ` ${it(`(${escapeHtml(formatTimeAgo(ath.timestamp))}`)})`;
    msg += "\n";
  }

  if (data.txns24h) {
    const total = data.txns24h.buys + data.txns24h.sells;
    msg += `🔄 Txns: ${b(escapeHtml(formatCompact(total)))}`;
    msg += ` (🟢${escapeHtml(formatCompact(data.txns24h.buys))} 🔴${escapeHtml(formatCompact(data.txns24h.sells))})\n`;
  }

  msg += `🕐 Age: ${b(escapeHtml(formatAge(data.createdAt)))}\n`;

  // ── Socials ──────────────────────────────────────────────────────────────
  const tw  = tokenInfo.twitter  ?? data.twitter  ?? null;
  const tg  = tokenInfo.telegram ?? data.telegram ?? null;
  const web = tokenInfo.website  ?? data.website  ?? null;
  const dis = tokenInfo.discord;

  const socialLinks: string[] = [];
  if (tw)  socialLinks.push(`<a href="${tw}">𝕏</a>`);
  if (tg)  socialLinks.push(`<a href="${tg}">TG</a>`);
  if (dis) socialLinks.push(`<a href="${dis}">DISC</a>`);
  if (web) socialLinks.push(`<a href="${web}">Web</a>`);

  if (socialLinks.length > 0) {
    msg += `\n🌐 Socials\n`;
    msg += socialLinks.join("  ") + "\n";
  }

  // ── Security ─────────────────────────────────────────────────────────────
  msg += `\n🔒 Security\n`;

  if (topHolders.length > 0) {
    if (isCaption) {
      // Plain percentages — no wallet hyperlinks (saves ~400 chars in caption)
      const pcts = topHolders.slice(0, 5).filter(h => h.percentage > 0)
        .map(h => `${h.percentage.toFixed(1)}%`).join("  ");
      if (pcts) msg += `👥 Top Holders: ${pcts}\n`;
    } else {
      // Full wallet hyperlinks in text-only messages
      const gmgnChain   = GMGN_CHAIN[chain];
      const holderLinks = topHolders.slice(0, 5).filter(h => h.percentage > 0)
        .map(h => `<a href="https://gmgn.ai/${gmgnChain}/address/${h.address}">${h.percentage.toFixed(1)}%</a>`)
        .join("  ");
      if (holderLinks) msg += `👥 Top Holders: ${holderLinks}\n`;
    }

    const top10Pct  = topHolders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    const concEmoji = top10Pct <= 20 ? "🟢" : top10Pct <= 30 ? "🟡" : "🔴";
    msg += `📊 Top 10 hold: ${b(`${top10Pct.toFixed(1)}%`)} ${concEmoji}\n`;
  }

  if (dexPaid.paid && dexPaid.paymentTimestamp) {
    const ts = dexPaid.paymentTimestamp > 1e12
      ? dexPaid.paymentTimestamp
      : dexPaid.paymentTimestamp * 1000;
    msg += `🏷️ DEX Paid: ✅ ${it(escapeHtml(formatTimeAgo(ts)))}\n`;
  } else {
    msg += `🏷️ DEX Paid: ❌\n`;
  }

  // ── DD Score ─────────────────────────────────────────────────────────────
  if (dd) {
    msg += `\n${GRADE_EMOJI[dd.grade] ?? "⚪"} DD Score: ${b(`${dd.overall}/100`)} — Grade ${b(dd.grade)}\n`;
  }

  if (warns.length > 0 && !isCaption) {
    msg += `⚠️ Warnings\n`;
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

  return msg;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleToken(
  ctx: MyContext,
  chain: ChainId,
  address: string,
  editMsgId?: number
): Promise<void> {
  const chatId = ctx.chat!.id;

  // Show an immediate loading indicator
  let loadingMsgId: number | null = null;
  if (editMsgId !== undefined) {
    // Refresh: show spinner in-place on the existing message
    await ctx.api.editMessageText(chatId, editMsgId, "🔄 Refreshing…").catch(() => null);
  } else {
    const loading = await ctx.reply("🔍 Analyzing token…");
    loadingMsgId = loading.message_id;
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

  // ── Error case ──────────────────────────────────────────────────────────
  if (!data) {
    const errMsg = "❌ Token not found. Check the address and chain.";
    if (editMsgId !== undefined) {
      await ctx.api.editMessageText(chatId, editMsgId, errMsg).catch(() => null);
    } else if (loadingMsgId) {
      await ctx.api.editMessageText(chatId, loadingMsgId, errMsg).catch(() => null);
    }
    return;
  }

  const keyboard  = tokenKeyboard(chain, address);
  const parseOpts = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

  // Prefer the rectangular header banner; fall back to square logo
  const bannerUrl = tokenInfo.headerUrl ?? tokenInfo.imageUrl ?? null;

  // ── Refresh: update existing message ─────────────────────────────────────
  if (editMsgId !== undefined) {
    if (bannerUrl) {
      const caption = buildMessage({ chain, address, data, ath, topHolders, tokenInfo, dexPaid, isCaption: true });
      await ctx.api.editMessageMedia(
        chatId, editMsgId,
        { type: "photo", media: bannerUrl, caption, parse_mode: "HTML" },
        { reply_markup: keyboard }
      ).catch(async () => {
        // Fallback if previous message was text (e.g. no image on first load)
        const msg = buildMessage({ chain, address, data, ath, topHolders, tokenInfo, dexPaid, isCaption: false });
        await ctx.api.editMessageText(chatId, editMsgId, msg, { ...parseOpts, reply_markup: keyboard });
      });
    } else {
      const msg = buildMessage({ chain, address, data, ath, topHolders, tokenInfo, dexPaid, isCaption: false });
      await ctx.api.editMessageText(chatId, editMsgId, msg, { ...parseOpts, reply_markup: keyboard });
    }
    return;
  }

  // ── New message: delete loading, send photo+caption or text ──────────────
  if (loadingMsgId) {
    await ctx.api.deleteMessage(chatId, loadingMsgId).catch(() => null);
  }

  if (bannerUrl) {
    const caption = buildMessage({ chain, address, data, ath, topHolders, tokenInfo, dexPaid, isCaption: true });
    await ctx.api.sendPhoto(chatId, bannerUrl, {
      caption,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } else {
    const msg = buildMessage({ chain, address, data, ath, topHolders, tokenInfo, dexPaid, isCaption: false });
    await ctx.api.sendMessage(chatId, msg, { ...parseOpts, reply_markup: keyboard });
  }
}
