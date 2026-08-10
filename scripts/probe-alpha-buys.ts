/**
 * Dry-run the alpha-wallet buy detection over recent blocks. Reports what the
 * watcher WOULD have seen — no DB writes, no alerts.
 *
 *   npx tsx scripts/probe-alpha-buys.ts [blocksBack]
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { readFileSync } from "fs";
import { loadAlphaWallets } from "../src/lib/api/alpha-wallets";
import {
  getRhLatestBlock,
  getTransfersToWallets,
  getTxSender,
  getRhTokenDecimals,
} from "../src/lib/api/rh-onchain";

async function market(token: string) {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${token}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = Array.isArray(data) ? data : (data?.pairs ?? []);
    interface P { baseToken?: { symbol?: string }; priceUsd?: string; marketCap?: number; fdv?: number; liquidity?: { usd?: number } }
    const pool = (pairs as P[]).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!pool) return null;
    return {
      symbol: pool.baseToken?.symbol ?? "?",
      price: pool.priceUsd ? parseFloat(pool.priceUsd) : null,
      mc: pool.marketCap ?? pool.fdv ?? null,
      liq: pool.liquidity?.usd ?? null,
    };
  } catch {
    return null;
  }
}

async function main() {
  const back = parseInt(process.argv[2] ?? "5000", 10);
  // Detection itself needs no database, so fall back to the committed watchlist
  // when Supabase is unreachable — that way the on-chain path stays testable.
  let wallets: Map<string, { label: string; address: string }>;
  try {
    const db = await loadAlphaWallets("rh");
    wallets = new Map([...db].map(([k, w]) => [k, { label: w.label, address: w.address }]));
    console.log(`alpha wallets (from DB): ${wallets.size}`);
  } catch {
    wallets = new Map();
    for (const line of readFileSync("data/rh-repeat-traders.txt", "utf8").split("\n")) {
      const m = /^(0x[0-9a-fA-F]{40})\s+#\s*(.*)$/.exec(line.trim());
      if (m) wallets.set(m[1].toLowerCase(), { label: m[2].split("|")[0].trim(), address: m[1].toLowerCase() });
    }
    console.log(`alpha wallets (DB unreachable, using watchlist file): ${wallets.size}`);
  }

  const latest = await getRhLatestBlock();
  if (latest == null) throw new Error("no RH block");
  const from = latest - back;
  console.log(`scanning blocks ${from}..${latest}\n`);

  const transfers = await getTransfersToWallets([...wallets.keys()], from, latest);
  if (transfers == null) throw new Error("getLogs failed");
  console.log(`inbound transfers to alpha wallets: ${transfers.length}`);

  const cand = new Map<string, { tx: string; wallet: string; token: string; raw: bigint }>();
  for (const t of transfers) {
    const k = `${t.txHash}:${t.to}:${t.tokenAddress}`;
    const ex = cand.get(k);
    if (ex) ex.raw += t.rawValue;
    else cand.set(k, { tx: t.txHash, wallet: t.to, token: t.tokenAddress, raw: t.rawValue });
  }
  console.log(`distinct (tx, wallet, token): ${cand.size}\n`);

  let buys = 0;
  const perToken = new Map<string, Set<string>>();
  for (const c of cand.values()) {
    const sender = await getTxSender(c.tx);
    const isBuy = sender === c.wallet;
    const w = wallets.get(c.wallet)!;
    if (!isBuy) {
      console.log(`  ✗ ${w.label} — received ${c.token.slice(0, 10)}… but tx sent by ${String(sender).slice(0, 10)}… (not a buy)`);
      continue;
    }
    buys++;
    const dec = await getRhTokenDecimals(c.token);
    const amt = Number(c.raw) / 10 ** dec;
    const m = await market(c.token);
    perToken.set(c.token, (perToken.get(c.token) ?? new Set()).add(c.wallet));
    const usd = m?.price != null ? `$${(amt * m.price).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "?";
    console.log(
      `  ✓ BUY ${w.label.padEnd(30)} ${m?.symbol ?? "?"} ${usd}  mc=${m?.mc ? "$" + (m.mc / 1e6).toFixed(2) + "M" : "?"}  ${c.token}`
    );
  }

  console.log(`\nbuys detected: ${buys}`);
  const conf = [...perToken.entries()].filter(([, s]) => s.size >= 2);
  console.log(`tokens with 2+ distinct alpha buyers in this range: ${conf.length}`);
  for (const [tok, s] of conf) console.log(`  ⚡ ${tok} — ${s.size} wallets`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
