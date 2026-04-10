import type { MyContext } from "../bot";
import { queryDexProfiles } from "@/lib/api/dex-orders-cache";
import {
  escapeHtml,
  formatCompact,
  formatPrice,
  formatAge,
  formatTimeAgo,
} from "../utils/format";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Escape special chars in URLs for use inside HTML href attributes. */
function escapeUrl(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Only accept proper http/https URLs to avoid Telegram HTML parse errors. */
function validUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return trimmed.startsWith("https://") || trimmed.startsWith("http://") ? trimmed : null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Timeframe = "10m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "24h";
type McapKey   = "5k" | "10k" | "20k" | "50k" | "100k" | "500k" | "1m";

const VALID_TIMEFRAMES: Timeframe[] = ["10m", "30m", "1h", "2h", "4h", "8h", "12h", "24h"];

const MCAP_VALUES: Record<McapKey, number> = {
  "5k":   5_000,
  "10k":  10_000,
  "20k":  20_000,
  "50k":  50_000,
  "100k": 100_000,
  "500k": 500_000,
  "1m":   1_000_000,
};

const USAGE =
  `<b>Format:</b> <code>/dex &lt;bond|unbond&gt; &lt;timeframe&gt; [mcap]</code>\n\n` +
  `<b>Timeframes:</b> 10m · 30m · 1h · 2h · 4h · 8h · 12h · 24h\n` +
  `<b>Mcap cap (optional):</b> 5k · 10k · 20k · 50k · 100k · 500k · 1m\n\n` +
  `<b>Examples:</b>\n` +
  `<code>/dex bond 1h</code>\n` +
  `<code>/dex unbond 30m 10k</code>\n` +
  `<code>/dex bond 4h 100k</code>`;

const MSG_LIMIT = 3800; // Telegram max is 4096; leave headroom

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleDex(ctx: MyContext, args: string): Promise<void> {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);

  // ── Validate args ──────────────────────────────────────────────────────────

  const [bondArg, timeArg, mcapArg] = parts;

  if (!bondArg || (bondArg !== "bond" && bondArg !== "unbond")) {
    await ctx.reply(
      `❌ Missing or invalid status — must be <code>bond</code> or <code>unbond</code>.\n\n${USAGE}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (!timeArg || !VALID_TIMEFRAMES.includes(timeArg as Timeframe)) {
    await ctx.reply(`❌ Invalid or missing timeframe.\n\n${USAGE}`, { parse_mode: "HTML" });
    return;
  }

  let mcapMax: number | undefined;
  if (mcapArg) {
    const val = MCAP_VALUES[mcapArg as McapKey];
    if (val === undefined) {
      await ctx.reply(
        `❌ Invalid mcap filter <code>${escapeHtml(mcapArg)}</code>.\n\n${USAGE}`,
        { parse_mode: "HTML" }
      );
      return;
    }
    mcapMax = val;
  }

  if (parts.length > 3) {
    await ctx.reply(`❌ Too many arguments.\n\n${USAGE}`, { parse_mode: "HTML" });
    return;
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const bonded    = bondArg === "bond";
  const label     = bonded ? "Bonded" : "Unbonded";
  const mcapLabel = mcapArg ? ` · ≤${mcapArg.toUpperCase()}` : "";
  const title     = `🏷️ <b>DEX Paid — ${label} · ${timeArg}${mcapLabel}</b>`;

  const loading = await ctx.reply(
    `🔍 Fetching DEX paid ${label.toLowerCase()} tokens (${timeArg}${mcapLabel})…`
  );

  try {
    const tokens = await queryDexProfiles({ period: timeArg as Timeframe, bonded, mcapMax });

    if (tokens.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `⚠️ No ${label.toLowerCase()} DEX paid tokens found in the last <b>${timeArg}</b>${mcapLabel ? ` with MC ${mcapLabel}` : ""}.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // ── Build individual token entries ─────────────────────────────────────

    const entries: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      const name   = escapeHtml(t.name || t.symbol || t.address.slice(0, 8));
      const symbol = t.symbol && t.symbol !== t.name ? ` (${escapeHtml(t.symbol)})` : "";

      const price      = t.priceUsd              ? formatPrice(t.priceUsd)                                 : "—";
      const mcNow      = (t.currentFdv ?? t.fdv) ? `$${formatCompact(t.currentFdv ?? t.fdv)}`             : "—";
      const mcAtDex    = t.fdv                   ? `$${formatCompact(t.fdv)}`                              : "—";
      const age        = formatAge(t.createdAt ? new Date(t.createdAt).getTime() : null);
      const dexPaidAgo = formatTimeAgo(new Date(t.discoveredAt).getTime());

      // Social links — validated http(s) URLs only
      const socials: string[] = [];
      const twUrl   = validUrl(t.twitter);
      const tgUrl   = validUrl(t.socials?.find((s) => s.type === "telegram")?.url);
      const discUrl = validUrl(t.socials?.find((s) => s.type === "discord")?.url);
      const webUrl  = validUrl(t.websites?.[0]);
      if (twUrl)   socials.push(`<a href="${escapeUrl(twUrl)}">𝕏</a>`);
      if (tgUrl)   socials.push(`<a href="${escapeUrl(tgUrl)}">TG</a>`);
      if (discUrl) socials.push(`<a href="${escapeUrl(discUrl)}">DISC</a>`);
      if (webUrl)  socials.push(`<a href="${escapeUrl(webUrl)}">Web</a>`);

      let entry = `${i + 1}. <b>${name}${symbol}</b>  <i>${dexPaidAgo}</i>\n`;
      entry += `<code>${escapeHtml(t.address)}</code>\n`;
      entry += `💰 ${price}  📈 ${mcNow}  📊 @dex ${mcAtDex}  🕐 ${age}\n`;
      if (socials.length > 0) entry += socials.join("  ") + "\n";
      entry += "\n";

      entries.push(entry);
    }

    // ── Pack entries into pages ────────────────────────────────────────────
    // We don't know total pages until we've packed, so we pack first, then
    // prepend the header with the final page count.

    const pages: string[] = [];
    let current = "";

    for (const entry of entries) {
      // +1 for the header we'll prepend (estimated ~60 chars); bail if oversized
      if (current.length + entry.length > MSG_LIMIT - 80) {
        if (current.length > 0) pages.push(current);
        current = entry;
      } else {
        current += entry;
      }
    }
    if (current.length > 0) pages.push(current);

    const totalPages = pages.length;

    // ── Send pages ─────────────────────────────────────────────────────────

    for (let p = 0; p < totalPages; p++) {
      const pageLabel = totalPages > 1 ? `  <i>${p + 1}/${totalPages}</i>` : "";
      const header    = `${title}${pageLabel}\n<i>${tokens.length} token${tokens.length !== 1 ? "s" : ""} found</i>\n\n`;
      const msg       = header + pages[p];

      console.log(`[bot/dex] Sending page ${p + 1}/${totalPages}: ${msg.length} chars`);

      if (p === 0) {
        await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      } else {
        await ctx.reply(msg, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[bot/dex] error:", errMsg);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to fetch DEX paid data. Please try again."
    ).catch(() => null);
  }
}
