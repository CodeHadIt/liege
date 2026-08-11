/**
 * Backfill ath_tokens / token_deployers / ath_token_traders from the research
 * dataset, so the daily scan's cross-reference has history from day one.
 *
 * Without this the first run compares today's traders against an empty corpus
 * and can never promote anyone — the whole mechanism needs prior winners to
 * match against.
 *
 *   npx tsx scripts/backfill-ath-tokens.ts            # preview
 *   npx tsx scripts/backfill-ath-tokens.ts --write
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { readFileSync } from "fs";
import {
  upsertAthToken,
  upsertDeployer,
  saveTokenTraders,
  fetchDeployer,
  fetchHolders,
  launchpadFromFactory,
} from "../src/lib/api/ath-tokens";
import type { GmgnTopTrader } from "../src/lib/api/gmgn-scraper";

const CHAIN = "rh";
const SOURCE = "backfill:rh-ath-2m-60d";

interface ReportToken {
  tokenAddress: string;
  name: string;
  symbol: string;
  launchDate: string | null;
  launchpadId: string | null;
  athMcUsd: number | null;
  athDate: string | null;
  currentMcUsd: number | null;
  totalSupply: number | null;
  poolAddress: string | null;
  topTraders: Array<{ walletAddress: string }>;
}

async function main() {
  const write = process.argv.includes("--write");
  const report = JSON.parse(readFileSync("data/rh-ath-2m-60d.json", "utf8"));
  const tokens: ReportToken[] = report.tokens ?? [];
  // The raw GMGN payloads still carry every field the traders table wants; the
  // report itself is already trimmed to 30 and reshaped.
  const cache: Record<string, GmgnTopTrader[]> = JSON.parse(
    readFileSync("data/rh-traders-cache.json", "utf8")
  );

  console.log(`tokens in dataset: ${tokens.length}`);
  console.log(`trader payloads cached: ${Object.keys(cache).length}\n`);
  if (!write) {
    for (const t of tokens.slice(0, 8)) {
      console.log(`  ${(t.symbol || "?").padEnd(14)} ath=$${Math.round(t.athMcUsd ?? 0).toLocaleString().padStart(12)}  traders=${cache[t.tokenAddress]?.length ?? 0}`);
    }
    console.log(`\nPREVIEW ONLY — re-run with --write.`);
    return;
  }

  let tokensWritten = 0;
  let tradersWritten = 0;

  for (const [i, t] of tokens.entries()) {
    const { deployer, factory } = await fetchDeployer(t.tokenAddress);
    const holders = await fetchHolders(t.tokenAddress);

    const tokenId = await upsertAthToken({
      chain: CHAIN,
      tokenAddress: t.tokenAddress,
      name: t.name,
      symbol: t.symbol,
      // The dataset's launchpadId only covers pools.trade launches; the token's
      // deployer factory identifies the rest.
      launchpad: t.launchpadId ?? launchpadFromFactory(factory),
      deployerAddress: deployer,
      athMcUsd: t.athMcUsd,
      athAt: t.athDate,
      currentMcUsd: t.currentMcUsd,
      holders,
      totalSupply: t.totalSupply,
      poolAddress: t.poolAddress,
      launchedAt: t.launchDate,
      source: SOURCE,
    });
    if (!tokenId) continue;
    tokensWritten++;
    await upsertDeployer(CHAIN, deployer);

    const raw = cache[t.tokenAddress] ?? [];
    if (raw.length > 0) {
      // Same bot rule as the research pipeline and the daily scan.
      const bots = new Map<string, { bot: boolean; reason: string | null }>();
      for (const r of raw) {
        const tx = r.buyCount + r.sellCount;
        bots.set(r.walletAddress.toLowerCase(), {
          bot: tx >= 1_000,
          reason: tx >= 1_000 ? `${tx.toLocaleString()} trades on this token` : null,
        });
      }
      tradersWritten += await saveTokenTraders(
        tokenId,
        CHAIN,
        t.tokenAddress,
        t.symbol,
        raw.slice(0, 30),
        t.totalSupply,
        (addr) => bots.get(addr) ?? { bot: false, reason: null }
      );
    }
    console.log(`  [${i + 1}/${tokens.length}] ${t.symbol} — deployer=${deployer?.slice(0, 10) ?? "?"} traders=${raw.length ? Math.min(raw.length, 30) : 0}`);
  }

  console.log(`\n════ backfilled ════`);
  console.log(`  tokens : ${tokensWritten}`);
  console.log(`  traders: ${tradersWritten}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
