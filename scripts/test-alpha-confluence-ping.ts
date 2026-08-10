/**
 * Send a mock alpha-confluence sequence to the alerts bot so the message format
 * can be reviewed before the live watcher is wired up.
 *
 * Uses real alpha wallet labels from the DB, against a fictional token, so what
 * arrives looks exactly like a live ping without implying a real signal.
 *
 *   npx tsx scripts/test-alpha-confluence-ping.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { loadAlphaWallets } from "../src/lib/api/alpha-wallets";
import {
  sendConfluenceAlert,
  sendConfluenceFollowUp,
  formatConfluenceAlert,
  formatConfluenceFollowUp,
  type AlphaBuyer,
  type ConfluenceToken,
} from "../src/lib/telegram/alpha-alerts";
import { alertRecipients, hasAlertsBot } from "../src/lib/telegram/alerts-bot";

const MOCK_CA = "0xB4EAD1c0FFEE5f00DbeeF1234567890AbCdEf7777";

async function main() {
  const wallets = [...(await loadAlphaWallets("rh")).values()].sort(
    (a, b) => (b.totalPnlUsd ?? 0) - (a.totalPnlUsd ?? 0)
  );
  if (wallets.length < 3) throw new Error("need at least 3 alpha wallets seeded");

  const token: ConfluenceToken = {
    chain: "rh",
    address: MOCK_CA,
    symbol: "BREAD",
    name: "breadcoin",
    liquidityUsd: 310_000,
    currentMcUsd: 2_000_000,
    firstAlertMcUsd: 2_000_000,
  };

  const first: AlphaBuyer[] = [
    { label: wallets[0].label, address: wallets[0].address, amountUsd: 5_000, marketCapUsd: 2_000_000, supplyPct: 0.25 },
    { label: wallets[1].label, address: wallets[1].address, amountUsd: 3_000, marketCapUsd: 2_100_000, supplyPct: 0.14 },
  ];
  const joiner: AlphaBuyer = {
    label: wallets[2].label,
    address: wallets[2].address,
    amountUsd: 11_000,
    marketCapUsd: 4_000_000,
    supplyPct: 0.27,
  };

  console.log("──────── ping 1 (confluence reached) ────────\n");
  console.log(formatConfluenceAlert(token, first));
  console.log("\n──────── ping 2 (third wallet joins) ────────\n");
  // The token has run since the first ping — that move is the point of the follow-up.
  const later: ConfluenceToken = { ...token, currentMcUsd: 5_000_000, liquidityUsd: 520_000 };
  console.log(formatConfluenceFollowUp(later, joiner, first));

  if (!hasAlertsBot() || alertRecipients().length === 0) {
    console.log("\nalerts bot not configured — printed only.");
    return;
  }
  await sendConfluenceAlert(token, first);
  await sendConfluenceFollowUp(later, joiner, first);
  console.log(`\nsent both pings to ${alertRecipients().length} recipient(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
