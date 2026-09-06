/**
 * Seed StonkFun's current quote catalog into the seen-set WITHOUT alerting.
 *
 * The quote feed stopped fetching on 2026-09-03 and went unnoticed for two days,
 * so 32 quotes accumulated unseen. Fixing the fetch without this would fire all
 * of them at once — a two-day-old listing announced as news is worse than
 * silence, because it teaches you to distrust the feed's timing.
 *
 * This marks everything currently listed as already-known, so the repaired
 * poller starts clean and only reports genuinely NEW additions.
 *
 * Deliberately not automatic. A poller that silently absorbs its own backlog is
 * how the original bug hid; this is a one-off, run by hand, that says exactly
 * what it suppressed.
 *
 *   npx tsx scripts/reconcile-stonkfun-quotes.ts          # dry run
 *   npx tsx scripts/reconcile-stonkfun-quotes.ts --write
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { fetchQuoteTokens } from "../src/lib/api/stonkfun";
import { FEED, loadSeen, markSeen } from "../src/lib/api/feed-seen";

async function main() {
  const write = process.argv.includes("--write");

  const quotes = await fetchQuoteTokens();
  if (!quotes || quotes.length === 0) {
    console.error("quote catalog came back empty — refusing to reconcile against nothing");
    process.exit(1);
  }

  const seen = await loadSeen(FEED.STONKFUN_QUOTES);
  if (seen === null) {
    console.error("could not read the seen-set — aborting rather than guessing");
    process.exit(1);
  }

  const missing = quotes.filter((q) => !seen.has(q.quoteMint));
  const alertable = missing.filter((q) => q.category.toLowerCase() !== "custom");

  console.log(`catalog: ${quotes.length} quotes`);
  console.log(`seen-set: ${seen.size}`);
  console.log(`unseen: ${missing.length}  (${alertable.length} would have alerted, ${missing.length - alertable.length} are 'custom' and suppressed)\n`);

  console.log("would be suppressed as stale — these are the alerts you are choosing NOT to get:");
  for (const q of alertable) {
    console.log(`  ${q.symbol.padEnd(14)} ${q.category.padEnd(12)} ${q.quoteMint}`);
  }

  if (!write) {
    console.log(`\nDRY RUN — nothing written. Re-run with --write to seed ${missing.length} keys.`);
    return;
  }

  await markSeen(FEED.STONKFUN_QUOTES, missing.map((q) => q.quoteMint));
  const after = await loadSeen(FEED.STONKFUN_QUOTES);
  console.log(`\nseeded ${missing.length} keys — seen-set is now ${after?.size ?? "?"} of ${quotes.length}`);
  console.log("the repaired poller will now only report NEW additions.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
