/**
 * Send a confluence ping built from REAL on-chain NFT mints by alpha wallets.
 *
 * Unlike the BREAD mock, nothing here is invented: the collection, the wallets,
 * the quantities and the cost all come from the chain. Useful for confirming the
 * NFT path end to end against activity that actually happened.
 *
 *   npx tsx scripts/test-alpha-nft-ping.ts [collectionAddress] [blocksBack]
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { readFileSync } from "fs";
import {
  getRhLatestBlock,
  getTransfersToWallets,
  getTxInfo,
  getNftCollection,
  getEthUsdPrice,
  getNftSaleStats,
} from "../src/lib/api/rh-onchain";
import {
  sendConfluenceAlert,
  sendConfluenceFollowUp,
  formatConfluenceAlert,
  formatConfluenceFollowUp,
  MIN_WALLETS_TO_ALERT,
  type AlphaBuyer,
  type ConfluenceToken,
} from "../src/lib/telegram/alpha-alerts";
import { alertRecipients, hasAlertsBot } from "../src/lib/telegram/alerts-bot";
import { loadAlphaWallets } from "../src/lib/api/alpha-wallets";

const DEFAULT_COLLECTION = "0xd6577124f96394faee65afd2408f2ffa88445f63"; // Spritehood Wisp
const ZERO = "0x0000000000000000000000000000000000000000";

async function labelsFor(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for (const [addr, w] of await loadAlphaWallets("rh")) out.set(addr, w.label);
    if (out.size) return out;
  } catch {
    /* fall through to the committed watchlist */
  }
  for (const line of readFileSync("data/rh-repeat-traders.txt", "utf8").split("\n")) {
    const m = /^(0x[0-9a-fA-F]{40})/.exec(line.trim());
    if (m) out.set(m[1].toLowerCase(), m[1]);
  }
  return out;
}

async function main() {
  const collection = (process.argv[2] ?? DEFAULT_COLLECTION).toLowerCase();
  const blocksBack = parseInt(process.argv[3] ?? "400000", 10);

  const labels = await labelsFor();
  const wallets = [...labels.keys()];
  console.log(`alpha wallets: ${wallets.length}`);

  const latest = await getRhLatestBlock();
  if (latest == null) throw new Error("no RH block");

  // The mint burst may be well behind the head, so walk back in chunks.
  let hits: Awaited<ReturnType<typeof getTransfersToWallets>> = [];
  for (let back = 0; back < blocksBack; back += 50_000) {
    const lo = latest - back - 50_000;
    const hi = latest - back;
    const t = await getTransfersToWallets(wallets, lo, hi);
    const forCollection = (t ?? []).filter((x) => x.tokenAddress === collection);
    if (forCollection.length) {
      hits = forCollection;
      console.log(`found ${forCollection.length} transfers in blocks ${lo}..${hi}`);
      break;
    }
  }
  if (!hits || hits.length === 0) throw new Error("no alpha-wallet transfers found for that collection");

  // Aggregate per wallet: NFTs are minted in batches, and one tx of 50 is one act.
  const perWallet = new Map<string, { qty: number; mint: boolean; tx: string }>();
  for (const h of hits) {
    const e = perWallet.get(h.to);
    if (e) {
      e.qty += 1;
      e.mint = e.mint || h.from === ZERO;
    } else {
      perWallet.set(h.to, { qty: 1, mint: h.from === ZERO, tx: h.txHash });
    }
  }
  console.log(`distinct alpha wallets in this collection: ${perWallet.size}`);
  if (perWallet.size < MIN_WALLETS_TO_ALERT) throw new Error("not enough wallets for confluence");

  const col = await getNftCollection(collection);
  const eth = await getEthUsdPrice();
  const sales = await getNftSaleStats(collection, latest);
  console.log(
    `collection: ${col?.name} (${col?.symbol}) supply=${col?.totalSupply} holders=${col?.holders}  ETH=$${eth}`
  );
  console.log(
    sales
      ? `floor (lowest of ${sales.sales} recent fills): ${sales.lowEth.toFixed(4)} ETH  median ${sales.medianEth.toFixed(4)} ETH\n`
      : `no priced secondary sales found — floor omitted\n`
  );

  const buyers: AlphaBuyer[] = [];
  for (const [addr, info] of perWallet) {
    const tx = await getTxInfo(info.tx);
    const spentUsd = tx && eth != null ? (Number(tx.valueWei) / 1e18) * eth : null;
    buyers.push({
      label: labels.get(addr) ?? addr,
      address: addr,
      amountUsd: spentUsd,
      marketCapUsd: null,
      supplyPct: col?.totalSupply ? (info.qty / col.totalSupply) * 100 : null,
      quantity: info.qty,
      isMint: info.mint,
    });
  }

  const token: ConfluenceToken = {
    chain: "rh",
    address: collection,
    symbol: col?.symbol ?? "?",
    name: col?.name ?? "",
    liquidityUsd: null,
    currentMcUsd: null,
    firstAlertMcUsd: null,
    assetType: "erc721",
    totalSupply: col?.totalSupply ?? null,
    holders: col?.holders ?? null,
    floorEth: sales?.lowEth ?? null,
    floorUsd: sales && eth != null ? sales.lowEth * eth : null,
    floorSales: sales?.sales ?? null,
  };

  const first = buyers.slice(0, MIN_WALLETS_TO_ALERT);
  console.log("──── ping 1 ────\n");
  console.log(formatConfluenceAlert(token, first));

  const joiner = buyers[MIN_WALLETS_TO_ALERT];
  if (joiner) {
    console.log("\n──── ping 2 ────\n");
    console.log(formatConfluenceFollowUp(token, joiner, first));
  }

  if (!hasAlertsBot() || alertRecipients().length === 0) {
    console.log("\nalerts bot not configured — printed only.");
    return;
  }
  await sendConfluenceAlert(token, first);
  if (joiner) await sendConfluenceFollowUp(token, joiner, first);
  console.log(`\nsent to ${alertRecipients().length} recipient(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
