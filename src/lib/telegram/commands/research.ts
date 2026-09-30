// ── /research — Platinum-only protocol research ───────────────────────────────
// Usage:
//   /research 0x47ACCD13264D8F954105256FaaC8376ce6A55999   ← contract address
//   /research sender.family                                ← website
//   /research https://sender.family/docs                   ← docs page
//   /research github.com/org/repo                          ← repository
//   /research <solana mint>                                ← SPL token
//
// The pipeline works out which of those it was given (see `research/classify.ts`)
// and converges on the same report either way.
//
// Delivery is two-stage on purpose: the TLDR goes out as its own message so it can
// be forwarded on its own, then the detail follows as numbered pages. A research
// run takes tens of seconds, so the command acknowledges immediately — a silent
// bot reads as a broken one.

import type { Context } from "grammy";
import { runResearch } from "@/lib/research";
import { renderDetail, renderTldr } from "@/lib/research/render";
import { escapeHtml } from "../utils/format";

/**
 * Chats with a run in flight.
 *
 * A research run makes dozens of outbound requests, so two concurrent runs in one
 * chat is both a rate-limit problem for us and an interleaved mess for the reader.
 */
const inFlight = new Set<string>();

const USAGE =
  `🔬 <b>/research</b> — protocol research\n\n` +
  `Send a contract address, a website, a docs page, or a GitHub repo:\n\n` +
  `<code>/research 0x47ACCD13264D8F954105256FaaC8376ce6A55999</code>\n` +
  `<code>/research sender.family</code>\n` +
  `<code>/research https://sender.family/docs</code>\n` +
  `<code>/research github.com/uniswap/v4-core</code>\n\n` +
  `You get a TL;DR first, then the full report: mechanism, fees, supply, rewards, ` +
  `admin powers, security, the docs checked against the deployed code, and what could not be answered.`;

export async function handleResearch(ctx: Context, rawArgs: string): Promise<void> {
  const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? "");
  const arg = rawArgs.trim().split(/\s+/)[0] ?? "";

  if (!arg) {
    await ctx.reply(USAGE, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return;
  }

  if (inFlight.has(chatId)) {
    await ctx.reply("⏳ A research run is already going in this chat. Let it finish first.");
    return;
  }
  inFlight.add(chatId);

  try {
    await ctx.reply(
      `🔬 Researching <code>${escapeHtml(arg)}</code>…\n` +
        `<i>Reading the chain, the docs and the repo. This takes up to two minutes.</i>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );

    const report = await runResearch(arg);

    // The TLDR goes first and alone: it is the part that gets forwarded.
    await ctx.reply(renderTldr(report), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    for (const page of renderDetail(report)) {
      await ctx.reply(page, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      // Telegram throttles bursts per chat; a short gap keeps a long report from
      // tripping a 429 halfway through and losing its tail.
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (err) {
    console.error("[research] run failed:", err);
    await ctx.reply(
      `⚠️ Research failed for <code>${escapeHtml(arg)}</code>.\n` +
        `<i>${escapeHtml(err instanceof Error ? err.message : String(err))}</i>`,
      { parse_mode: "HTML" }
    );
  } finally {
    inFlight.delete(chatId);
  }
}
