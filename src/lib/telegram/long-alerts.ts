import {
  fetchRobinhoodStockTokens,
  rhExplorerTokenUrl,
  type RhStockToken,
} from "@/lib/api/robinhood-stocks";
import { getBot } from "./bot";
import { escapeHtml } from "./utils/format";

const LONG_CREATE_URL = "https://app.long.xyz/create";

// In-memory dedupe, seeded on first poll so we only alert on stocks added after
// the system comes online.
const seen = new Set<string>();
let seeded = false;

function alertChatId(): string {
  return process.env.LONG_ALERT_CHAT_ID || process.env.STONKFUN_ALERT_CHAT_ID || "";
}

export function formatLongStockAlert(t: RhStockToken): string {
  // Names look like "Take-Two Interactive Software • Robinhood Token"
  const company = t.name.split("•")[0].trim() || t.symbol;

  const lines: string[] = [];
  lines.push(`📈 <b>New Stock on Robinhood Chain</b>`);
  lines.push(`<i>New base pair — tradable on Long.</i>`);
  lines.push("");
  lines.push(`<b>${escapeHtml(company)}</b>  ·  <code>$${escapeHtml(t.symbol)}</code>`);
  const meta = ["🏷 Stock · Robinhood Token"];
  if (t.isin) meta.push(`🔢 ${escapeHtml(t.isin)}`);
  lines.push(meta.join("  ·  "));
  lines.push("");
  lines.push(`<code>${escapeHtml(t.contractAddress)}</code>`);
  lines.push(
    `🔭 <a href="${rhExplorerTokenUrl(t.contractAddress)}">Blockscout</a>` +
    `  ·  🟢 <a href="${LONG_CREATE_URL}">Trade on Long</a>`
  );
  return lines.join("\n");
}

async function sendAlert(chatId: string, t: RhStockToken): Promise<void> {
  const bot = await getBot();
  const text = formatLongStockAlert(t);
  if (t.logoUrl) {
    await bot.api
      .sendPhoto(chatId, t.logoUrl, { caption: text, parse_mode: "HTML" })
      .catch(async () => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      });
  } else {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

/**
 * One poll cycle: alert when a new tokenized stock appears on Robinhood Chain
 * (the pool Long draws its base pairs from). Seeds the existing list silently.
 */
export async function pollLongStocks(): Promise<void> {
  const stocks = await fetchRobinhoodStockTokens();
  if (stocks.length === 0) return;

  if (!seeded) {
    for (const s of stocks) seen.add(s.contractAddress);
    seeded = true;
    console.log(`[long] seeded ${seen.size} existing Robinhood stock tokens (no alert on backlog)`);
    return;
  }

  const fresh = stocks.filter((s) => !seen.has(s.contractAddress));
  if (fresh.length === 0) return;

  const chatId = alertChatId();
  for (const s of fresh) {
    seen.add(s.contractAddress);
    if (!chatId) {
      console.log(`[long] new stock ${s.symbol} — alert chat not set, skipping ping`);
      continue;
    }
    try {
      await sendAlert(chatId, s);
      console.log(`[long] alerted new stock: ${s.symbol} (${s.name})`);
    } catch (err) {
      console.error("[long] failed to send alert:", err);
    }
  }
}

/** Manual test: send an existing stock so the format can be verified. */
export async function sendLongTestPing(chatId: string, symbol?: string): Promise<boolean> {
  const stocks = await fetchRobinhoodStockTokens();
  if (stocks.length === 0) return false;
  const pick = symbol ? stocks.find((s) => s.symbol.toLowerCase() === symbol.toLowerCase()) : stocks[0];
  await sendAlert(chatId, pick ?? stocks[0]);
  return true;
}
