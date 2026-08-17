/**
 * Verify tier routing end to end, through the real delivery gate.
 *
 * Sends one probe per feature via `broadcastAlert()`, so it exercises exactly
 * the path production feeds use — `recipientsFor()` decides who gets what, not
 * this script. Run it after changing ALERTS_PLATINUM_IDS / ALERTS_GOLD_IDS, or
 * after adding a feature, to confirm nothing reaches a tier it shouldn't.
 *
 *   npx tsx scripts/test-tier-routing.ts            # dry run — prints routing
 *   npx tsx scripts/test-tier-routing.ts --send     # actually delivers
 *
 * Dry run is the default on purpose: this messages real subscribers, and an
 * accidental run should cost nothing.
 *
 * Message bodies are tier-dependent. Platinum gets the diagnostic text naming
 * the feature and who should receive it. Everyone else gets a bare "this is a
 * test message" — the probes must never disclose which feeds exist, or that
 * delivery is gated at all.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import {
  getAlertsBot,
  broadcastAlert,
  recipientsFor,
  tierOf,
  FEATURE,
  type Feature,
  type Tier,
} from "../src/lib/telegram/alerts-bot";

const SEND = process.argv.includes("--send");

/** Partial IDs only: enough to tell recipients apart in a log, not to identify. */
const mask = (s: string) => (s.length > 4 ? `${s.slice(0, 3)}…${s.slice(-2)}` : s);
const stamp = () => `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;

interface Probe {
  feature: Feature;
  label: string;
  /** Shown only to platinum — names the feed and the expected audience. */
  diagnostic: string;
}

const PROBES: Probe[] = [
  {
    feature: FEATURE.LAUNCH,
    label: "launch (all tiers)",
    diagnostic: "Launchpad feeds. Every tier receives this one.",
  },
  {
    feature: FEATURE.ALPHA_CONFLUENCE_GOLD,
    label: "alpha.confluence.gold (gold only)",
    diagnostic: "Confluence over the frozen wallet library. Gold's evaluation.",
  },
  {
    feature: FEATURE.ALPHA_CONFLUENCE_PLATINUM,
    label: "alpha.confluence.platinum (platinum only)",
    diagnostic: "Confluence including newly promoted wallets. Platinum only.",
  },
  {
    feature: FEATURE.ATH_DAILY,
    label: "ath.daily (platinum only)",
    diagnostic: "Daily $2M ATH digest and wallet promotions. Platinum only.",
  },
  {
    feature: FEATURE.DEPLOYER,
    label: "deployer (platinum only)",
    diagnostic: "Alpha deployer launches. Platinum only.",
  },
];

/**
 * The message a given recipient sees.
 *
 * Anything other than platinum gets the generic body. Written as a default
 * rather than an explicit "gold" branch so a tier added later cannot start
 * receiving diagnostics by omission.
 */
function bodyFor(tier: Tier | null, probe: Probe): string {
  if (tier === "platinum") {
    return (
      `🧪 <b>Tier routing test</b>\n\n` +
      `Feed: <code>${probe.feature}</code>\n` +
      `${probe.diagnostic}\n\n` +
      `<i>${stamp()}</i>`
    );
  }
  return `🧪 <b>This is a test message.</b>\n\n<i>${stamp()}</i>`;
}

async function main() {
  console.log(SEND ? "MODE: SENDING\n" : "MODE: DRY RUN (re-run with --send to deliver)\n");

  console.log("planned routing:");
  let anyRecipients = false;
  for (const p of PROBES) {
    const ids = recipientsFor(p.feature);
    if (ids.length) anyRecipients = true;
    const who = ids.map((i) => `${mask(i)}[${tierOf(i)}]`).join(", ") || "(none)";
    console.log(`  ${p.label.padEnd(42)} → ${ids.length}: ${who}`);
  }

  if (!anyRecipients) {
    console.log("\nNo recipients configured — set ALERTS_PLATINUM_IDS / ALERTS_GOLD_IDS.");
    return;
  }
  if (!SEND) return;

  const bot = await getAlertsBot();
  console.log("\nsending…");
  for (const p of PROBES) {
    const sent: string[] = [];
    await broadcastAlert(p.feature, async (chatId) => {
      await bot.api.sendMessage(chatId, bodyFor(tierOf(chatId), p), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      sent.push(chatId);
    });
    const who = sent.map((i) => `${mask(i)}[${tierOf(i)}]`).join(", ") || "(none)";
    console.log(`  ${p.label.padEnd(42)} delivered to ${sent.length}: ${who}`);
    // Gentle on Telegram's per-chat rate limit; this is not a latency-sensitive path.
    await new Promise((r) => setTimeout(r, 600));
  }
  console.log("\ndone");
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
