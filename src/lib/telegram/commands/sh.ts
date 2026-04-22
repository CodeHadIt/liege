import type { MyContext } from "../bot";
import {
  escapeHtml,
  formatPnl,
  formatCompact,
  truncateAddress,
  chainEmoji,
  chainLabel,
  splitPages,
} from "../utils/format";
import type { ChainId } from "@/types/chain";
import type { SharedHoldersResponse } from "@/types/shared-holders";

// ── Constants ─────────────────────────────────────────────────────────────────

const _rawAppUrl =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://liege.up.railway.app";
const APP_URL = _rawAppUrl.startsWith("http")
  ? _rawAppUrl
  : `https://${_rawAppUrl}`;

const GMGN_CHAIN: Record<string, string> = {
  solana: "sol",
  base:   "base",
  bsc:    "bsc",
  eth:    "eth",
};

const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE    = /^0x[a-fA-F0-9]{40}$/;

// ── Chain detection ───────────────────────────────────────────────────────────

/** Detect "solana" | "evm" | null purely from address format. */
function detectAddrType(addr: string): "solana" | "evm" | null {
  if (SOLANA_RE.test(addr)) return "solana";
  if (EVM_RE.test(addr))    return "evm";
  return null;
}

/**
 * For EVM addresses, use DexScreener to figure out Base vs BSC.
 * Returns "base" or "bsc" (falls back to "base" on error).
 */
