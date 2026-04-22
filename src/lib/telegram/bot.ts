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
        `/th &lt;address&gt; — top holders\n` +
        `/tt &lt;address&gt; — top traders with PnL\n` +
        `/common — find common top traders across 2–10 tokens\n` +
        `/sh &lt;addrA&gt; &lt;addrB&gt; — find wallets holding two tokens\n` +
        `/diamond &lt;address&gt; — holders with avg buy MC ≥ 20× current MC\n` +
        `/wallet &lt;address&gt; [chain] — analyze a wallet\n` +
        `/dp &lt;address&gt; — check DexScreener ad payment status\n` +
        `/dex &lt;bond|unbond&gt; &lt;timeframe&gt; [mcap] — browse DEX Paid tokens\n` +
        `/help — show this message\n\n` +
        `<i>Supports Solana, Base, BSC, and Ethereum. Chain detected automatically.</i>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `<b>Liège Bot Commands</b>\n\n` +
        `<b>/token</b> <code>&lt;address&gt;</code>\n` +
        `Full token analysis — price, market cap, liquidity, DD score, safety flags.\n\n` +
        `<b>/th</b> <code>&lt;address&gt;</code>\n` +
        `Top holders with % ownership.\n\n` +
        `<b>/tt</b> <code>&lt;address&gt;</code>\n` +
        `Top traders with realized PnL and trade counts.\n\n` +
        `<b>/common</b>\n` +
        `Find wallets that traded 2–10 tokens in common. Great for finding smart money.\n\n` +
        `<b>/sh</b> <code>&lt;addressA&gt; &lt;addressB&gt;</code>\n` +
        `Find wallets currently holding two tokens at the same time. Chain auto-detected.\n\n` +
        `<b>/diamond</b> <code>&lt;address&gt;</code>\n` +
        `Find holders whose average buy MC is ≥ 20× the current MC — true diamond hands.\n\n` +
        `<b>/wallet</b> <code>&lt;address&gt; [chain]</code>\n` +
        `Analyze a wallet — age, portfolio, top holdings, recent PnL.\n` +
        `Solana addresses are detected automatically. For EVM wallets, add chain: <code>eth</code>, <code>base</code>, or <code>bsc</code>.\n\n` +
        `<b>/dp</b> <code>&lt;address&gt;</code>\n` +
        `Check whether a token has paid for DexScreener ad placement.\n\n` +
        `<b>/dex</b> <code>&lt;bond|unbond&gt; &lt;timeframe&gt; [mcap]</code>\n` +
        `Browse DEX paid tokens. Filter by bonded status, time window (10m–24h), and optional max MC.\n` +
        `Example: <code>/dex bond 1h 50k</code>\n\n` +
        `<i>Chain is detected automatically from the address.</i>`,
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

  // ── /th (top holders) ────────────────────────────────────────────────────────

  bot.command("th", async (ctx) => {
    const { handleHolders } = await import("./commands/holders");
    const { detectEvmChain } = await import("./commands/token");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply("Usage: /th <code>&lt;address&gt;</code>", {
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

  // ── /tt (top traders) ────────────────────────────────────────────────────────

  bot.command("tt", async (ctx) => {
    const { handleTopTraders } = await import("./commands/toptraders");
    const { detectEvmChain } = await import("./commands/token");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply("Usage: /tt <code>&lt;address&gt;</code>", {
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

  // ── /common ──────────────────────────────────────────────────────────────────

  bot.command("common", async (ctx) => {
    const args = ctx.match?.trim();

    // Direct invocation: /common addr1 addr2 ... (space or newline separated)
    if (args) {
      const addresses = args.split(/[\s\n]+/).map((a) => a.trim()).filter(Boolean);
      if (addresses.length >= 2 && addresses.length <= 10) {
        const rawChain = detectChainFromAddress(addresses[0]);
        if (rawChain) {
          const { detectEvmChain } = await import("./commands/token");
          const chain = rawChain === "base" ? await detectEvmChain(addresses[0]) : rawChain;
          const { handleCtDirect } = await import("./commands/ct");
          await handleCtDirect(ctx, chain, addresses);
          return;
        }
      }
      // Invalid args — fall through to guided flow with a hint
      await ctx.reply(
        `⚠️ Could not parse addresses. Make sure you pass 2–10 valid addresses.\n\n` +
        `Starting guided flow instead…`,
        { parse_mode: "HTML" }
      );
    }

    const { promptCtChain } = await import("./commands/ct");
    await promptCtChain(ctx);
  });

  // ── /sh (shared holders) ─────────────────────────────────────────────────────

  bot.command("sh", async (ctx) => {
    const { handleSharedHolders } = await import("./commands/sh");
    const args = ctx.match?.trim() ?? "";

    // Accept both space-separated and newline-separated addresses
    const parts = args.split(/[\s\n]+/).map((a) => a.trim()).filter(Boolean);

    if (parts.length !== 2) {
      await ctx.reply(
        `<b>Usage:</b> <code>/sh &lt;addressA&gt; &lt;addressB&gt;</code>\n\n` +
        `Find wallets that hold two tokens at the same time.\n` +
        `Chain is detected automatically from the address format.\n\n` +
        `<i>Example:</i>\n` +
        `<code>/sh 0xTokenA 0xTokenB</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    await handleSharedHolders(ctx, parts[0], parts[1]);
  });

  // ── /diamond ──────────────────────────────────────────────────────────────────

  bot.command("diamond", async (ctx) => {
    const { handleDiamond } = await import("./commands/diamond");
    const { detectEvmChain } = await import("./commands/token");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply(
        `<b>Usage:</b> <code>/diamond &lt;token_address&gt;</code>\n\n` +
        `Find holders whose average buy MC is ≥ 20× the current MC.\n` +
        `Chain is detected automatically.`,
        { parse_mode: "HTML" }
      );
      return;
    }
    const rawChain = detectChainFromAddress(address);
    if (!rawChain) {
      await ctx.reply("❌ Could not detect chain from this address.");
      return;
    }
    const chain = rawChain === "base" ? await detectEvmChain(address) : rawChain;
    await handleDiamond(ctx, chain, address);
  });

  // ── /wallet ───────────────────────────────────────────────────────────────────

  bot.command("wallet", async (ctx) => {
    const { handleWallet, getAddressType } = await import("./commands/wallet");
    const args = ctx.match?.trim() ?? "";
    const parts = args.split(/\s+/).filter(Boolean);

    if (!parts.length) {
      await ctx.reply(
        `<b>Usage:</b>\n` +
        `• Solana: <code>/wallet &lt;address&gt;</code>\n` +
        `• EVM:    <code>/wallet &lt;address&gt; &lt;eth|base|bsc&gt;</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const address = parts[0];
    const addrType = getAddressType(address);

    if (!addrType) {
      await ctx.reply("❌ Could not recognize this address. Please provide a valid Solana or EVM wallet address.");
      return;
    }

    if (addrType === "solana") {
      await handleWallet(ctx, "solana", address);
      return;
    }

    // EVM — chain must be specified
    const chainArg = parts[1]?.toLowerCase();
    const VALID_EVM_CHAINS = ["eth", "base", "bsc"] as const;
    type EvmChain = typeof VALID_EVM_CHAINS[number];

    if (!chainArg || !VALID_EVM_CHAINS.includes(chainArg as EvmChain)) {
      await ctx.reply(
        `⚠️ EVM wallet detected. Please specify the chain:\n` +
        `<code>/wallet ${address} eth</code>\n` +
        `<code>/wallet ${address} base</code>\n` +
        `<code>/wallet ${address} bsc</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    await handleWallet(ctx, chainArg as EvmChain, address);
  });

  // ── /dp ───────────────────────────────────────────────────────────────────────

  bot.command("dp", async (ctx) => {
    const { handleDp } = await import("./commands/dp");
    const address = ctx.match?.trim();
    if (!address) {
      await ctx.reply("Usage: /dp <code>&lt;address&gt;</code>", { parse_mode: "HTML" });
      return;
    }
    await handleDp(ctx, address);
  });

  // ── /dex ──────────────────────────────────────────────────────────────────────

  bot.command("dex", async (ctx) => {
    const { handleDex } = await import("./commands/dex");
    const args = ctx.match?.trim() ?? "";
    if (!args) {
      await ctx.reply(
        `<b>Format:</b> <code>/dex &lt;bond|unbond&gt; &lt;timeframe&gt; [mcap]</code>\n\n` +
        `<b>Timeframes:</b> 10m · 30m · 1h · 2h · 4h · 8h · 12h · 24h\n` +
        `<b>Mcap cap (optional):</b> 5k · 10k · 20k · 50k · 100k · 500k · 1m\n\n` +
        `<b>Examples:</b>\n` +
        `<code>/dex bond 1h</code>\n` +
        `<code>/dex unbond 30m 10k</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }
    await handleDex(ctx, args);
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

    // Auto-analyze bare Solana address — detect wallet vs token mint
    if (SOLANA_ADDR.test(text)) {
      const { isSolanaTokenMint, handleWallet } = await import("./commands/wallet");
      const isToken = await isSolanaTokenMint(text).catch(() => false);
      if (isToken) {
        const { handleToken } = await import("./commands/token");
        await handleToken(ctx, "solana", text);
      } else {
        await handleWallet(ctx, "solana", text);
      }
      return;
    }

    // Bare EVM address + chain: "0x... eth" / "0x... base" / "0x... bsc"
    const parts = text.split(/\s+/);
    if (parts.length === 2 && EVM_ADDR.test(parts[0])) {
      const chainArg = parts[1].toLowerCase();
      if (chainArg === "eth" || chainArg === "base" || chainArg === "bsc") {
        const { handleWallet } = await import("./commands/wallet");
        await handleWallet(ctx, chainArg as "eth" | "base" | "bsc", parts[0]);
        return;
      }
    }

    // Bare EVM address (no chain) — token analysis with auto-detected chain
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
      { command: "token",  description: "Analyze a token — price, MC, DD score, safety" },
      { command: "th",     description: "Top holders with % ownership" },
      { command: "tt",     description: "Top traders with realized PnL" },
      { command: "common", description: "Find common traders across 2–10 tokens" },
      { command: "sh",      description: "Find wallets holding two tokens — /sh addrA addrB" },
      { command: "diamond", description: "Diamond hands — holders with avg buy MC ≥ 20× current" },
      { command: "wallet",  description: "Analyze a wallet — portfolio, holdings, PnL" },
      { command: "dp",     description: "Check DexScreener ad payment for a token" },
      { command: "dex",    description: "Browse DEX Paid tokens — /dex bond 1h" },
      { command: "help",   description: "Show all commands" },
    ]);

    return bot;
  })();

  // If init fails, clear the promise so the next request can retry
  _botPromise.catch(() => { _botPromise = null; });

  return _botPromise;
}
