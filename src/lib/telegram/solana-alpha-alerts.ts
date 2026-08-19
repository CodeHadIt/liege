import { loadAlphaWallets } from "@/lib/api/alpha-wallets";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { escapeHtml, formatCompact, formatTimeAgo, jupiterBuyUrl } from "./utils/format";

// ── Solana alpha wallet watcher ──────────────────────────────────────────────
//
// Watches hand-picked Solana wallets and reports what they DO, which on this
// chain is two different things:
//
//   DEPLOY    — mints a new token. For a dev wallet this is the whole signal.
//   LIQUIDITY — pairs a token with SOL to open a pool.
//   BUY/SELL  — acquires or disposes of a token for value.
//   BURN      — destroys supply.
//   SENT      — moves tokens out for nothing in return.
//   RECEIVED  — tokens arrive for nothing. The only kind that must prove itself
//               real, because this is where dusting lives.
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
const MIN_TRADE_SOL = 0.05;

/** Stablecoins that also count as payment for a buy. */
const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const MIN_TRADE_STABLE_USD = 10;

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

export type AlphaEventKind =
  | "deploy"
  | "liquidity"
  | "buy"
  | "sell"
  | "burn"
  | "sent"
  | "received";

export interface AlphaEvent {
  kind: AlphaEventKind;
  wallet: string;
  label: string;
  signature: string;
  timestamp: number;
  mint: string;
  tokenAmount: number;
  /** SOL paid out by the wallet in this tx. */
  solSpent: number;
  /** SOL received by the wallet in this tx. */
  solReceived: number;
  stableSpent: number;
  /** Counterparty for a plain send. */
  counterparty: string | null;
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
 * Reads the transfers rather than Helius's `type`, which reports UNKNOWN or
 * TRANSFER for most pump.fun and Raydium activity — 16 of the last 20
 * transactions on the first watched wallet were UNKNOWN, including its token
 * deploy. Keying on `type === "SWAP"` would miss nearly everything.
 *
 * Order matters: a pool seed also looks like a send, and a sale also looks like
 * a send, so the more specific readings are tested first.
 */
export function classifyTx(tx: HeliusTx, wallet: string, label: string): AlphaEvent | null {
  const transfers = tx.tokenTransfers ?? [];
  const tokensIn = transfers.filter((t) => t.toUserAccount === wallet && t.mint && t.mint !== WSOL_MINT);
  const tokensOut = transfers.filter((t) => t.fromUserAccount === wallet && t.mint && t.mint !== WSOL_MINT);
  const wsolOut = transfers.filter((t) => t.fromUserAccount === wallet && t.mint === WSOL_MINT);

  const solSpent =
    (tx.nativeTransfers ?? []).filter((n) => n.fromUserAccount === wallet).reduce((s, n) => s + (n.amount ?? 0), 0) / 1e9;
  const solReceived =
    (tx.nativeTransfers ?? []).filter((n) => n.toUserAccount === wallet).reduce((s, n) => s + (n.amount ?? 0), 0) / 1e9;
  const stableSpent = transfers
    .filter((t) => t.fromUserAccount === wallet && t.mint && STABLE_MINTS.has(t.mint))
    .reduce((s, t) => s + (t.tokenAmount ?? 0), 0);
  const stableReceived = transfers
    .filter((t) => t.toUserAccount === wallet && t.mint && STABLE_MINTS.has(t.mint))
    .reduce((s, t) => s + (t.tokenAmount ?? 0), 0);

  const biggest = (list: HeliusTransfer[]) =>
    list.reduce((a, b) => ((b.tokenAmount ?? 0) > (a.tokenAmount ?? 0) ? b : a));

  const base = { wallet, label, signature: tx.signature, timestamp: tx.timestamp, solSpent, solReceived, stableSpent };
  const desc = (tx.description ?? "").toLowerCase();

  // 1. Deploy — the wallet minted a token. Reported regardless of spend: it
  //    costs almost nothing in SOL and is the highest-value event here.
  if (tx.type === "TOKEN_MINT" && desc.includes("minted") && tokensIn.length > 0) {
    const t = biggest(tokensIn);
    return { ...base, kind: "deploy", mint: t.mint!, tokenAmount: t.tokenAmount ?? 0, counterparty: null };
  }

  // 2. Burn.
  if (tx.type === "BURN" || desc.includes("burned")) {
    const list = tokensOut.length ? tokensOut : tokensIn;
    if (list.length) {
      const t = biggest(list);
      return { ...base, kind: "burn", mint: t.mint!, tokenAmount: t.tokenAmount ?? 0, counterparty: null };
    }
  }

  // 3. Liquidity seeding — wrapped SOL AND a token leaving together is a pool
  //    being funded, not two coincidental sends. This is how CyberLeek's pool
  //    was created: 330 WSOL + 730M tokens in one transaction.
  if (wsolOut.length > 0 && tokensOut.length > 0) {
    const t = biggest(tokensOut);
    const wsol = wsolOut.reduce((s, w) => s + (w.tokenAmount ?? 0), 0);
    return {
      ...base,
      kind: "liquidity",
      mint: t.mint!,
      tokenAmount: t.tokenAmount ?? 0,
      solSpent: Math.max(solSpent, wsol),
      counterparty: null,
    };
  }

  // 4. Sale — a token left and value came back.
  if (tokensOut.length > 0 && (solReceived >= MIN_TRADE_SOL || stableReceived >= MIN_TRADE_STABLE_USD)) {
    const t = biggest(tokensOut);
    return { ...base, kind: "sell", mint: t.mint!, tokenAmount: t.tokenAmount ?? 0, counterparty: null };
  }

  // 5. Buy — a token arrived and value went out.
  if (tokensIn.length > 0 && (solSpent >= MIN_TRADE_SOL || stableSpent >= MIN_TRADE_STABLE_USD)) {
    const t = biggest(tokensIn);
    return { ...base, kind: "buy", mint: t.mint!, tokenAmount: t.tokenAmount ?? 0, counterparty: null };
  }

  // 6. Plain send out — no value returned.
  if (tokensOut.length > 0) {
    const t = biggest(tokensOut);
    const to = transfers.find((x) => x.fromUserAccount === wallet && x.mint === t.mint)?.toUserAccount ?? null;
    return { ...base, kind: "sent", mint: t.mint!, tokenAmount: t.tokenAmount ?? 0, counterparty: to };
  }

  // 7. Received for nothing. This is where dusting lives, so it is the one kind
  //    gated on the token being real — see shouldReport.
  if (tokensIn.length > 0) {
    const t = biggest(tokensIn);
    const from = transfers.find((x) => x.toUserAccount === wallet && x.mint === t.mint)?.fromUserAccount ?? null;
    return { ...base, kind: "received", mint: t.mint!, tokenAmount: t.tokenAmount ?? 0, counterparty: from };
  }

  return null;
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

/**
 * Minimum pool depth for a token nobody paid for to be worth reporting.
 *
 * Spam arrives as a free transfer of a token with no real market. Anything the
 * wallet PAID for, deployed, seeded, sold or burnt is reported regardless of
 * depth — the wallet's own money or supply makes it intentional. Only the
 * "arrived for nothing" case has to prove the token is real.
 */
const MIN_RECEIVED_LIQUIDITY_USD = 5_000;

/** Whether an event survives the spam filter. */
export function shouldReport(e: AlphaEvent, m: TokenMarket): boolean {
  if (e.kind !== "received") return true;
  return (m.liquidityUsd ?? 0) >= MIN_RECEIVED_LIQUIDITY_USD;
}

const KIND_HEADLINE: Record<AlphaEventKind, string> = {
  deploy: "🧪 <b>Alpha wallet DEPLOYED a token</b>",
  liquidity: "🌊 <b>Alpha wallet SEEDED liquidity</b>",
  buy: "🟢 <b>Alpha wallet BOUGHT</b>",
  sell: "🔴 <b>Alpha wallet SOLD</b>",
  burn: "🔥 <b>Alpha wallet BURNT tokens</b>",
  sent: "📤 <b>Alpha wallet SENT tokens</b>",
  received: "📥 <b>Alpha wallet RECEIVED tokens</b>",
};

export function formatAlphaEvent(e: AlphaEvent, m: TokenMarket): string {
  const lines: string[] = [];
  const name = m.name ?? m.symbol ?? "Unknown token";
  const sym = m.symbol ?? "?";
  const amt = formatCompact(e.tokenAmount);

  lines.push(`${KIND_HEADLINE[e.kind]}  ·  ⛓ Solana`);
  lines.push(`<i>${escapeHtml(e.label)}</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(name)}</b>  ·  <code>$${escapeHtml(sym)}</code>`);

  switch (e.kind) {
    case "deploy":
      lines.push(`🏭 Minted ${escapeHtml(amt)} tokens`);
      break;
    case "liquidity":
      lines.push(`🌊 Paired ${escapeHtml(amt)} ${escapeHtml(sym)} with <b>${e.solSpent.toFixed(2)} SOL</b>`);
      break;
    case "buy":
      lines.push(
        `💵 Paid <b>${e.solSpent >= MIN_TRADE_SOL ? `${e.solSpent.toFixed(3)} SOL` : `$${formatCompact(e.stableSpent)}`}</b>` +
          ` for ${escapeHtml(amt)} ${escapeHtml(sym)}`
      );
      break;
    case "sell":
      lines.push(`💰 Sold ${escapeHtml(amt)} ${escapeHtml(sym)} for <b>${e.solReceived.toFixed(3)} SOL</b>`);
      break;
    case "burn":
      lines.push(`🔥 Burnt ${escapeHtml(amt)} ${escapeHtml(sym)}`);
      break;
    case "sent":
      lines.push(`📤 Sent ${escapeHtml(amt)} ${escapeHtml(sym)}`);
      if (e.counterparty) lines.push(`➡️ <code>${escapeHtml(e.counterparty)}</code>`);
      break;
    case "received":
      lines.push(`📥 Received ${escapeHtml(amt)} ${escapeHtml(sym)}`);
      if (e.counterparty) lines.push(`⬅️ <code>${escapeHtml(e.counterparty)}</code>`);
      break;
  }

  if (m.marketCapUsd != null) lines.push(`📊 MC $${escapeHtml(formatCompact(m.marketCapUsd))}`);
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
    if (!shouldReport(e, market)) {
      console.log(`[solana-alpha] suppressed spam ${e.kind} for ${e.label}: ${e.mint.slice(0, 8)}… (liq $${Math.round(market.liquidityUsd ?? 0)})`);
      continue;
    }
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
