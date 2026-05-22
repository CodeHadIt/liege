import type { MyContext } from "../bot";
import {
  escapeHtml,
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
const TON_RE    = /^(?:EQ|UQ|Ef|Uf|kQ|kf|0Q|0f)[A-Za-z0-9_-]{46}$/;

// ── Chain detection ───────────────────────────────────────────────────────────

function detectAddrType(addr: string): "solana" | "evm" | "ton" | null {
  if (TON_RE.test(addr))    return "ton";
  if (SOLANA_RE.test(addr)) return "solana";
  if (EVM_RE.test(addr))    return "evm";
  return null;
}

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
  addresses: string[]
): Promise<void> {
  const types = addresses.map(detectAddrType);

  if (types.some((t) => !t)) {
    await ctx.reply("❌ Could not detect chain from one or more addresses provided.");
    return;
  }
  if (new Set(types).size > 1) {
    await ctx.reply("❌ All addresses must be on the same chain.");
    return;
  }

  let chain: ChainId | "eth";
  const addrType = types[0]!;
  if (addrType === "solana") {
    chain = "solana";
  } else if (addrType === "ton") {
    chain = "ton";
  } else {
    chain = await detectEvmChain(addresses[0]);
  }

  const chainName = chainLabel(chain as ChainId);
  const emoji     = chainEmoji(chain as ChainId);

  const loading = await ctx.reply(
    `⏳ Finding shared holders on ${emoji} <b>${chainName}</b>…\n\n` +
    `<i>Scanning top 500 holders per token (${addresses.length} tokens) — this takes ~30s.</i>`,
    { parse_mode: "HTML" }
  );

  try {
    const res = await fetch(`${APP_URL}/api/shared-holders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain, addresses }),
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
    const { holders, tokens: tokenMetas } = data;

    const tokenTitle = tokenMetas.map((t) => `<b>${escapeHtml(t.symbol)}</b>`).join(" · ");

    if (holders.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `${emoji} <b>Shared Holders</b> · ${escapeHtml(chainName)}\n\n` +
        `${tokenTitle}\n\n` +
        `🤷 No shared holders found in the top 500 of each token.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const titleBase =
      `${emoji} <b>Shared Holders</b> · ${escapeHtml(chainName)}\n` +
      tokenTitle;

    const preamble =
      addresses.map((a) => `<code>${escapeHtml(a)}</code>`).join("\n") + "\n\n" +
      `Found <b>${holders.length}</b> shared holder${holders.length === 1 ? "" : "s"} · sorted by combined PnL\n\n`;

    const entries: string[] = holders.map((h, i) => {
      const walletUrl  = chain === "ton"
        ? `https://tonviewer.com/${h.address}`
        : gmgnWalletUrl(chain as ChainId, h.address);
      const addrLabel  = escapeHtml(truncateAddress(h.address));
      const combinedUsd = h.tokens.reduce((s, t) => s + t.balanceUsd, 0);
      const tier        = TIER_EMOJI[wealthTier(combinedUsd)];
      const pnlSign     = h.combinedPnl >= 0 ? "📈" : "📉";

      let entry = `${i + 1}. <a href="${walletUrl}">${addrLabel}</a> ${tier}\n`;

      entry +=
        `   ${pnlSign} Combined PnL: <b>${escapeHtml(fmtPnl(h.combinedPnl))}</b>` +
        `  Holding: <b>${escapeHtml(fmtUsd(combinedUsd))}</b>\n`;

      for (let ti = 0; ti < tokenMetas.length; ti++) {
        const sym    = escapeHtml(tokenMetas[ti].symbol);
        const td     = h.tokens[ti];
        const hold   = escapeHtml(fmtUsd(td.balanceUsd));
        const bought = escapeHtml(fmtUsd(td.investedUsd));
        const pnl    = escapeHtml(fmtPnl(td.totalPnl));
        const buyMc  = td.buyMarketCap != null ? escapeHtml(`$${formatCompact(td.buyMarketCap)}`) : "—";
        entry += `   <b>${sym}</b>: hold ${hold} · bought ${bought} · buy MC ${buyMc} · PnL ${pnl}\n`;
      }

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
