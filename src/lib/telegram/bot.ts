import { Bot, session } from "grammy";
import type { Context, SessionFlavor } from "grammy";
import type { ChainId } from "@/types/chain";
import { detectChainFromAddress } from "@/lib/chains/registry";

// ── Session ──────────────────────────────────────────────────────────────────

export interface SessionData {
  ctFlow?: {
    step: "awaiting_addresses";
    chain: ChainId;
  };
}

export type MyContext = Context & SessionFlavor<SessionData>;

// ── Lazy singleton — bot is created on first request, not at module load ──────
// This prevents Next.js build from failing when env vars are only available
// at runtime (Railway injects them at container start, not during `npm build`).

let _bot: Bot<MyContext> | null = null;

export function getBot(): Bot<MyContext> {
  if (_bot) return _bot;

  const token = process.env.TELEGRAM_API_KEY;
  if (!token) throw new Error("TELEGRAM_API_KEY is not set");

  const bot = new Bot<MyContext>(token);
  bot.use(session({ initial: (): SessionData => ({}) }));

  // ── /start ──────────────────────────────────────────────────────────────────

  bot.command("start", async (ctx) => {
    await ctx.reply(
      `👋 Welcome to <b>Liège</b> — on-chain alpha, straight to Telegram.\n\n` +
        `<b>Commands:</b>\n` +
        `/token &lt;address&gt; — full token analysis\n` +
        `/holders &lt;address&gt; — top 20 holders\n` +
        `/toptraders &lt;address&gt; — top traders with PnL\n` +
        `/ct — find common top traders across 2–10 tokens\n` +
        `/dexpaid — browse DEX Paid pump.fun profiles\n` +
        `/help — show this message\n\n` +
        `<i>Supports Solana, Base, and BSC.</i>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `<b>Liège Bot Commands</b>\n\n` +
        `<b>/token</b> <code>&lt;address&gt;</code>\n` +
        `Full token analysis — price, market cap, liquidity, DD score, safety flags.\n\n` +
        `<b>/holders</b> <code>&lt;address&gt;</code>\n` +
        `Top 20 holders with % ownership.\n\n` +
        `<b>/toptraders</b> <code>&lt;address&gt;</code>\n` +
        `Top traders with realized PnL and trade counts.\n\n` +
        `<b>/ct</b>\n` +
        `Find wallets that traded 2–10 tokens in common. Great for finding smart money.\n\n` +
        `<b>/dexpaid</b>\n` +
        `Browse pump.fun tokens that have paid for a DexScreener profile.\n\n` +
        `<i>Solana addresses are detected automatically. For Base/BSC, you'll be prompted to choose.</i>`,
      { parse_mode: "HTML" }
    );
  });

  // ── /token ──────────────────────────────────────────────────────────────────

  bot.command("token", async (ctx) => {
    const { handleToken } = await import("./commands/token");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply("Usage: /token <code>&lt;address&gt;</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    const chain = detectChainFromAddress(address);
    if (!chain) {
      await ctx.reply("❌ Could not detect chain from this address.");
      return;
    }
    if (chain === "base") {
      const { evmChainKeyboard } = await import("./utils/keyboards");
      await ctx.reply(
        `🔵/🟡 This looks like an EVM address. Which chain?\n<code>${address}</code>`,
        { parse_mode: "HTML", reply_markup: evmChainKeyboard("token", address) }
      );
      return;
    }
    await handleToken(ctx, chain, address);
  });

  // ── /holders ─────────────────────────────────────────────────────────────────

  bot.command("holders", async (ctx) => {
    const { handleHolders } = await import("./commands/holders");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply("Usage: /holders <code>&lt;address&gt;</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    const chain = detectChainFromAddress(address);
    if (!chain) {
      await ctx.reply("❌ Could not detect chain from this address.");
      return;
    }
    if (chain === "base") {
      const { evmChainKeyboard } = await import("./utils/keyboards");
      await ctx.reply(
        `🔵/🟡 Which chain is this token on?\n<code>${address}</code>`,
        { parse_mode: "HTML", reply_markup: evmChainKeyboard("holders", address) }
      );
      return;
    }
    await handleHolders(ctx, chain, address);
  });

  // ── /toptraders ───────────────────────────────────────────────────────────────

  bot.command("toptraders", async (ctx) => {
    const { handleTopTraders } = await import("./commands/toptraders");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply("Usage: /toptraders <code>&lt;address&gt;</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    const chain = detectChainFromAddress(address);
    if (!chain) {
      await ctx.reply("❌ Could not detect chain from this address.");
      return;
    }
    if (chain === "base") {
      const { evmChainKeyboard } = await import("./utils/keyboards");
      await ctx.reply(
        `🔵/🟡 Which chain is this token on?\n<code>${address}</code>`,
        { parse_mode: "HTML", reply_markup: evmChainKeyboard("toptraders", address) }
      );
      return;
    }
    await handleTopTraders(ctx, chain, address);
  });

  // ── /ct ───────────────────────────────────────────────────────────────────────

  bot.command("ct", async (ctx) => {
    const { promptCtChain } = await import("./commands/ct");
    await promptCtChain(ctx);
  });

  // ── /dexpaid ──────────────────────────────────────────────────────────────────

  bot.command("dexpaid", async (ctx) => {
    const { promptDexPaidPeriod } = await import("./commands/dexpaid");
    await promptDexPaidPeriod(ctx);
  });

  // ── Callback query router ─────────────────────────────────────────────────────

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // ct:chain:{chain}
    if (data.startsWith("ct:chain:")) {
      const { handleCtChainSelected } = await import("./commands/ct");
      const chain = data.slice("ct:chain:".length) as ChainId;
      await handleCtChainSelected(ctx, chain);
      return;
    }

    // dexpaid:{period}
    if (data.startsWith("dexpaid:")) {
      const { handleDexPaid } = await import("./commands/dexpaid");
      const period = data.slice("dexpaid:".length);
      await handleDexPaid(ctx, period);
      return;
    }

    // evm:{command}:{chain}:{address}
    if (data.startsWith("evm:")) {
      const parts = data.split(":");
      const command = parts[1];
      const chain = parts[2] as ChainId;
      const address = parts.slice(3).join(":");

      await ctx.answerCallbackQuery();

      if (command === "token") {
        const { handleToken } = await import("./commands/token");
        await handleToken(ctx, chain, address);
      } else if (command === "holders") {
        const { handleHolders } = await import("./commands/holders");
        await handleHolders(ctx, chain, address);
      } else if (command === "toptraders") {
        const { handleTopTraders } = await import("./commands/toptraders");
        await handleTopTraders(ctx, chain, address);
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // ── Text message handler (multi-step flows) ───────────────────────────────────

  bot.on("message:text", async (ctx) => {
    if (ctx.session.ctFlow?.step === "awaiting_addresses") {
      const { handleCtAddresses } = await import("./commands/ct");
      await handleCtAddresses(ctx, ctx.message.text);
    }
  });

  _bot = bot;
  return _bot;
}
