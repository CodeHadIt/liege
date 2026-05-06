/**
 * TON Center v3 API — endpoint test script
 * Run: node scripts/test-ton.mjs
 */

const API_KEY    = "50ba011186f5194e22ce7c7351ab4856f5ad60e6ee5f51b5bbdaf11457b250e9";
const BASE       = "https://toncenter.com";
const TOKEN_ADDR = "EQBaCgUwOoc6gHCNln_oJzb0mVs79YG7wYoavh-o1ItaneLA";
const WALLET_ADDR= "UQAAvHoJrVSl1Lf9GwydMgJp97Ge89cWXdXStUdYA127KMbH";

const headers = { "X-API-Key": API_KEY, Accept: "application/json" };

async function get(path) {
  const url = `${BASE}${path}`;
  console.log(`\n→ GET ${url}`);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`  ✗ HTTP ${res.status}: ${await res.text()}`);
    return null;
  }
  return res.json();
}

// ── 1. Jetton Master (token metadata) ────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log(" 1. JETTON MASTER — token metadata");
console.log("══════════════════════════════════════════");

const mastersData = await get(`/api/v3/jetton/masters?address=${TOKEN_ADDR}&limit=1`);
if (mastersData) {
  const master = mastersData.jetton_masters?.[0];
  const meta   = mastersData.metadata?.[master?.address]?.token_info?.[0];
  const book   = mastersData.address_book?.[master?.address];

  console.table({
    address:        master?.address ?? "—",
    user_friendly:  book?.user_friendly ?? "—",
    name:           meta?.name ?? "—",
    symbol:         meta?.symbol ?? "—",
    description:    (meta?.description ?? "—").slice(0, 80),
    image:          meta?.image ?? "—",
    total_supply:   master?.total_supply ?? "—",
    mintable:       master?.mintable ?? "—",
    admin_address:  master?.admin_address ?? "—",
  });
}

// ── 2. Top Holders (jetton wallets sorted desc by balance) ───────────────────
console.log("\n══════════════════════════════════════════");
console.log(" 2. TOP HOLDERS — jetton wallets for token");
console.log("══════════════════════════════════════════");

const holdersData = await get(
  `/api/v3/jetton/wallets?jetton_address=${TOKEN_ADDR}&exclude_zero_balance=true&limit=10&sort=desc`
);
if (holdersData) {
  const rows = (holdersData.jetton_wallets ?? []).map((w, i) => {
    const book = holdersData.address_book?.[w.owner] ?? {};
    return {
      rank:         i + 1,
      owner:        book.user_friendly ?? w.owner ?? "—",
      balance_raw:  w.balance ?? "—",
      jetton_wallet: w.address ?? "—",
    };
  });
  console.table(rows);
}

// ── 3. Wallet Jetton Balances ─────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log(" 3. WALLET JETTON BALANCES");
console.log("══════════════════════════════════════════");

const walletJettonsData = await get(
  `/api/v3/jetton/wallets?owner_address=${WALLET_ADDR}&exclude_zero_balance=true&limit=50`
);
if (walletJettonsData) {
  const rows = (walletJettonsData.jetton_wallets ?? []).map((w) => {
    const jettonMeta = walletJettonsData.metadata?.[w.jetton]?.token_info?.[0];
    return {
      symbol:     jettonMeta?.symbol ?? "—",
      name:       jettonMeta?.name ?? "—",
      balance:    w.balance ?? "—",
      jetton_master: w.jetton ?? "—",
    };
  });
  console.table(rows.length ? rows : [{ note: "No jetton balances found" }]);
}

// ── 4. Wallet Transaction History ────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log(" 4. WALLET TRANSACTION HISTORY (recent 10)");
console.log("══════════════════════════════════════════");

