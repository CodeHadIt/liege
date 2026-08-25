/**
 * Send basestonk's two alert shapes — "new stock pair" and the inaugural launch
 * against it — so the formatting can be reviewed against real live data.
 *
 * Sends to ALERTS_PLATINUM_IDS only. This is a format test, not a tier test, so
 * there is no reason to put it in front of gold recipients.
 *
 * It reads the live feed and sends. It writes NOTHING: no feed_seen rows, no
 * cursor updates. A verification script that touches a live seen-set has already
 * caused six spurious alerts here once — never again.
 *
 *   npx tsx scripts/test-basestonk-ping.ts            # most recent stock pair
 *   npx tsx scripts/test-basestonk-ping.ts COIN       # a specific ticker
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { fetchBasestonkLaunches, resolvePairToken, isStockPair, type PairToken } from "../src/lib/api/basestonk";
import {
  formatBasestonkPairAlert,
  formatBasestonkLaunchAlert,
} from "../src/lib/telegram/basestonk-alerts";
import { getAlertsBot } from "../src/lib/telegram/alerts-bot";

async function main() {
  const wanted = process.argv[2]?.toUpperCase() ?? null;

  const recipients = (process.env.ALERTS_PLATINUM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) {
    console.error("ALERTS_PLATINUM_IDS is empty — nothing to send to.");
    process.exit(1);
  }

  const launches = await fetchBasestonkLaunches(100);
  if (!launches) {
    console.error("basestonk launch feed unreachable.");
    process.exit(1);
  }

  const pairs = new Map<string, PairToken>();
  for (const addr of new Set(launches.map((l) => l.pairToken))) {
    const p = await resolvePairToken(addr);
    if (p) pairs.set(addr, p);
  }

  const match = (p: PairToken) =>
    isStockPair(p) && (!wanted || p.ticker.toUpperCase() === wanted || p.symbol.toUpperCase() === wanted);

  const hit = launches.find((l) => {
    const p = pairs.get(l.pairToken);
    return p && match(p);
  });

  if (!hit) {
    const available = [...pairs.values()].filter(isStockPair).map((p) => p.symbol);
    console.error(
      wanted
        ? `No recent launch against ${wanted}. Stock pairs in the last ${launches.length} launches: ${available.join(", ")}`
        : "No stock-paired launch in the recent feed."
    );
    process.exit(1);
  }

  const pair = pairs.get(hit.pairToken)!;
  const bot = await getAlertsBot();

  for (const chatId of recipients) {
    await bot.api.sendMessage(chatId, formatBasestonkPairAlert(pair), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    const text = formatBasestonkLaunchAlert(hit, pair, 1);
    if (hit.imageUrl) {
      await bot.api
        .sendPhoto(chatId, hit.imageUrl, { caption: text, parse_mode: "HTML" })
        .catch(async () => {
          await bot.api.sendMessage(chatId, text, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
        });
    } else {
      await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
    console.log(`sent ${pair.symbol} pair + ${hit.symbol} launch to ${chatId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
