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

/** Escape & in URLs so they're valid inside HTML href attributes. */
function escapeUrl(url: string): string {
  return url.replace(/&/g, "&amp;");
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

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleDex(ctx: MyContext, args: string): Promise<void> {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);

  // ── Validate parts ─────────────────────────────────────────────────────────

  const [bondArg, timeArg, mcapArg] = parts;

  if (!bondArg || (bondArg !== "bond" && bondArg !== "unbond")) {
    await ctx.reply(
      `❌ Missing or invalid status — must be <code>bond</code> or <code>unbond</code>.\n\n${USAGE}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (!timeArg || !VALID_TIMEFRAMES.includes(timeArg as Timeframe)) {
    await ctx.reply(
      `❌ Invalid or missing timeframe.\n\n${USAGE}`,
      { parse_mode: "HTML" }
    );
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

  // If extra args are present, reject
  if (parts.length > 3) {
    await ctx.reply(
      `❌ Too many arguments.\n\n${USAGE}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const bonded   = bondArg === "bond";
  const label    = bonded ? "Bonded" : "Unbonded";
  const mcapLabel = mcapArg ? ` · ≤${mcapArg.toUpperCase()}` : "";

  const loading = await ctx.reply(
    `🔍 Fetching DEX paid ${label.toLowerCase()} tokens (${timeArg}${mcapLabel})…`
  );

  try {
    const tokens = await queryDexProfiles({
      period: timeArg as Timeframe,
      bonded,
      mcapMax,
    });

    if (tokens.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `⚠️ No ${label.toLowerCase()} DEX paid tokens found in the last <b>${timeArg}</b>${mcapLabel ? ` with MC ${mcapLabel}` : ""}.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // ── Build message ──────────────────────────────────────────────────────

    const display = tokens.slice(0, 10);

    let msg =
      `🏷️ <b>DEX Paid — ${label} · ${timeArg}${mcapLabel}</b>\n` +
      `<i>${tokens.length} token${tokens.length !== 1 ? "s" : ""} found</i>\n\n`;

    for (let i = 0; i < display.length; i++) {
      const t = display[i];

      const name   = escapeHtml(t.name || t.symbol || t.address.slice(0, 8));
      const symbol = t.symbol && t.symbol !== t.name ? ` (${escapeHtml(t.symbol)})` : "";

      // Metrics
      const price    = t.priceUsd  ? formatPrice(t.priceUsd)                                 : "—";
      const mcNow    = (t.currentFdv ?? t.fdv) ? `$${formatCompact(t.currentFdv ?? t.fdv)}` : "—";
      const mcAtDex  = t.fdv       ? `$${formatCompact(t.fdv)}`                              : "—";
      const age      = formatAge(t.createdAt ? new Date(t.createdAt).getTime() : null);
      const dexPaidAgo = formatTimeAgo(new Date(t.discoveredAt).getTime());

      // Social links — URLs must have & escaped as &amp; for Telegram HTML
      const socials: string[] = [];
      if (t.twitter)       socials.push(`<a href="${escapeUrl(t.twitter)}">𝕏</a>`);
      const tg   = t.socials?.find((s) => s.type === "telegram")?.url;
      const disc = t.socials?.find((s) => s.type === "discord")?.url;
      if (tg)   socials.push(`<a href="${escapeUrl(tg)}">TG</a>`);
      if (disc) socials.push(`<a href="${escapeUrl(disc)}">DISC</a>`);
      if (t.websites?.[0]) socials.push(`<a href="${escapeUrl(t.websites[0])}">Web</a>`);

      msg += `${i + 1}. <b>${name}${symbol}</b>  <i>${dexPaidAgo}</i>\n`;
      msg += `<code>${escapeHtml(t.address)}</code>\n`;
      msg += `💰 ${price}  📈 ${mcNow}  📊 @dex ${mcAtDex}  🕐 ${age}\n`;
      if (socials.length > 0) msg += socials.join("  ") + "\n";
      msg += "\n";
    }

    if (tokens.length > 10) {
      msg += `<i>…and ${tokens.length - 10} more not shown.</i>`;
    }

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bot/dex] error:", msg, err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      "❌ Failed to fetch DEX paid data. Please try again."
    ).catch(() => null);
  }
}
