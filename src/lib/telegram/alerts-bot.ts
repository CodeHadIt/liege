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
//   ALERTS_PLATINUM_IDS            — chat IDs receiving EVERY feed (the owner)
//   ALERTS_GOLD_IDS                — chat IDs receiving the shared feeds only
//   ALERTS_ALLOWLIST               — legacy single-tier list. When the tier vars
//                                    are unset, everyone on it is treated as
//                                    PLATINUM, so behaviour is unchanged until
//                                    tiers are configured. Falls back in turn to
//                                    the legacy per-source *_ALERT_CHAT_ID vars.

function parseIds(s: string | undefined): string[] {
  return (s ?? "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ── Tiers ─────────────────────────────────────────────────────────────────────

export type Tier = "platinum" | "gold";

/**
 * Every gated feed. A feature id is what a caller asks to broadcast to — no feed
 * resolves chat IDs itself, which is what keeps the tier rules in one place.
 */
export const FEATURE = {
  /** Launch feeds — shared by every tier. */
  LAUNCH: "launch",
  /** Alpha confluence over the frozen wallet library — Gold's view. */
  ALPHA_CONFLUENCE_GOLD: "alpha.confluence.gold",
  /** Alpha confluence over ALL wallets, newly promoted ones included. */
  ALPHA_CONFLUENCE_PLATINUM: "alpha.confluence.platinum",
  /** Daily $2M ATH digest, and the wallet-promotion announcement inside it. */
  ATH_DAILY: "ath.daily",
  /** Alpha deployer (dev wallet) launches. */
  DEPLOYER: "deployer",
  /**
   * Solana alpha wallets — deploys and buys by hand-picked wallets.
   *
   * Platinum-only, matching the rule that a newly added alpha wallet is not
   * shared. Move to ["platinum","gold"] below to open it up.
   */
  ALPHA_SOLANA: "alpha.solana",
} as const;

export type Feature = (typeof FEATURE)[keyof typeof FEATURE];

/**
 * Which tiers receive which feature.
 *
 * The two alpha entries are deliberately disjoint: each tier gets its OWN
 * evaluation of the confluence state machine (Gold's counts only library
 * wallets), so sending both to Platinum would double-report the same token.
 */
const FEATURE_TIERS: Record<Feature, readonly Tier[]> = {
  [FEATURE.LAUNCH]: ["platinum", "gold"],
  [FEATURE.ALPHA_CONFLUENCE_GOLD]: ["gold"],
  [FEATURE.ALPHA_CONFLUENCE_PLATINUM]: ["platinum"],
  [FEATURE.ATH_DAILY]: ["platinum"],
  [FEATURE.DEPLOYER]: ["platinum"],
  [FEATURE.ALPHA_SOLANA]: ["platinum"],
};

/**
 * chat ID → tier. An ID listed in both vars resolves to platinum, so a mistake
 * in config can never silently demote the owner.
 */
export function subscriberTiers(): Map<string, Tier> {
  const platinum = parseIds(process.env.ALERTS_PLATINUM_IDS);
  const gold = parseIds(process.env.ALERTS_GOLD_IDS);

  const out = new Map<string, Tier>();
  // No tier config at all → preserve today's behaviour exactly: one list, and
  // everyone on it sees everything. Never leaves recipients silently downgraded.
  if (platinum.length === 0 && gold.length === 0) {
    for (const id of legacyRecipients()) out.set(id, "platinum");
    return out;
  }
  for (const id of gold) out.set(id, "gold");
  for (const id of platinum) out.set(id, "platinum"); // platinum wins
  return out;
}

export function tierOf(id: string | number | undefined): Tier | null {
  if (id == null) return null;
  return subscriberTiers().get(String(id)) ?? null;
}

/** Chat IDs entitled to a given feature. The ONLY way a feed reaches a chat. */
export function recipientsFor(feature: Feature): string[] {
  const tiers = FEATURE_TIERS[feature];
  if (!tiers) {
    console.error(`[alerts] unknown feature "${feature}" — refusing to send`);
    return [];
  }
  const out: string[] = [];
  for (const [id, tier] of subscriberTiers()) {
    if (tiers.includes(tier)) out.push(id);
  }
  return out;
}

/** The pre-tier list, kept as the fallback source for `subscriberTiers`. */
function legacyRecipients(): string[] {
  const master = parseIds(process.env.ALERTS_ALLOWLIST);
  if (master.length) return [...new Set(master)];
  const legacy = [
    ...parseIds(process.env.STONKFUN_ALERT_CHAT_ID),
    ...parseIds(process.env.LONG_ALERT_CHAT_ID),
    ...parseIds(process.env.SUNRISE_ALERT_CHAT_ID),
  ];
  return [...new Set(legacy)];
}

/**
 * Everyone permitted to *use* the bot, across all tiers — the interaction gate,
 * not a delivery list.
 *
 * Feeds must NOT call this. Delivery goes through `recipientsFor(feature)`, so
 * that a new feed cannot reach a chat without declaring which tiers may see it.
 */
export function alertRecipients(): string[] {
  return [...subscriberTiers().keys()];
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

    /**
     * Commands a stranger is allowed to reach, so they can be told where they
     * stand and find their own ID to send on. Every other update from a
     * non-allow-listed chat is dropped without a reply.
     */
    const OPEN_COMMANDS = /^\/(start|status|id|help)(@[\w]+)?(\s|$)/i;

    bot.use(async (ctx, next) => {
      const id = ctx.chat?.id ?? ctx.from?.id;
      if (isAllowed(id)) return next();
      // Handlers below answer strangers themselves, so the refusal wording lives
      // in one place per command rather than being duplicated here.
      if (OPEN_COMMANDS.test(ctx.message?.text ?? "")) return next();
      // no next() → drop the update
    });

    // No feed list and no tier wording in any reply below. What the bot can do,
    // and that access has levels at all, are not a stranger's business — and a
    // Gold user must not be able to infer that other feeds exist.

    bot.command("start", async (ctx) => {
      const id = ctx.chat?.id ?? ctx.from?.id;
      if (isAllowed(id)) {
        await ctx.reply(
          `✅ <b>You are on the allowlist.</b>\n\n` +
            `You will now start receiving on-chain alerts.`,
          { parse_mode: "HTML" }
        );
        return;
      }
      await ctx.reply(
        `⛔ <b>You cannot start using this bot unless you are on the allowlist.</b>\n\n` +
          `Your Telegram ID: <code>${id ?? "unknown"}</code>\n` +
          `Send it to the owner to request access.`,
        { parse_mode: "HTML" }
      );
    });

    bot.command("status", async (ctx) => {
      const id = ctx.chat?.id ?? ctx.from?.id;
      if (isAllowed(id)) {
        await ctx.reply(
          `✅ <b>You are allowed to use this bot.</b>\n\n` +
            `On-chain alerts are being delivered to this chat.`,
          { parse_mode: "HTML" }
        );
        return;
      }
      await ctx.reply(
        `⛔ <b>You do not have permission to use this bot.</b>\n\n` +
          `Your Telegram ID: <code>${id ?? "unknown"}</code>\n` +
          `Send it to the owner to request access.`,
        { parse_mode: "HTML" }
      );
    });

    bot.command("help", async (ctx) => {
      await ctx.reply(
        `<b>Liège Alerts</b> — private alert feed.\n\n` +
          `/start — check your access and begin receiving alerts\n` +
          `/status — whether you are allowed to use this bot\n` +
          `/id — show your Telegram ID\n` +
          `/help — this message`,
        { parse_mode: "HTML" }
      );
    });

    bot.command("id", async (ctx) => {
      await ctx.reply(`Your Telegram ID: <code>${ctx.chat?.id ?? ctx.from?.id}</code>`, {
        parse_mode: "HTML",
      });
    });

    return bot;
  })();

  return _alertsBotPromise;
}

