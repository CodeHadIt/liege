import {
  fetchSunriseTokens,
  orbMarketsTokenUrl,
  sunriseTokenUrl,
  type SunriseToken,
} from "@/lib/api/sunrise";
import { getAlertsBot, broadcastAlert } from "./alerts-bot";
import { escapeHtml } from "./utils/format";

// Which asset classes to alert on. Sunrise's focus (and the user's) is tokenized
// stocks — but this is the single place to widen coverage later if desired.
const ALERT_ASSET_CLASSES = new Set(["stock"]);

// In-memory dedupe, seeded on first poll so we only alert on assets added after
// the system comes online — not the existing backlog.
const seen = new Set<string>();
let seeded = false;

const ASSET_CLASS_LABEL: Record<string, string> = {
  stock:      "📈 Stock",
  commodity:  "🪙 Commodity",
  crypto:     "⛓ Crypto",
  stablecoin: "💵 Stablecoin",
};

function formatListedDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatSunriseAlert(t: SunriseToken): string {
  // Names look like "Intel - Backpack Securities" → split company from issuer.
  const [company, issuer] = t.name.includes(" - ") ? t.name.split(" - ", 2) : [t.name, null];

  const lines: string[] = [];
  lines.push(`📈 <b>New Stock Pair on Sunrise</b>`);
  lines.push(`<i>Now tradable against USDC.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(company || t.symbol)}</b>  ·  <code>$${escapeHtml(t.symbol)}</code>`);

  const tags = [ASSET_CLASS_LABEL[t.assetClass] ?? `🏷 ${escapeHtml(t.assetClass)}`];
  if (issuer) tags.push(escapeHtml(issuer));
  lines.push(tags.join("  ·  "));

  const listed = formatListedDate(t.launchDate);
  if (listed) lines.push(`📅 Listed: ${escapeHtml(listed)}`);

  lines.push("");
  lines.push(`<code>${escapeHtml(t.address)}</code>`);
  lines.push(
    `🔭 <a href="${orbMarketsTokenUrl(t.address)}">Orb Markets</a>` +
    `  ·  🌅 <a href="${sunriseTokenUrl(t.address)}">Trade on Sunrise</a>`
  );
  return lines.join("\n");
}

async function sendAlert(chatId: string, t: SunriseToken): Promise<void> {
  const bot = await getAlertsBot();
  const text = formatSunriseAlert(t);
  if (t.icon) {
    await bot.api
      .sendPhoto(chatId, t.icon, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      });
  } else {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

/**
 * One poll cycle: alert when Sunrise lists a new stock pair. Seeds the existing
 * list silently on first run.
 */
export async function pollSunriseStocks(): Promise<void> {
  const tokens = await fetchSunriseTokens();
  if (tokens.length === 0) return;

  const relevant = tokens.filter((t) => ALERT_ASSET_CLASSES.has(t.assetClass));

  if (!seeded) {
    for (const t of relevant) seen.add(t.address);
    seeded = true;
    console.log(`[sunrise] seeded ${seen.size} existing stock pairs (no alert on backlog)`);
    return;
  }

  const fresh = relevant.filter((t) => !seen.has(t.address));
  if (fresh.length === 0) return;

  for (const t of fresh) {
    seen.add(t.address);
    await broadcastAlert((chatId) => sendAlert(chatId, t));
    console.log(`[sunrise] alerted new stock pair: ${t.symbol} (${t.name})`);
  }
}

/** Manual test: send the most recently listed stock so the format can be verified. */
export async function sendSunriseTestPing(chatId: string): Promise<boolean> {
  const tokens = await fetchSunriseTokens();
  const stocks = tokens
    .filter((t) => ALERT_ASSET_CLASSES.has(t.assetClass))
    .sort((a, b) => (b.launchDate ?? "").localeCompare(a.launchDate ?? ""));
  if (stocks.length === 0) return false;
  await sendAlert(chatId, stocks[0]);
  return true;
}
