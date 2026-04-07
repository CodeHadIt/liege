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
// Uses a promise-based singleton so concurrent requests don't double-init.

let _botPromise: Promise<Bot<MyContext>> | null = null;

export async function getBot(): Promise<Bot<MyContext>> {
  if (_botPromise) return _botPromise;

  _botPromise = (async () => {
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
    const { handleToken, detectEvmChain } = await import("./commands/token");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply("Usage: /token <code>&lt;address&gt;</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    // detectChainFromAddress returns "base" for any 0x address as a placeholder
    const rawChain = detectChainFromAddress(address);
    if (!rawChain) {
      await ctx.reply("❌ Could not detect chain from this address.");
      return;
    }
    // For EVM addresses auto-detect Base vs BSC via DexScreener liquidity check
    const chain = rawChain === "base" ? await detectEvmChain(address) : rawChain;
    await handleToken(ctx, chain, address);
  });

  // ── /holders ─────────────────────────────────────────────────────────────────

  bot.command("holders", async (ctx) => {
    const { handleHolders } = await import("./commands/holders");
    const { detectEvmChain } = await import("./commands/token");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply("Usage: /holders <code>&lt;address&gt;</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    const rawChain = detectChainFromAddress(address);
    if (!rawChain) {
      await ctx.reply("❌ Could not detect chain from this address.");
      return;
    }
    const chain = rawChain === "base" ? await detectEvmChain(address) : rawChain;
    await handleHolders(ctx, chain, address);
  });

  // ── /toptraders ───────────────────────────────────────────────────────────────

  bot.command("toptraders", async (ctx) => {
    const { handleTopTraders } = await import("./commands/toptraders");
    const { detectEvmChain } = await import("./commands/token");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply("Usage: /toptraders <code>&lt;address&gt;</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    const rawChain = detectChainFromAddress(address);
    if (!rawChain) {
      await ctx.reply("❌ Could not detect chain from this address.");
      return;
    }
    const chain = rawChain === "base" ? await detectEvmChain(address) : rawChain;
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
    const msgId = ctx.callbackQuery.message?.message_id;

    // rt:{chain}:{address} — refresh token analysis in-place
    if (data.startsWith("rt:")) {
      await ctx.answerCallbackQuery();
      const rest  = data.slice("rt:".length);
      const colon = rest.indexOf(":");
      const chain   = rest.slice(0, colon) as ChainId;
      const address = rest.slice(colon + 1);
      const { handleToken } = await import("./commands/token");
      await handleToken(ctx, chain, address, msgId);
      return;
    }

    // del — delete the message containing this keyboard
    if (data === "del") {
      await ctx.answerCallbackQuery();
      if (msgId) {
        await ctx.api.deleteMessage(ctx.chat!.id, msgId).catch(() => null);
      }
      return;
    }

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

    await ctx.answerCallbackQuery();
  });

  // ── Text message handler ──────────────────────────────────────────────────────
  // Handles multi-step flows AND bare address pastes (no command needed).

  const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const EVM_ADDR    = /^0x[a-fA-F0-9]{40}$/;

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    // CT flow takes highest priority
    if (ctx.session.ctFlow?.step === "awaiting_addresses") {
      const { handleCtAddresses } = await import("./commands/ct");
      await handleCtAddresses(ctx, text);
      return;
    }

    // Ignore slash commands — let their own handlers deal with them
    if (text.startsWith("/")) return;

    // Auto-analyze bare Solana address
    if (SOLANA_ADDR.test(text)) {
      const { handleToken } = await import("./commands/token");
      await handleToken(ctx, "solana", text);
      return;
    }

    // Auto-analyze bare EVM address (auto-detect Base vs BSC)
    if (EVM_ADDR.test(text)) {
      const { handleToken, detectEvmChain } = await import("./commands/token");
      const chain = await detectEvmChain(text);
      await handleToken(ctx, chain, text);
      return;
    }
  });

  // ── Init: fetch bot identity + register command suggestions ──────────────────

    await bot.init();
    console.log("[telegram/bot] Initialized as @" + bot.botInfo.username);

    // Register commands so they appear as suggestions when users type "/"
    await bot.api.setMyCommands([
      { command: "token",      description: "Analyze a token — price, MC, DD score, safety" },
      { command: "holders",    description: "Top 20 holders with % ownership" },
      { command: "toptraders", description: "Top traders with realized PnL" },
      { command: "ct",         description: "Find common traders across 2–10 tokens" },
      { command: "dexpaid",    description: "Browse DEX Paid pump.fun profiles" },
      { command: "help",       description: "Show all commands" },
    ]);

    return bot;
  })();

  // If init fails, clear the promise so the next request can retry
  _botPromise.catch(() => { _botPromise = null; });

  return _botPromise;
}