// ── Broadcast helper ──────────────────────────────────────────────────────────
let _warnedNoToken = false;

/**
 * Send an alert to every recipient entitled to `feature`. `send` builds and
 * delivers the message for one chat ID (so callers keep their photo/text
 * fallback logic). No-ops (with a one-time warning) when the alerts bot isn't
 * configured, and isolates per-recipient failures so one bad chat can't block
 * the rest.
 *
 * The feature argument is mandatory: it is the single point where tier rules are
 * applied, so a feed cannot reach a chat without stating who may see it.
 */
export async function broadcastAlert(
  feature: Feature,
  send: (chatId: string) => Promise<void>
): Promise<void> {
  if (!hasAlertsBot()) {
    if (!_warnedNoToken) {
      console.warn("[alerts] TELEGRAM_ALERTS_API_KEY not set — alert pings disabled");
      _warnedNoToken = true;
    }
    return;
  }
  if (subscriberTiers().size === 0) {
    if (!_warnedNoToken) {
      console.warn("[alerts] no recipients — set ALERTS_PLATINUM_IDS / ALERTS_GOLD_IDS (or ALERTS_ALLOWLIST)");
      _warnedNoToken = true;
    }
    return;
  }
  const ids = recipientsFor(feature);
  if (ids.length === 0) return; // nobody is entitled to this feed — not an error
  for (const id of ids) {
    try {
      await send(id);
    } catch (err) {
      console.error("[alerts] failed to send to", id, err);
    }
  }
}
