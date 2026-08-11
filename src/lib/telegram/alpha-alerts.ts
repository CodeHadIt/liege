import { getAlertsBot, broadcastAlert } from "./alerts-bot";
import { escapeHtml } from "./utils/format";

// ── Alpha wallet confluence alerts ────────────────────────────────────────────
// The signal is not one wallet buying — it's SEVERAL of them buying the same
// token inside a short window. So nothing fires on the first buy; the first
// alert goes out when the second alpha wallet joins, and each further wallet
// gets its own follow-up until the cap is reached.

/** Confluence only counts inside this window, measured from the first alpha buy. */
export const CONFLUENCE_WINDOW_MS = 4 * 60 * 60 * 1000;
/** Alert on wallets 2..5 — four pings at most, then the token stops being watched. */
export const MIN_WALLETS_TO_ALERT = 2;
export const MAX_WALLETS_TO_ALERT = 5;

/**
 * Ignore buys below this size.
 *
 * This is load-bearing, not a nicety. Robinhood Chain runs 0.1s blocks and the
 * alpha wallets trade constantly, so measured against live data two of them
 * touching the same token is common. Confluence events per day, by floor:
 *
 *   $0 → ~173     $250 → ~58     $500 → ~29     $2,500 → ~29
 *
 * $250 keeps the feed at roughly one event every 25 minutes while still cutting
 * the dust that dominated the raw signal ($66, $246, $278 buys). Raise it if the
 * feed proves noisier than the sample suggested — the sample covered under an
 * hour, so treat these rates as indicative rather than precise.
 *
 * Buys we cannot price do NOT count toward confluence. They used to, on the
 * reasoning that an unpriced token is one no indexer has seen yet and therefore
 * the earliest case worth catching. In practice it meant anything without a
 * price bypassed the floor entirely, and a single ERC-721 collection produced
 * 452 valueless "buys" and 31 alerts. The cost of that outweighs being a few
 * minutes early: once a real token is indexed, later alpha buys still trigger it.
 */
export const MIN_BUY_USD = 250;

/**
 * Once a token's window closes, ignore it for this long before opening another.
 * Without it a burst of activity re-opens a window the instant the previous one
 * fills, and the same token alerts indefinitely — the Spritehood incident opened
 * 8 windows in 34 minutes, each running the full 4 alerts.
 */
export const WINDOW_REOPEN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

export interface AlphaBuyer {
  label: string;
  address: string;
  amountUsd: number | null;
  marketCapUsd: number | null;
  supplyPct: number | null;
  /** NFT only: how many were taken in the transaction */
  quantity?: number | null;
  /** NFT only: minted from the contract rather than bought from a holder */
  isMint?: boolean;
}

export interface ConfluenceToken {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  liquidityUsd: number | null;
  currentMcUsd: number | null;
  /** market cap when the first alert fired — the baseline for "up N x" */
  firstAlertMcUsd: number | null;
  assetType?: "erc20" | "erc721";
  /** NFT only */
  totalSupply?: number | null;
  holders?: number | null;
  /** NFT only: floor price */
  floorUsd?: number | null;
  floorEth?: number | null;
  floorSales?: number | null;
  /** "opensea" = real lowest ask; "onchain" = lowest recent fill, a proxy */
  floorSource?: "opensea" | "onchain" | null;
  openSeaUrl?: string | null;
}

const isNft = (t: ConfluenceToken) => t.assetType === "erc721";

/**
 * $2M / $2.1M / $310K / $5K — the K/M shorthand used throughout the alerts.
 * Trailing zeros are trimmed: a market cap reads "$2M", not "$2.00M", so the
 * number is scannable at a glance in a fast-moving feed.
 */
