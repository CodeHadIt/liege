/**
 * Verify the Platinum mute and the HOOD watch without sending anything.
 *
 * Read-only by construction: it inspects tier resolution and renders the alert
 * body. `pollHoodWatch` is called only to prove it no-ops today — it returns
 * before touching feed_seen when there are no hits, so nothing is written. A
 * verification script that wrote into a live seen-set once fired six spurious
 * alerts here; this one must never write.
 *
 *   npx tsx scripts/verify-platinum-mute.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import {
  FEATURE,
  recipientsFor,
  deliveryRecipientsFor,
  mutedForPlatinum,
  subscriberTiers,
  type Feature,
} from "../src/lib/telegram/alerts-bot";
import { previewHoodAlert, pollHoodWatch } from "../src/lib/telegram/hood-watch";

const LABEL: Record<string, string> = {
  [FEATURE.LAUNCH]: "Stock pairs + launches",
  [FEATURE.ALPHA_CONFLUENCE_GOLD]: "Wallet confluence (Gold view)",
  [FEATURE.ALPHA_CONFLUENCE_PLATINUM]: "Wallet confluence (Platinum view)",
  [FEATURE.ATH_DAILY]: "Daily ATH + wallet summaries",
  [FEATURE.DEPLOYER]: "Alpha deployer launches",
  [FEATURE.ALPHA_SOLANA]: "Solana alpha wallets (CyberLeeks)",
};

async function main() {
  const tiers = subscriberTiers();
  console.log("subscribers:");
  for (const [id, tier] of tiers) console.log(`  ${id}  ${tier}`);

  const muted = mutedForPlatinum();
  console.log(`\nmuted for platinum: ${[...muted].join(", ") || "(none)"}\n`);

  console.log("feature".padEnd(34) + "entitled".padEnd(12) + "delivered".padEnd(12) + "effect");
  console.log("-".repeat(88));
  for (const f of Object.values(FEATURE) as Feature[]) {
    const ent = recipientsFor(f);
    const del = deliveryRecipientsFor(f);
    const dropped = ent.filter((id) => !del.includes(id));
    const effect = dropped.length === 0 ? "unchanged" : `MUTED for ${dropped.join(", ")}`;
    console.log(String(LABEL[f] ?? f).padEnd(34) + String(ent.length).padEnd(12) + String(del.length).padEnd(12) + effect);
  }

  // The property that matters: Gold must keep its confluence while Platinum's is silenced.
  const goldDel = deliveryRecipientsFor(FEATURE.ALPHA_CONFLUENCE_GOLD);
  const platDel = deliveryRecipientsFor(FEATURE.ALPHA_CONFLUENCE_PLATINUM);
  const platEnt = recipientsFor(FEATURE.ALPHA_CONFLUENCE_PLATINUM);
  console.log(`\nGold confluence still delivered to ${goldDel.length} chat(s): ${goldDel.length > 0 ? "OK" : "check ALERTS_GOLD_IDS"}`);
  console.log(`Platinum confluence delivered to ${platDel.length} (expect 0), still entitled ${platEnt.length} (expect >0, keeps the watcher running)`);

  console.log("\n=== HOOD alert preview (what fires if Robinhood lists itself) ===\n");
  console.log(previewHoodAlert().replace(/<[^>]+>/g, ""));

  console.log("\n=== live HOOD check (expect: no hits, no alert, no writes) ===");
  await pollHoodWatch();
  console.log("pollHoodWatch completed — any hit would have logged '[hood] ALERTED' above.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
