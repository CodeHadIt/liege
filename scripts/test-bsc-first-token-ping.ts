/**
 * Find the FIRST token ever launched against a given tokenized stock on each
 * BSC launchpad, by scanning bonding-curve creation events forward from a start
 * date, and send the alert for each.
 *
 * Detection is on-chain because indexers can't answer this: DexScreener caps its
 * pair list and relabels a migrated Flap token as `pancakeswap`, so its "oldest
 * pair" is not the first launch.
 *
 * Renders the alert always; sends to Telegram only when the alerts bot is
 * configured (TELEGRAM_ALERTS_API_KEY + ALERTS_ALLOWLIST).
 *
 *   npx tsx scripts/test-bsc-first-token-ping.ts [SYMBOL] [START_ISO]
 *   npx tsx scripts/test-bsc-first-token-ping.ts NVDAB 2026-07-28T00:00:00Z
 */
// Next loads .env.local itself, but this script runs standalone under tsx, so
// the alerts-bot credentials have to be pulled in explicitly.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { fetchFlapPaymentTokens, FLAP_BSC_CHAIN_ID } from "../src/lib/api/flap";
import {
  getLatestBscBlock,
  getFlapLaunches,
  getFourMemeLaunches,
  getFourMemeQuote,
  getBscTokenMeta,
  ZERO_ADDRESS,
  type BscLaunch,
} from "../src/lib/api/bsc-onchain";
import { fetchBscTokenStats } from "../src/lib/api/bsc-launches";
import {
  formatBscFirstTokenAlert,
  sendBscFirstTokenTestPing,
  type FirstTokenWatch,
  type Platform,
} from "../src/lib/telegram/bsc-stock-alerts";
import { alertRecipients, hasAlertsBot, getAlertsBot } from "../src/lib/telegram/alerts-bot";

const RPC = "https://bsc-rpc.publicnode.com";

async function blockTimestamp(n: number): Promise<number> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["0x" + n.toString(16), false],
    }),
  });
  const j = await res.json();
  return parseInt(j.result.timestamp, 16);
}

/** First block at or after `ts`, by binary search. */
async function blockAtTimestamp(ts: number, latest: number): Promise<number> {
  let lo = 1;
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTimestamp(mid)) < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const STEP = 20_000; // blocks per scan window (chunked to 1k internally)

async function findFirst(
  platform: Platform,
  stockAddress: string,
  from: number,
  latest: number
): Promise<BscLaunch | null> {
  let attempts = 0;
  for (let start = from; start <= latest; start += STEP) {
    const end = Math.min(start + STEP - 1, latest);
    const launches =
      platform === "flap"
        ? await getFlapLaunches(start, end)
        : await getFourMemeLaunches(start, end);
    if (launches == null) {
      // Public BSC nodes are pruned: logs older than a few days aren't served at
      // all, so a window can never succeed no matter how often it's retried.
      // Bound the retries and surface the horizon rather than spinning.
      if (++attempts >= 3) {
        throw new Error(
          `[${platform}] RPC cannot serve logs at block ${start} after ${attempts} attempts — ` +
            `public BSC endpoints only retain recent history. Use an archival RPC ` +
            `(BSC_ARCHIVE_RPC_URL) or pass a later start date.`
        );
      }
      console.log(`   [${platform}] RPC failure at ${start}..${end}, retry ${attempts}/3`);
      start -= STEP; // retry the same window
      continue;
    }
    attempts = 0;
    for (const l of launches) {
      let quote = l.quoteAddress;
      if (!quote) quote = (await getFourMemeQuote(l.tokenAddress)) ?? "";
      if (!quote || quote === ZERO_ADDRESS) continue;
      if (quote.toLowerCase() === stockAddress) {
        l.quoteAddress = quote;
        return l;
      }
    }
    const pct = (((end - from) / (latest - from)) * 100).toFixed(1);
    process.stdout.write(`\r   [${platform}] scanned to block ${end} (${pct}%)   `);
  }
  return null;
}

/**
 * Explicit-token mode. Free BSC endpoints won't serve logs more than a couple of
 * days back, so the historical "first ever" launch can't be discovered by
 * scanning without an archival RPC. Passing the token directly renders (and
 * sends) the real alert using current-state calls only.
 *
 *   --token flap:0xabc… --token fourmeme:0xdef…
 */