const txData = await get(
  `/api/v3/transactions?account=${WALLET_ADDR}&limit=10&sort=desc`
);
if (txData) {
  const rows = (txData.transactions ?? []).map((tx) => {
    const inMsg  = tx.in_msg;
    const outMsgs = tx.out_msgs ?? [];
    return {
      hash:       (tx.hash ?? "—").slice(0, 16) + "…",
      time_utc:   tx.now ? new Date(tx.now * 1000).toISOString() : "—",
      lt:         tx.lt ?? "—",
      total_fees: tx.total_fees ?? "—",
      in_value:   inMsg?.value ?? "—",
      out_count:  outMsgs.length,
      out_value:  outMsgs[0]?.value ?? "—",
      op_code:    inMsg?.opcode ?? "—",
    };
  });
  console.table(rows.length ? rows : [{ note: "No transactions found" }]);
}

// ── 5. Wallet Jetton Transfers ────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log(" 5. WALLET JETTON TRANSFERS (recent 10)");
console.log("══════════════════════════════════════════");

const transfersData = await get(
  `/api/v3/jetton/transfers?owner_address=${WALLET_ADDR}&limit=10&sort=desc`
);
if (transfersData) {
  const rows = (transfersData.jetton_transfers ?? []).map((t) => {
    const meta  = transfersData.metadata?.[t.jetton_master]?.token_info?.[0];
    const srcBook = transfersData.address_book?.[t.source_wallet] ?? {};
    const dstBook = transfersData.address_book?.[t.destination_wallet] ?? {};
    return {
      symbol:      meta?.symbol ?? "—",
      amount:      t.amount ?? "—",
      direction:   t.source_wallet === WALLET_ADDR ? "OUT" : "IN",
      from:        (srcBook.user_friendly ?? t.source ?? "—").slice(0, 20) + "…",
      to:          (dstBook.user_friendly ?? t.destination ?? "—").slice(0, 20) + "…",
      time_utc:    t.transaction_now ? new Date(t.transaction_now * 1000).toISOString() : "—",
      tx_hash:     (t.transaction_hash ?? "—").slice(0, 16) + "…",
    };
  });
  console.table(rows.length ? rows : [{ note: "No jetton transfers found" }]);
}

// ── 6. TON native balance via account state ───────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log(" 6. WALLET NATIVE TON BALANCE (account state)");
console.log("══════════════════════════════════════════");

const accountData = await get(`/api/v3/account?address=${WALLET_ADDR}`);
if (accountData) {
  const bal = accountData.balance ?? accountData.account?.balance ?? "—";
  const status = accountData.status ?? accountData.account?.status ?? "—";
  console.table({
    address:     WALLET_ADDR,
    balance_nanoton: bal,
    balance_ton: bal !== "—" ? (Number(bal) / 1e9).toFixed(6) + " TON" : "—",
    status,
    last_tx_lt:  accountData.last_transaction_lt ?? accountData.account?.last_transaction_lt ?? "—",
  });
}

// ── 7. DexScreener TON price check ───────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log(" 7. DEXSCREENER — price/market data for token");
console.log("══════════════════════════════════════════");

const dsRes = await fetch(`https://api.dexscreener.com/tokens/v1/ton/${TOKEN_ADDR}`, {
  headers: { Accept: "application/json" },
});
if (dsRes.ok) {
  const dsData = await dsRes.json();
  const pair = Array.isArray(dsData) ? dsData[0] : dsData?.pairs?.[0] ?? dsData?.[0];
  if (pair) {
    console.table({
      dex:          pair.dexId ?? "—",
      pair_address: pair.pairAddress ?? "—",
      base_symbol:  pair.baseToken?.symbol ?? "—",
      price_usd:    pair.priceUsd ?? "—",
      price_native: pair.priceNative ?? "—",
      liquidity_usd:pair.liquidity?.usd ?? "—",
      volume_24h:   pair.volume?.h24 ?? "—",
      market_cap:   pair.marketCap ?? "—",
      fdv:          pair.fdv ?? "—",
      price_chg_1h: pair.priceChange?.h1 ?? "—",
      price_chg_24h:pair.priceChange?.h24 ?? "—",
      created_at:   pair.pairCreatedAt
        ? new Date(pair.pairCreatedAt).toISOString()
        : "—",
    });
  } else {
    console.log("  No DexScreener pairs found.");
    console.log("  Raw response:", JSON.stringify(dsData).slice(0, 300));
  }
} else {
  console.error(`  DexScreener HTTP ${dsRes.status}`);
}

console.log("\n✅ Done.\n");