export function mc(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const trim = (v: number, unit: string) => `${sign}$${parseFloat(v.toFixed(v >= 100 ? 0 : 1))}${unit}`;
  if (a >= 1e9) return trim(a / 1e9, "B");
  if (a >= 1e6) return trim(a / 1e6, "M");
  if (a >= 1e3) return trim(a / 1e3, "K");
  return `${sign}$${a.toFixed(0)}`;
}

function gmgnUrl(chain: string, token: string): string {
  const slug = chain === "rh" ? "robinhood" : chain;
  return `https://gmgn.ai/${slug}/token/${token}`;
}

function walletLink(chain: string, b: AlphaBuyer): string {
  const slug = chain === "rh" ? "robinhood" : chain;
  return `<a href="https://gmgn.ai/${slug}/address/${b.address}">${escapeHtml(b.label)}</a>`;
}

function buyLine(chain: string, b: AlphaBuyer, nft: boolean): string {
  const bits: string[] = [];
  if (nft) {
    // A free mint is the norm, so "$0" is meaningful rather than missing data —
    // say so explicitly instead of rendering an empty price.
    bits.push(`🖼 ${b.quantity ?? 1}x`);
    bits.push(b.amountUsd != null && b.amountUsd > 0 ? `💵 ${mc(b.amountUsd)}` : `💵 free mint`);
    if (b.supplyPct != null && b.supplyPct > 0) bits.push(`🧬 ${b.supplyPct.toFixed(2)}% of supply`);
  } else {
    bits.push(`💵 ${mc(b.amountUsd)}`, `📊 at ${mc(b.marketCapUsd)} MC`);
    if (b.supplyPct != null && b.supplyPct > 0) bits.push(`🧬 ${b.supplyPct.toFixed(2)}% supply`);
  }
  return `${walletLink(chain, b)}\n<code>${escapeHtml(b.address)}</code>\n   ${bits.join("  ·  ")}`;
}

function footer(t: ConfluenceToken): string[] {
  const lines: string[] = [];
  // Only the derived figure needs qualifying — an OpenSea floor is a real ask.
  if (isNft(t) && t.floorUsd != null && t.floorSource === "onchain") {
    lines.push("");
    lines.push(`<i>Floor derived from ${t.floorSales ?? "recent"} on-chain sales — not listed on OpenSea.</i>`);
  }
  lines.push("");
  lines.push(`<code>${escapeHtml(t.address)}</code>`);
  // GMGN indexes fungible tokens, not NFT collections — linking there for an
  // NFT would land on an empty page, so send those to the explorer instead.
  const links = isNft(t) ? [] : [`🟢 <a href="${gmgnUrl(t.chain, t.address)}">Buy on GMGN</a>`];
  if (isNft(t) && t.openSeaUrl) links.push(`⛵ <a href="${escapeHtml(t.openSeaUrl)}">OpenSea</a>`);
  if (t.chain === "rh") links.push(`🔭 <a href="${RH_EXPLORER}/token/${t.address}">Blockscout</a>`);
  lines.push(links.join("  ·  "));
  return lines;
}

/**
 * First alert — fires when the SECOND alpha wallet buys, and names every buyer
 * so far. `buyers` must be in buy order.
 */
