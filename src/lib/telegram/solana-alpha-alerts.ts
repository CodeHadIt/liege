import { loadAlphaWallets } from "@/lib/api/alpha-wallets";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { escapeHtml, formatCompact, formatTimeAgo, jupiterBuyUrl } from "./utils/format";

// ── Solana alpha wallet watcher ──────────────────────────────────────────────
//
// Watches hand-picked Solana wallets and reports what they DO, which on this
// chain is two different things:
//
//   DEPLOY — the wallet mints a new token. For a dev wallet this is the whole
//            signal: the first CyberLeeks entry is the wallet behind a $1.35M
//            token, and the next thing it ships is what you want to know about.
//   BUY    — the wallet acquires a token and pays for it.
//
// Both are reported because "alpha wallet" covers both kinds of wallet, and a
// watchlist assembled by hand will contain both.
//
// This is NOT the Robinhood confluence model. That one stays silent until a
// SECOND alpha wallet buys the same token, which is right when you have 88
// wallets and wrong when you have one — it would never fire.

const CHAIN = "solana";

/**
 * SOL that must leave the wallet for an incoming token to count as a buy.
 *
 * Load-bearing, not a nicety. These wallets are dusted constantly: the
 * CyberLeeks wallet received two unsolicited `…pump` tokens in three days, each
 * arriving as a plain transfer with zero SOL spent. Without a spend requirement
 * every dusting attack becomes an alert, and the feed is worthless.
 */
const MIN_BUY_SOL = 0.05;

/** Stablecoins that also count as payment for a buy. */
const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const MIN_BUY_STABLE_USD = 10;

/** Wrapped SOL — payment, not an acquisition. */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Never announce activity older than this, even after a restart re-seeds. */
const MAX_ALERT_AGE_MS = 30 * 60 * 1000;

/** Signatures already reported, so each is announced exactly once. */
const seen = new Set<string>();
let seeded = false;

interface HeliusTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
  amount?: number;
}
interface HeliusTx {
  signature: string;
  timestamp: number;
  type?: string;
  source?: string;
  description?: string;
  tokenTransfers?: HeliusTransfer[];
  nativeTransfers?: HeliusTransfer[];
}

export interface AlphaEvent {
  kind: "deploy" | "buy";
  wallet: string;
  label: string;
  signature: string;
  timestamp: number;
  mint: string;
  tokenAmount: number;
  solSpent: number;
  stableSpent: number;
}

