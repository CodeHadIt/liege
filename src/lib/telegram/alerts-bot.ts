import { Bot } from "grammy";
import type { Context } from "grammy";

// ── Liège Alerts — a private sister bot dedicated to push alerts ───────────────
// The main Liège bot (see ./bot.ts) handles interactive commands. This second
// bot exists only to broadcast the alert feeds (StonkFun/Solana, Robinhood
// launchpads, and future chains) to an allow-list of users. It is private: only
// allow-listed chat IDs may interact with it or receive its pings.
//
// Env:
//   TELEGRAM_ALERTS_API_KEY        — the Liège Alerts bot token (from BotFather)
//   TELEGRAM_ALERTS_WEBHOOK_SECRET — optional webhook secret-token check
//   ALERTS_ALLOWLIST               — comma/space-separated chat IDs allowed to
//                                    use the bot and receive alerts. Falls back
//                                    to the legacy per-source *_ALERT_CHAT_ID
//                                    vars for backward compatibility.

function parseIds(s: string | undefined): string[] {
  return (s ?? "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * The allow-list: chat IDs permitted to use the bot AND receive alerts. A single
 * source of truth for "who can use Liège Alerts". `ALERTS_ALLOWLIST` is
 * authoritative; otherwise we fall back to the legacy single-target env vars so
 * existing deployments keep working after the split.
 */
export function alertRecipients(): string[] {
  const master = parseIds(process.env.ALERTS_ALLOWLIST);
  if (master.length) return [...new Set(master)];
  const legacy = [
    ...parseIds(process.env.STONKFUN_ALERT_CHAT_ID),
    ...parseIds(process.env.LONG_ALERT_CHAT_ID),
    ...parseIds(process.env.SUNRISE_ALERT_CHAT_ID),
  ];
  return [...new Set(legacy)];
}

export function isAllowed(id: string | number | undefined): boolean {
  if (id == null) return false;
  return alertRecipients().includes(String(id));
}

/** Whether the alerts bot is configured (token present). */
export function hasAlertsBot(): boolean {
  return !!process.env.TELEGRAM_ALERTS_API_KEY;
}

// ── Lazy singleton (same rationale as the main bot: env is runtime-only) ───────
let _alertsBotPromise: Promise<Bot<Context>> | null = null;

export async function getAlertsBot(): Promise<Bot<Context>> {
  if (_alertsBotPromise) return _alertsBotPromise;

  _alertsBotPromise = (async () => {
    const token = process.env.TELEGRAM_ALERTS_API_KEY;
    if (!token) throw new Error("TELEGRAM_ALERTS_API_KEY is not set");

    const bot = new Bot<Context>(token);

    // Allow-list gate: anyone not on the list is politely rejected and told
    // their own ID, so the owner can add them. Non-allowed updates are dropped.
    bot.use(async (ctx, next) => {
      const id = ctx.chat?.id ?? ctx.from?.id;
      if (isAllowed(id)) return next();
      if (ctx.chat) {
        await ctx
          .reply(
            `⛔ <b>Liège Alerts</b> is private.\n\n` +
              `Your Telegram ID: <code>${id ?? "unknown"}</code>\n` +
              `Ask the owner to add you to the allow-list.`,
            { parse_mode: "HTML" }
          )
          .catch(() => {});
      }
      // no next() → drop the update
    });

    bot.command("start", async (ctx) => {
      await ctx.reply(
        `🔔 <b>Liège Alerts</b>\n\n` +
          `You'll receive live pings for new launches across supported chains:\n` +
          `• 📈 StonkFun (Solana) — new stock &amp; on-chain quote assets, plus the first token launched against each\n` +
          `• 🌅 Sunrise (Solana) — new stock pairs\n` +
          `• 🟢 Robinhood Chain — new stocks and the first token vs each, with the launchpad (Long, Flap, Pons, Uniswap…)\n` +
          `• 🟡 BNB Chain — new tokenized-stock quotes on Four.meme &amp; Flap, plus the first token launched against each\n\n` +
          `Flap runs on both BNB Chain and Robinhood Chain, so its alerts always name the chain.\n\n` +
          `More chains &amp; platforms coming. This bot is private — use /status any time.`,
        { parse_mode: "HTML" }
      );
    });

    bot.command("help", async (ctx) => {
      await ctx.reply(
        `<b>Liège Alerts</b> — private alert feed.\n\n` +
          `/status — show what's active and who's on the allow-list\n` +
          `/id — show your Telegram ID\n` +
          `/help — this message`,
        { parse_mode: "HTML" }
      );
    });

    bot.command("id", async (ctx) => {
      await ctx.reply(`Your Telegram ID: <code>${ctx.chat?.id}</code>`, { parse_mode: "HTML" });
    });

    bot.command("status", async (ctx) => {
      const ids = alertRecipients();
      await ctx.reply(
        `✅ <b>Liège Alerts is running.</b>\n\n` +
          `Recipients on allow-list: <b>${ids.length}</b>\n` +
          `Feeds: StonkFun · Sunrise · Robinhood Chain · BNB Chain (Four.meme, Flap)\n` +
          `Every feed pings on a new pairing asset, then on the first token launched against it.\n` +
          `<i>Push-only — nothing you send is acted on beyond these commands.</i>`,
        { parse_mode: "HTML" }
      );
    });

    return bot;
  })();

  return _alertsBotPromise;
}

// ── Broadcast helper ──────────────────────────────────────────────────────────
let _warnedNoToken = false;

/**
 * Send an alert to every allow-listed recipient. `send` builds and delivers the
 * message for one chat ID (so callers keep their photo/text fallback logic).
 * No-ops (with a one-time warning) when the alerts bot isn't configured, and
 * isolates per-recipient failures so one bad chat can't block the rest.
 */
export async function broadcastAlert(send: (chatId: string) => Promise<void>): Promise<void> {
  if (!hasAlertsBot()) {
    if (!_warnedNoToken) {
      console.warn("[alerts] TELEGRAM_ALERTS_API_KEY not set — alert pings disabled");
      _warnedNoToken = true;
    }
    return;
  }
  const ids = alertRecipients();
  if (ids.length === 0) {
    if (!_warnedNoToken) {
      console.warn("[alerts] no recipients — set ALERTS_ALLOWLIST (or a *_ALERT_CHAT_ID)");
      _warnedNoToken = true;
    }
    return;
  }
  for (const id of ids) {
    try {
      await send(id);
    } catch (err) {
      console.error("[alerts] failed to send to", id, err);
    }
  }
}