export function formatConfluenceAlert(t: ConfluenceToken, buyers: AlphaBuyer[]): string {
  const lines: string[] = [];
  const nft = isNft(t);
  const verb = nft ? (buyers.every((b) => b.isMint) ? "minted" : "collected") : "bought";
  lines.push(
    `${nft ? "🖼" : "🚨"} <b>Alpha Confluence</b>  ·  ${buyers.length} wallets ${verb} ` +
      `<b>${nft ? "" : "$"}${escapeHtml(t.symbol)}</b>`
  );
  lines.push(`<i>${escapeHtml(t.name || t.symbol)}${nft ? " · NFT collection" : ""}</i>`);
  lines.push("");
  for (const b of buyers) {
    lines.push(buyLine(t.chain, b, isNft(t)));
  }

  const stat: string[] = [];
  if (nft) {
    // An NFT has no market cap or pool; supply and holders are the equivalent
    // sense of how big and how distributed the thing is.
    if (t.floorUsd != null) {
      const eth = t.floorEth != null ? ` (${t.floorEth.toFixed(4)} ETH)` : "";
      stat.push(`🏷 Floor ~${mc(t.floorUsd)}${eth}`);
    }
    if (t.totalSupply != null) stat.push(`🧾 Supply ${t.totalSupply.toLocaleString()}`);
    if (t.holders != null) stat.push(`👥 ${t.holders.toLocaleString()} holders`);
  } else {
    if (t.currentMcUsd != null) stat.push(`📊 MC ${mc(t.currentMcUsd)}`);
    if (t.liquidityUsd != null) stat.push(`💧 Liq ${mc(t.liquidityUsd)}`);
  }
  if (stat.length) {
    lines.push("");
    lines.push(stat.join("  ·  "));
  }
  lines.push(...footer(t));
  return lines.join("\n");
}

/**
 * Follow-up — one more alpha wallet joined. Shows who they join, and how far the
 * token has moved since the first ping, which is the reason to care.
 */
export function formatConfluenceFollowUp(
  t: ConfluenceToken,
  joiner: AlphaBuyer,
  previous: AlphaBuyer[]
): string {
  const total = previous.length + 1;
  const lines: string[] = [];
  const nft = isNft(t);
  lines.push(
    `➕ <b>Alpha #${total} ${nft ? (joiner.isMint ? "minted" : "collected") : "bought"} ` +
      `${nft ? "" : "$"}${escapeHtml(t.symbol)}</b>`
  );
  lines.push("");
  lines.push(buyLine(t.chain, joiner, isNft(t)));
  lines.push("");
  lines.push(
    `🤝 Joins ${previous.map((p) => `<b>${escapeHtml(p.label)}</b>`).join(", ")} — ` +
      `<b>${total}</b> alpha wallets now in <b>${nft ? "" : "$"}${escapeHtml(t.symbol)}</b>`
  );

  if (nft) {
    const bits: string[] = [];
    if (t.floorUsd != null) {
      const eth = t.floorEth != null ? ` (${t.floorEth.toFixed(4)} ETH)` : "";
      bits.push(`🏷 Floor ~${mc(t.floorUsd)}${eth}`);
    }
    if (t.totalSupply != null) bits.push(`🧾 Supply ${t.totalSupply.toLocaleString()}`);
    if (t.holders != null) bits.push(`👥 ${t.holders.toLocaleString()} holders`);
    if (bits.length) lines.push(bits.join("  ·  "));
  } else if (t.currentMcUsd != null) {
    const base = t.firstAlertMcUsd;
    const move =
      base && base > 0
        ? (() => {
            const x = t.currentMcUsd! / base;
            return x >= 1 ? `up ${x.toFixed(1)}x since first ping` : `down ${((1 - x) * 100).toFixed(0)}% since first ping`;
          })()
        : null;
    lines.push(`📊 MC now ${mc(t.currentMcUsd)}${move ? ` — <b>${move}</b>` : ""}`);
  }
  if (t.liquidityUsd != null) lines.push(`💧 Liq ${mc(t.liquidityUsd)}`);

  lines.push(...footer(t));
  return lines.join("\n");
}

async function send(chatId: string, text: string): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

export async function sendConfluenceAlert(t: ConfluenceToken, buyers: AlphaBuyer[]): Promise<void> {
  const text = formatConfluenceAlert(t, buyers);
  await broadcastAlert((chatId) => send(chatId, text));
}

export async function sendConfluenceFollowUp(
  t: ConfluenceToken,
  joiner: AlphaBuyer,
  previous: AlphaBuyer[]
): Promise<void> {
  const text = formatConfluenceFollowUp(t, joiner, previous);
  await broadcastAlert((chatId) => send(chatId, text));
}
