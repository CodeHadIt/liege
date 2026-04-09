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
  base:   "🔵",
  bsc:    "🟡",
};

const GMGN_CHAIN: Record<ChainId, string> = {
  solana: "sol",
  base:   "base",
  bsc:    "bsc",
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

// ── DexScreener token info (name + socials + banner) ─────────────────────────

interface TokenInfo {
  name:      string | null;
  twitter:   string | null;
  telegram:  string | null;
  discord:   string | null;
  website:   string | null;
  /** 1500×500 rectangular banner — preferred for photo messages */
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

// ── DEX Paid ──────────────────────────────────────────────────────────────────

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

// ── Box-drawing helpers ───────────────────────────────────────────────────────

/** Prefix all rows with ├ and the final row with └. */
function boxRows(rows: string[]): string {
  if (!rows.length) return "";
  return rows
    .map((row, i) => (i === rows.length - 1 ? `└ ${row}` : `├ ${row}`))
    .join("\n") + "\n";
}

// ── Message builder ───────────────────────────────────────────────────────────
// isCaption=true → photo caption mode: no <b>/<i> tags (saves ~77 chars to stay
// under Telegram's 1024-char caption limit). TH is always plain % in both modes.

function buildMessage(opts: {
  chain:      ChainId;
  address:    string;
  data:       Awaited<ReturnType<typeof aggregateTokenData>>;
  ath:        { price: number; timestamp: number } | null;
  topHolders: Array<{ address: string; percentage: number }>;
  tokenInfo:  TokenInfo;
  dexPaid:    DexPaidResult;
  isCaption?: boolean;
}): string {
  const { chain, address, data, ath, topHolders, tokenInfo, dexPaid, isCaption = false } = opts;
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
  msg += `<code>${escapeHtml(address)}</code>\n`;

  // ── Stats ────────────────────────────────────────────────────────────────
  msg += `\n📊 Stats\n`;

  const statsRows: string[] = [];

  const changes: string[] = [];
  if (data.priceChange.h1  !== null) changes.push(`${formatPercent(data.priceChange.h1)} 1h`);
  if (data.priceChange.h24 !== null) changes.push(`${formatPercent(data.priceChange.h24)} 24h`);
  const changeStr = changes.length ? `  ${it(`(${escapeHtml(changes.join("  "))})`)}` : "";
  statsRows.push(`💰 Price: ${b(formatPrice(data.priceUsd))}${changeStr}`);
  statsRows.push(`📈 MC: ${b(`$${escapeHtml(formatCompact(data.marketCap))}`)}`);
  statsRows.push(`💧 Liq: ${b(`$${escapeHtml(formatCompact(data.liquidity?.totalUsd ?? null))}`)}`);
  statsRows.push(`📦 Vol: ${b(`$${escapeHtml(formatCompact(data.volume24h))}`)}`);

  if (ath && data.priceUsd && data.priceUsd > 0 && data.marketCap) {
    const athMc = (ath.price / data.priceUsd) * data.marketCap;
    statsRows.push(
      `🏆 ATH: ${b(`$${escapeHtml(formatCompact(athMc))}`)}  ${it(`(${escapeHtml(formatTimeAgo(ath.timestamp))})`)}`,
    );
  }

  if (data.txns24h) {
    const total = data.txns24h.buys + data.txns24h.sells;
    statsRows.push(
      `🔄 Txns: ${b(escapeHtml(formatCompact(total)))}  🟢${escapeHtml(formatCompact(data.txns24h.buys))}  🔴${escapeHtml(formatCompact(data.txns24h.sells))}`,
    );
  }

  statsRows.push(`🕐 Age: ${b(escapeHtml(formatAge(data.createdAt)))}`);
  msg += boxRows(statsRows);

  // ── Socials ──────────────────────────────────────────────────────────────
  const tw  = tokenInfo.twitter  ?? data.twitter  ?? null;
  const tg  = tokenInfo.telegram ?? data.telegram ?? null;
  const web = tokenInfo.website  ?? data.website  ?? null;
  const dis = tokenInfo.discord;

  const escUrl = (u: string) => u.replace(/&/g, "&amp;");
  const socialRows: string[] = [];
  if (tw)  socialRows.push(`<a href="${escUrl(tw)}">𝕏</a>`);
  if (tg)  socialRows.push(`<a href="${escUrl(tg)}">TG</a>`);
  if (dis) socialRows.push(`<a href="${escUrl(dis)}">DISC</a>`);
  if (web) socialRows.push(`<a href="${escUrl(web)}">Web</a>`);

  if (socialRows.length > 0) {
    msg += `\n🌐 Socials\n`;
    msg += `└ ${socialRows.join("  ")}\n`;
  }

  // ── Security ─────────────────────────────────────────────────────────────
  msg += `\n🔒 Security\n`;

  const secRows: string[] = [];

  if (topHolders.length > 0) {
    // TH: plain percentages (no wallet links — keeps caption under 1024 chars)
    const pcts = topHolders.slice(0, 5).filter((h) => h.percentage > 0)
      .map((h) => `${h.percentage.toFixed(1)}%`).join("  ");
    if (pcts) secRows.push(`👥 TH: ${pcts}`);

    const top10Pct  = topHolders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    const concEmoji = top10Pct <= 20 ? "🟢" : top10Pct <= 30 ? "🟡" : "🔴";
    secRows.push(`📊 T10: ${b(`${top10Pct.toFixed(1)}%`)}  ${concEmoji}`);
  }

  if (dexPaid.paid && dexPaid.paymentTimestamp) {
    const ts = dexPaid.paymentTimestamp > 1e12
      ? dexPaid.paymentTimestamp
      : dexPaid.paymentTimestamp * 1000;
    secRows.push(`🏷️ Dex: ✅  ${it(escapeHtml(formatTimeAgo(ts)))}`);
  } else {
    secRows.push(`🏷️ Dex: ❌`);
  }

  msg += boxRows(secRows);

  // ── DD Score ─────────────────────────────────────────────────────────────
  if (dd && !isCaption) {
    msg += `\n${GRADE_EMOJI[dd.grade] ?? "⚪"} DD Score: ${b(`${dd.overall}/100`)} — Grade ${b(dd.grade)}\n`;
  }

  if (warns.length > 0 && !isCaption) {
    const warnRows = warns.slice(0, 3).map((f) => escapeHtml(f.label));
    msg += `\n⚠️ Warnings\n` + boxRows(warnRows);
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

  // For new requests send a loading placeholder; for refresh there's no loading state
  // (callback was already answered in bot.ts)
  let loadingMsgId: number | undefined;
  if (editMsgId === undefined) {
    const loading = await ctx.reply("🔍 Analyzing token…");
    loadingMsgId = loading.message_id;
  }

  // 25s guard on aggregateTokenData — EVM providers can hang without API keys
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

  const bannerUrl = tokenInfo.headerUrl ?? tokenInfo.imageUrl ?? null;
  const keyboard  = tokenKeyboard(chain, address);

  if (!data) {
    const errText = "❌ Token not found. Check the address and chain.";
    if (editMsgId !== undefined) {
      await ctx.api.editMessageText(chatId, editMsgId, errText).catch(() => null);
    } else {
      await ctx.api.editMessageText(chatId, loadingMsgId!, errText).catch(() => null);
    }
    return;
  }

  if (bannerUrl) {
    const caption = buildMessage({ chain, address, data, ath, topHolders, tokenInfo, dexPaid, isCaption: true });

    if (editMsgId !== undefined) {
      // Refresh in-place via editMessageMedia; fall back to delete+resend
      await ctx.api.editMessageMedia(
        chatId, editMsgId,
        { type: "photo", media: bannerUrl, caption, parse_mode: "HTML" },
        { reply_markup: keyboard }
      ).catch(async () => {
        await ctx.api.deleteMessage(chatId, editMsgId).catch(() => null);
        await ctx.api.sendPhoto(chatId, bannerUrl!, { caption, parse_mode: "HTML", reply_markup: keyboard });
      });
    } else {
      // Delete the loading text message, then send photo
      await ctx.api.deleteMessage(chatId, loadingMsgId!).catch(() => null);
      await ctx.api.sendPhoto(chatId, bannerUrl, { caption, parse_mode: "HTML", reply_markup: keyboard });
    }
  } else {
    // No banner: plain text message
    const msg        = buildMessage({ chain, address, data, ath, topHolders, tokenInfo, dexPaid });
    const targetMsgId = editMsgId ?? loadingMsgId!;
    await ctx.api.editMessageText(chatId, targetMsgId, msg, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    }).catch(() => null);
  }
}
