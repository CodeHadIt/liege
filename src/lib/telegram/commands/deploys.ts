import type { MyContext } from "../bot";
import { getDeployedTokens, bestLaunch, type DeployedToken } from "@/lib/api/deploys";
import {
  escapeHtml,
  formatCompact,
  chainEmoji,
  chainLabel,
  truncateAddress,
  formatTimeAgo,
} from "../utils/format";

const EXPLORER: Record<string, string> = {
  solana: "https://solscan.io",
  eth:    "https://etherscan.io",
  base:   "https://basescan.org",
  bsc:    "https://bscscan.com",
};

const GMGN_CHAIN: Record<string, string> = {
  solana: "sol",
  eth:    "eth",
  base:   "base",
  bsc:    "bsc",
};

function fmtMc(n: number | null): string {
  if (!n || n <= 0) return "—";
  return `$${formatCompact(n)}`;
}

function tokenLine(idx: number, t: DeployedToken, chain: string): string {
  const explorer = EXPLORER[chain];
  const explorerUrl = chain === "solana"
    ? `${explorer}/token/${t.address}`
    : `${explorer}/token/${t.address}`;
  const created = t.createdAt ? ` · <i>${escapeHtml(formatTimeAgo(t.createdAt))}</i>` : "";
  return (
    `${idx}. <b>${escapeHtml(t.name || t.symbol || "???")}</b> <i>(${escapeHtml(t.symbol || "")})</i>${created}\n` +
    `   CA: <code>${escapeHtml(t.address)}</code>\n` +
    `   <a href="${explorerUrl}">${escapeHtml(truncateAddress(t.address))}</a>\n` +
    `   Current MC: <b>${escapeHtml(fmtMc(t.currentMcUsd))}</b> · Highest MC: <b>${escapeHtml(fmtMc(t.highestMcUsd))}</b>\n`
  );
}

export async function handleDeploys(
  ctx: MyContext,
  chain: "solana" | "eth" | "base" | "bsc",
  walletAddress: string
): Promise<void> {
  const emoji = chainEmoji(chain);
  const loading = await ctx.reply(
    `${emoji} <b>Scanning deploys…</b>\n<code>${escapeHtml(walletAddress)}</code>\n\n<i>Finding tokens created by this address…</i>`,
    { parse_mode: "HTML" }
  );

  try {
    const tokens = await getDeployedTokens(chain, walletAddress);

    if (tokens.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `${emoji} <b>Deploys · ${escapeHtml(chainLabel(chain))}</b>\n<code>${escapeHtml(walletAddress)}</code>\n\n` +
          `❌ No deployed tokens found.\n\n` +
          `<i>Detection: pump.fun creates and direct SPL mints on Solana; direct ` +
          `contract deployments on EVM. Other launchpads (four.meme etc.) aren't ` +
          `tracked yet.</i>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
      return;
    }

    const best = bestLaunch(tokens);
    const top = tokens.slice(0, 15);
    const explorer = EXPLORER[chain];
    const explorerAddrUrl = chain === "solana"
      ? `${explorer}/account/${walletAddress}`
      : `${explorer}/address/${walletAddress}`;
    const gmgnUrl = `https://gmgn.ai/${GMGN_CHAIN[chain]}/address/${walletAddress}`;

    let msg = `${emoji} <b>Deploys · ${escapeHtml(chainLabel(chain))}</b>\n`;
    msg += `<a href="${explorerAddrUrl}"><code>${escapeHtml(walletAddress)}</code></a>\n\n`;
    msg += `Found <b>${tokens.length}</b> token${tokens.length === 1 ? "" : "s"}`;
    if (tokens.length > top.length) msg += ` (showing top ${top.length})`;
    msg += `\n\n`;

    if (best) {
      msg += `🏆 <b>Best Launch</b>\n`;
      msg += `   <b>${escapeHtml(best.name || best.symbol || "???")}</b> <i>(${escapeHtml(best.symbol || "")})</i>\n`;
      msg += `   <code>${escapeHtml(best.address)}</code>\n`;
      msg += `   Highest MC: <b>${escapeHtml(fmtMc(best.highestMcUsd ?? best.currentMcUsd))}</b>\n\n`;
    }

    msg += `📋 <b>Deployed Tokens</b>\n`;
    for (let i = 0; i < top.length; i++) {
      msg += tokenLine(i + 1, top[i], chain);
    }

    msg += `\n<a href="${gmgnUrl}">GMGN</a> · <a href="${explorerAddrUrl}">Explorer</a>`;

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("[bot/deploys]", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to scan deploys. Please try again."
    );
  }
}
