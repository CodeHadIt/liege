import { InlineKeyboard } from "grammy";
import type { ChainId } from "@/types/chain";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://liege.up.railway.app";

// ── Chain pickers ─────────────────────────────────────────────────────────────

export function ctChainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("◎ Solana", "ct:chain:solana")
    .text("🔵 Base", "ct:chain:base")
    .text("🟡 BSC", "ct:chain:bsc");
}

export function dexPaidPeriodKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("30m", "dexpaid:30m")
    .text("1h", "dexpaid:1h")
    .text("2h", "dexpaid:2h")
    .row()
    .text("4h", "dexpaid:4h")
    .text("8h", "dexpaid:8h");
}

// ── Token detail keyboard ─────────────────────────────────────────────────────
//
// Row 1 — Trading platforms
// Row 2 — Socials (dynamic, only shown when links are available)
// Row 3 — Actions: [Liège] [🔄 Refresh] [🗑️ Delete]

interface TokenLinks {
  dexUrl?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
}

function tradingUrls(chain: ChainId, address: string, dexUrl?: string | null) {
  const bullxChainId: Record<ChainId, string> = {
    solana: "1399811149",
    base: "8453",
    bsc: "56",
  };
  const gmgnChain: Record<ChainId, string> = {
    solana: "sol",
    base: "base",
    bsc: "bsc",
  };
  const axiomNetwork: Record<ChainId, string> = {
    solana: "solana",
    base: "base",
    bsc: "bsc",
  };

  return {
    axi: `https://axiom.trade/t/${address}?networkId=${axiomNetwork[chain]}`,
    tro:
      chain === "solana"
        ? `https://t.me/solana_trojanbot?start=${address}`
        : `https://t.me/tbEVMbot?start=${address}`,
    tem: `https://bullx.io/terminal?chainId=${bullxChainId[chain]}&address=${address}`,
    dex: dexUrl ?? `https://dexscreener.com/${chain}/${address}`,
    gmg: `https://gmgn.ai/${gmgnChain[chain]}/token/${address}`,
  };
}

export function tokenKeyboard(
  chain: ChainId,
  address: string,
  links: TokenLinks = {}
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const t = tradingUrls(chain, address, links.dexUrl);

  // Row 1 — Trading
  kb.url("AXI", t.axi)
    .url("TRO", t.tro)
    .url("TEM", t.tem)
    .url("DEX", t.dex)
    .url("GMG", t.gmg);

  // Row 2 — Socials (only add if available)
  const socialButtons: { label: string; url: string }[] = [];
  if (links.twitter) socialButtons.push({ label: "𝕏", url: links.twitter });
  if (links.telegram) socialButtons.push({ label: "TG", url: links.telegram });
  if (links.website) socialButtons.push({ label: "WEB", url: links.website });

  if (socialButtons.length > 0) {
    kb.row();
    for (const btn of socialButtons) kb.url(btn.label, btn.url);
  }

  // Row 3 — Actions
  kb.row()
    .url("Liège", `${APP_URL}/token/${chain}/${address}`)
    .text("🔄", `rt:${chain}:${address}`)
    .text("🗑️", "del");

  return kb;
}