async function fetchWalletTxs(wallet: string, limit = 50): Promise<HeliusTx[] | null> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key}&limit=${limit}`,
      { signal: AbortSignal.timeout(20_000) }
    );
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j) ? (j as HeliusTx[]) : null;
  } catch {
    return null;
  }
}

/**
 * Classify one transaction for one wallet.
 *
 * Deliberately reads the transfers rather than Helius's `type`. That field says
 * UNKNOWN or TRANSFER for most pump.fun and Raydium activity — 16 of the last
 * 20 transactions on the first watched wallet were UNKNOWN — so keying on
 * `type === "SWAP"` would miss nearly everything.
 */
export function classifyTx(tx: HeliusTx, wallet: string, label: string): AlphaEvent | null {
  const tokensIn = (tx.tokenTransfers ?? []).filter(
    (t) => t.toUserAccount === wallet && t.mint && t.mint !== WSOL_MINT
  );
  if (tokensIn.length === 0) return null;

  const solSpent =
    (tx.nativeTransfers ?? [])
      .filter((n) => n.fromUserAccount === wallet)
      .reduce((s, n) => s + (n.amount ?? 0), 0) / 1e9;

  const stableSpent = (tx.tokenTransfers ?? [])
    .filter((t) => t.fromUserAccount === wallet && t.mint && STABLE_MINTS.has(t.mint))
    .reduce((s, t) => s + (t.tokenAmount ?? 0), 0);

  // A mint the wallet itself created. Reported regardless of spend — a deploy
  // costs almost nothing in SOL and is the highest-value event here.
  const isDeploy =
    tx.type === "TOKEN_MINT" && (tx.description ?? "").toLowerCase().includes("minted");

  const primary = tokensIn.reduce((a, b) => ((b.tokenAmount ?? 0) > (a.tokenAmount ?? 0) ? b : a));

  if (isDeploy) {
    return {
      kind: "deploy",
      wallet,
      label,
      signature: tx.signature,
      timestamp: tx.timestamp,
      mint: primary.mint!,
      tokenAmount: primary.tokenAmount ?? 0,
      solSpent,
      stableSpent,
    };
  }

  // Tokens arriving with nothing paid are dust, not a position.
  if (solSpent < MIN_BUY_SOL && stableSpent < MIN_BUY_STABLE_USD) return null;

  return {
    kind: "buy",
    wallet,
    label,
    signature: tx.signature,
    timestamp: tx.timestamp,
    mint: primary.mint!,
    tokenAmount: primary.tokenAmount ?? 0,
    solSpent,
    stableSpent,
  };
}

interface TokenMarket {
  symbol: string | null;
  name: string | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
}

/** Best-effort market data. An alert must never wait on it. */
async function fetchMarket(mint: string): Promise<TokenMarket> {
  const blank: TokenMarket = { symbol: null, name: null, marketCapUsd: null, liquidityUsd: null, priceUsd: null };
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return blank;
    const j = await res.json();
    const pairs = (j?.pairs ?? []) as Record<string, unknown>[];
    if (!pairs.length) return blank;
    const best = pairs.sort(
      (a, b) =>
        ((b.liquidity as { usd?: number })?.usd ?? 0) - ((a.liquidity as { usd?: number })?.usd ?? 0)
    )[0];
    const base = best.baseToken as { symbol?: string; name?: string };
    return {
      symbol: base?.symbol ?? null,
      name: base?.name ?? null,
      marketCapUsd: (best.marketCap as number) ?? (best.fdv as number) ?? null,
      liquidityUsd: (best.liquidity as { usd?: number })?.usd ?? null,
      priceUsd: best.priceUsd ? parseFloat(String(best.priceUsd)) : null,
    };
  } catch {
    return blank;
  }
}

export function formatAlphaEvent(e: AlphaEvent, m: TokenMarket): string {
  const lines: string[] = [];
  const name = m.name ?? m.symbol ?? "Unknown token";
  const sym = m.symbol ?? "?";

  if (e.kind === "deploy") {
    lines.push(`🧪 <b>Alpha wallet DEPLOYED a token</b>  ·  ⛓ Solana`);
  } else {
    lines.push(`🟢 <b>Alpha wallet BOUGHT</b>  ·  ⛓ Solana`);
  }
  lines.push(`<i>${escapeHtml(e.label)}</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(name)}</b>  ·  <code>$${escapeHtml(sym)}</code>`);

  if (e.kind === "deploy") {
    lines.push(`🏭 Minted ${escapeHtml(formatCompact(e.tokenAmount))} tokens`);
  } else {
    const paid =
      e.solSpent >= MIN_BUY_SOL
        ? `${e.solSpent.toFixed(3)} SOL`
        : `$${formatCompact(e.stableSpent)}`;
    lines.push(`💵 Paid <b>${escapeHtml(paid)}</b> for ${escapeHtml(formatCompact(e.tokenAmount))} ${escapeHtml(sym)}`);
  }
  if (m.marketCapUsd != null) lines.push(`📊 MC ${escapeHtml(formatCompact(m.marketCapUsd))}`);
  if (m.liquidityUsd != null) lines.push(`💧 Liq $${escapeHtml(formatCompact(m.liquidityUsd))}`);

  lines.push("");
  lines.push(`<code>${escapeHtml(e.mint)}</code>`);
  const footer = [
    `🕐 ${escapeHtml(formatTimeAgo(e.timestamp))}`,
    `🔍 <a href="https://solscan.io/tx/${escapeHtml(e.signature)}">Tx</a>`,
    `📈 <a href="https://dexscreener.com/solana/${escapeHtml(e.mint)}">Chart</a>`,
  ];
  const jup = jupiterBuyUrl(e.mint);
  if (jup) footer.push(`🪐 <a href="${jup}">Buy on Jup</a>`);
  lines.push(footer.join("  ·  "));
  lines.push(`👤 <code>${escapeHtml(e.wallet)}</code>`);
  return lines.join("\n");
}

async function send(chatId: string, text: string): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/**
 * One poll over every active Solana alpha wallet.
 *
 * Cost is one Helius request per wallet, so it scales with the watchlist rather
 * than with chain activity. Short-circuits entirely when nothing is watched.
 */
export async function pollSolanaAlphaWallets(): Promise<void> {
  const wallets = await loadAlphaWallets(CHAIN);
  if (wallets.size === 0) return;

  const events: AlphaEvent[] = [];
  for (const w of wallets.values()) {
    const txs = await fetchWalletTxs(w.address);
    // null is a failed fetch, not an empty history — skip this wallet rather
    // than seeding off nothing and replaying its history next pass.
    if (txs === null) continue;
    for (const tx of txs) {
      if (seen.has(tx.signature)) continue;
      const e = classifyTx(tx, w.address, w.label);
      if (e) events.push(e);
      else seen.add(tx.signature); // uninteresting — never look again
    }
  }

  if (!seeded) {
    for (const e of events) seen.add(e.signature);
    seeded = true;
    console.log(`[solana-alpha] seeded ${events.length} existing events across ${wallets.size} wallet(s)`);
    return;
  }

  // Oldest-first so a burst reads in the order it happened.
  events.sort((a, b) => a.timestamp - b.timestamp);

  for (const e of events) {
    seen.add(e.signature);

    const age = Date.now() - e.timestamp * 1000;
    if (age > MAX_ALERT_AGE_MS) {
      console.log(`[solana-alpha] skipping stale ${e.kind} by ${e.label} (${Math.round(age / 60000)}m old)`);
      continue;
    }

    const market = await fetchMarket(e.mint);
    try {
      const text = formatAlphaEvent(e, market);
      await broadcastAlert(FEATURE.ALPHA_SOLANA, (chatId) => send(chatId, text));
      console.log(`[solana-alpha] alerted ${e.kind} by ${e.label}: ${market.symbol ?? e.mint.slice(0, 8)}`);
    } catch (err) {
      console.error("[solana-alpha] failed to send alert:", err);
    }
  }

  if (seen.size > 5000) seen.clear();
}

/** Manual test: render this wallet's most recent qualifying event. */
export async function sendSolanaAlphaTestPing(chatId: string): Promise<boolean> {
  const wallets = await loadAlphaWallets(CHAIN);
  for (const w of wallets.values()) {
    const txs = await fetchWalletTxs(w.address);
    for (const tx of txs ?? []) {
      const e = classifyTx(tx, w.address, w.label);
      if (!e) continue;
      const m = await fetchMarket(e.mint);
      await send(chatId, formatAlphaEvent(e, m));
      return true;
    }
  }
  return false;
}
