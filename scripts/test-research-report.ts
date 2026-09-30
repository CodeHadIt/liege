/**
 * Run /research against any input and review the result before it ever reaches a
 * user — the same job `test-basestonk-ping.ts` does for the launch alerts.
 *
 * Prints the rendered messages to stdout by default. `--send` delivers them to
 * ALERTS_PLATINUM_IDS through the alerts bot, which is the only way to check how
 * the HTML actually lands in a Telegram client.
 *
 * Reads only. It touches no seen-sets, no cursors and no database rows.
 *
 *   npx tsx scripts/test-research-report.ts 0x47ACCD13264D8F954105256FaaC8376ce6A55999
 *   npx tsx scripts/test-research-report.ts sender.family --send
 *   npx tsx scripts/test-research-report.ts https://sender.family/docs --pages 12
 *   npx tsx scripts/test-research-report.ts github.com/uniswap/v4-core --json
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { runResearch } from "../src/lib/research";
import { renderDetail, renderTldr } from "../src/lib/research/render";
import { getAlertsBot } from "../src/lib/telegram/alerts-bot";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Telegram HTML → something readable in a terminal. */
function plain(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, "$2 <$1>")
    .replace(/<\/?(b|i|code|pre|u|s)>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function main() {
  const input = process.argv[2];
  if (!input || input.startsWith("--")) {
    console.error("usage: npx tsx scripts/test-research-report.ts <address|url|name> [--send] [--pages N] [--budget SECONDS] [--json]");
    process.exit(1);
  }

  const pages = opt("pages");
  const budget = opt("budget");
  console.error(`[research] running for "${input}"…`);

  const report = await runResearch(input, {
    maxDocPages: pages ? Number(pages) : undefined,
    budgetMs: budget ? Number(budget) * 1000 : undefined,
  });

  if (flag("json")) {
    console.log(
      JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
    );
    return;
  }

  const messages = [renderTldr(report), ...renderDetail(report)];

  console.error(
    `[research] ${report.coverage.filter((c) => c.state === "ok").length}/${report.coverage.length} sources ok, ` +
      `${report.evidence.length} evidence sentences, ${messages.length} messages, ${(report.elapsedMs / 1000).toFixed(1)}s`
  );
  for (const c of report.coverage) console.error(`   ${c.state.padEnd(7)} ${c.id}: ${c.detail}`);

  for (const [i, m] of messages.entries()) {
    console.log(`\n${"═".repeat(72)}\n  MESSAGE ${i + 1}/${messages.length}  (${m.length} chars)\n${"═".repeat(72)}\n`);
    console.log(plain(m));
  }

  if (!flag("send")) {
    console.error("\n[research] not sent. Add --send to deliver to ALERTS_PLATINUM_IDS.");
    return;
  }

  const recipients = (opt("chat") ?? process.env.ALERTS_PLATINUM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) {
    console.error("ALERTS_PLATINUM_IDS is empty — nothing to send to.");
    process.exit(1);
  }

  const bot = await getAlertsBot();
  for (const chatId of recipients) {
    for (const m of messages) {
      await bot.api.sendMessage(chatId, m, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      // Same spacing the command uses: a long report sent flat out trips
      // Telegram's per-chat burst limit and loses its tail.
      await new Promise((r) => setTimeout(r, 450));
    }
    console.error(`[research] sent ${messages.length} messages to ${chatId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