async function detectEvmChain(address: string): Promise<"base" | "bsc" | "eth"> {
  try {
    const [resBase, resBsc, resEth] = await Promise.all([
      fetch(`https://api.dexscreener.com/tokens/v1/base/${address}`,     { signal: AbortSignal.timeout(5000) }),
      fetch(`https://api.dexscreener.com/tokens/v1/bsc/${address}`,      { signal: AbortSignal.timeout(5000) }),
      fetch(`https://api.dexscreener.com/tokens/v1/ethereum/${address}`, { signal: AbortSignal.timeout(5000) }),
    ]);

    const [pairsBase, pairsBsc, pairsEth] = await Promise.all([
      resBase.ok  ? (resBase.json()  as Promise<Array<{ liquidity?: { usd?: number } }>>) : Promise.resolve([]),
      resBsc.ok   ? (resBsc.json()   as Promise<Array<{ liquidity?: { usd?: number } }>>) : Promise.resolve([]),
      resEth.ok   ? (resEth.json()   as Promise<Array<{ liquidity?: { usd?: number } }>>) : Promise.resolve([]),
    ]);

    const liqBase = pairsBase.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
    const liqBsc  = pairsBsc.reduce ((s, p) => s + (p.liquidity?.usd ?? 0), 0);
    const liqEth  = pairsEth.reduce ((s, p) => s + (p.liquidity?.usd ?? 0), 0);

    if (liqEth >= liqBase && liqEth >= liqBsc) return "eth";
    if (liqBsc >= liqBase)                     return "bsc";
    return "base";
  } catch {
    return "base";
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function gmgnWalletUrl(chain: ChainId | "eth", wallet: string): string {
  const slug = GMGN_CHAIN[chain] ?? chain;
  return `https://gmgn.ai/${slug}/address/${wallet}`;
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  return `$${formatCompact(n)}`;
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${fmtUsd(n)}`;
}

type WealthTier = "whale" | "dolphin" | "fish" | "shrimp";

function wealthTier(usd: number): WealthTier {
  if (usd >= 10_000) return "whale";
  if (usd >= 1_000)  return "dolphin";
  if (usd >= 100)    return "fish";
  return "shrimp";
}

const TIER_EMOJI: Record<WealthTier, string> = {
  whale:   "🐋",
  dolphin: "🐬",
  fish:    "🐟",
  shrimp:  "🦐",
};

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleSharedHolders(
  ctx: MyContext,
  addrA: string,
  addrB: string
): Promise<void> {
  // Detect chain from address A (both must be same type)
  const typeA = detectAddrType(addrA);
  const typeB = detectAddrType(addrB);

  if (!typeA || !typeB) {
    await ctx.reply("❌ Could not detect chain from the addresses provided.");
    return;
  }
  if (typeA !== typeB) {
    await ctx.reply(
      "❌ Addresses appear to be on different chains — both must be on the same chain."
    );
    return;
  }

  // Resolve specific EVM chain
  let chain: ChainId | "eth";
  if (typeA === "solana") {
    chain = "solana";
  } else {
    chain = await detectEvmChain(addrA);
  }

  const chainName = chainLabel(chain as ChainId);
  const emoji     = chainEmoji(chain as ChainId);

  const loading = await ctx.reply(
    `⏳ Finding shared holders on ${emoji} <b>${chainName}</b>…\n\n` +
    `<i>Scanning top 500 holders per token — this takes ~30s.</i>`,
    { parse_mode: "HTML" }
  );

  try {
    const res = await fetch(`${APP_URL}/api/shared-holders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain, addressA: addrA, addressB: addrB }),
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ ${escapeHtml((err as { error: string }).error ?? "Failed to find shared holders.")}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const data = (await res.json()) as SharedHoldersResponse;
    const { holders, tokenA, tokenB } = data;

    if (holders.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `${emoji} <b>Shared Holders</b> · ${escapeHtml(chainName)}\n\n` +
        `<b>${escapeHtml(tokenA.symbol)}</b> &amp; <b>${escapeHtml(tokenB.symbol)}</b>\n\n` +
        `🤷 No shared holders found in the top 500 of each token.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const symA = escapeHtml(tokenA.symbol);
    const symB = escapeHtml(tokenB.symbol);

    const titleBase =
      `${emoji} <b>Shared Holders</b> · ${escapeHtml(chainName)}\n` +
      `<b>${symA}</b> &amp; <b>${symB}</b>`;

    const preamble =
      `<code>${escapeHtml(addrA)}</code>\n` +
      `<code>${escapeHtml(addrB)}</code>\n\n` +
      `Found <b>${holders.length}</b> shared holder${holders.length === 1 ? "" : "s"} · sorted by combined PnL\n\n`;

    // Build one entry per holder
    const entries: string[] = holders.map((h, i) => {
      const walletUrl  = gmgnWalletUrl(chain as ChainId, h.address);
      const addrLabel  = escapeHtml(truncateAddress(h.address));
      const combinedUsd = h.tokenA.balanceUsd + h.tokenB.balanceUsd;
      const tier        = TIER_EMOJI[wealthTier(combinedUsd)];
      const pnlSign     = h.combinedPnl >= 0 ? "📈" : "📉";

      let entry = `${i + 1}. <a href="${walletUrl}">${addrLabel}</a> ${tier}\n`;

      // Combined PnL line
      entry +=
        `   ${pnlSign} Combined PnL: <b>${escapeHtml(fmtPnl(h.combinedPnl))}</b>` +
        `  Holding: <b>${escapeHtml(fmtUsd(combinedUsd))}</b>\n`;

      // Per-token lines
      const tA = h.tokenA;
      const tB = h.tokenB;

      const holdA   = escapeHtml(fmtUsd(tA.balanceUsd));
      const boughtA = escapeHtml(fmtUsd(tA.investedUsd));
      const pnlA    = escapeHtml(fmtPnl(tA.totalPnl));
      const buyMcA  = tA.buyMarketCap != null ? escapeHtml(`$${formatCompact(tA.buyMarketCap)}`) : "—";

      entry +=
        `   <b>${symA}</b>: hold ${holdA} · bought ${boughtA} · buy MC ${buyMcA} · PnL ${pnlA}\n`;

      entry += `   <code>- - - - - - - - - - -</code>\n`;

      const holdB   = escapeHtml(fmtUsd(tB.balanceUsd));
      const boughtB = escapeHtml(fmtUsd(tB.investedUsd));
      const pnlB    = escapeHtml(fmtPnl(tB.totalPnl));
      const buyMcB  = tB.buyMarketCap != null ? escapeHtml(`$${formatCompact(tB.buyMarketCap)}`) : "—";

      entry +=
        `   <b>${symB}</b>: hold ${holdB} · bought ${boughtB} · buy MC ${buyMcB} · PnL ${pnlB}\n`;

      entry += "\n";
      return entry;
    });

    const pages = splitPages(entries, (page, total) => {
      const pageLabel = total > 1 ? `  <i>${page}/${total}</i>` : "";
      const header    = `${titleBase}${pageLabel}\n`;
      return page === 1 ? header + preamble : header + "\n";
    });

    for (let p = 0; p < pages.length; p++) {
      if (p === 0) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          pages[p],
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
      } else {
        await ctx.reply(pages[p], {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
    }
  } catch (err) {
    console.error("[bot/sh]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to find shared holders. Please try again."
    );
  }
}