function parseTokenArgs(argv: string[]): Array<{ platform: Platform; address: string }> {
  const out: Array<{ platform: Platform; address: string }> = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--token") continue;
    const [platform, address] = (argv[i + 1] ?? "").split(":");
    if ((platform === "flap" || platform === "fourmeme") && /^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
      out.push({ platform, address: address.toLowerCase() });
    }
  }
  return out;
}

async function main() {
  const symbol = (process.argv[2] ?? "NVDAB").toUpperCase();
  const explicit = parseTokenArgs(process.argv);
  const startIso = process.argv[3]?.startsWith("--") ? "2026-07-28T00:00:00Z" : (process.argv[3] ?? "2026-07-28T00:00:00Z");

  const flapTokens = await fetchFlapPaymentTokens();
  const stock = flapTokens.find(
    (t) => t.chainId === FLAP_BSC_CHAIN_ID && t.symbol.toUpperCase() === symbol && t.address
  );
  if (!stock?.address) throw new Error(`${symbol} not found in Flap's BNB Chain catalog`);
  const stockAddress = stock.address.toLowerCase();
  console.log(`stock: ${stock.symbol} (${stock.name})  ${stockAddress}`);

  const latest = await getLatestBscBlock();
  if (latest == null) throw new Error("could not read latest BSC block");

  const canSend = hasAlertsBot() && alertRecipients().length > 0;
  console.log(
    canSend
      ? `alerts bot configured — will send to ${alertRecipients().length} recipient(s)\n`
      : `alerts bot NOT configured (TELEGRAM_ALERTS_API_KEY / ALERTS_ALLOWLIST) — dry run only\n`
  );

  if (explicit.length > 0) {
    for (const { platform, address } of explicit) {
      console.log(`── ${platform} ──────────────────────────────`);
      const meta = await getBscTokenMeta(address);
      const launch: BscLaunch = {
        platform,
        tokenAddress: address,
        quoteAddress: stockAddress,
        name: meta.name,
        symbol: meta.symbol,
        blockNumber: 0,
        txHash: "",
      };
      const w: FirstTokenWatch = {
        platform,
        stockAddress,
        symbol: stock.symbol,
        name: stock.name,
        addedAt: Date.now(),
      };
      const stats = await fetchBscTokenStats(address);
      console.log("\n" + formatBscFirstTokenAlert(w, { launch, ...stats }) + "\n");
      if (canSend) {
        for (const chatId of alertRecipients()) {
          const bot = await getAlertsBot();
          const text = formatBscFirstTokenAlert(w, { launch, ...stats });
          await bot.api.sendMessage(chatId, text, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
          console.log(`   sent to ${chatId}: OK`);
        }
        console.log("");
      }
    }
    return;
  }

  const startTs = Math.floor(new Date(startIso).getTime() / 1000);
  const fromBlock = await blockAtTimestamp(startTs, latest);
  console.log(`scanning from ${startIso} (block ${fromBlock}) to ${latest}\n`);
  for (const platform of ["flap", "fourmeme"] as Platform[]) {
    console.log(`── ${platform} ──────────────────────────────`);
    const first = await findFirst(platform, stockAddress, fromBlock, latest);
    process.stdout.write("\r");
    if (!first) {
      console.log(`   no launch against ${symbol} found on ${platform}\n`);
      continue;
    }
    if (!first.symbol && !first.name) {
      const meta = await getBscTokenMeta(first.tokenAddress);
      first.name = meta.name;
      first.symbol = meta.symbol;
    }
    const ts = await blockTimestamp(first.blockNumber);
    console.log(
      `   FIRST: ${first.symbol || first.tokenAddress} at block ${first.blockNumber} ` +
        `(${new Date(ts * 1000).toISOString()})  tx ${first.txHash}`
    );

    const w: FirstTokenWatch = {
      platform,
      stockAddress,
      symbol: stock.symbol,
      name: stock.name,
      addedAt: Date.now(),
    };
    const stats = await fetchBscTokenStats(first.tokenAddress);
    console.log("\n" + formatBscFirstTokenAlert(w, { launch: first, ...stats }) + "\n");

    if (canSend) {
      for (const chatId of alertRecipients()) {
        const ok = await sendBscFirstTokenTestPing(
          chatId,
          platform,
          symbol,
          first.blockNumber,
          first.blockNumber
        );
        console.log(`   sent to ${chatId}: ${ok ? "OK" : "FAILED"}`);
      }
      console.log("");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
