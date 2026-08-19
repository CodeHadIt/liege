/**
 * Add (or update) a single alpha wallet by hand.
 *
 *   npx tsx scripts/add-alpha-wallet.ts --chain solana --address <addr> --label CyberLeeks
 *   npx tsx scripts/add-alpha-wallet.ts --chain solana --address <addr> --label X --write
 *
 * The backfills promote wallets in bulk from a measured corpus. This is for the
 * other case: a wallet someone wants watched now, on judgement rather than a
 * dataset. It records that difference in `source` so a hand-added wallet is
 * never mistaken for one that cleared the $20k/2-runner bar.
 *
 * Dry run is the default — this writes to the table that drives live alerts.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { supabase } from "../src/lib/supabase";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

const CHAIN = arg("chain");
const ADDRESS = arg("address");
const LABEL = arg("label");
const NOTES = arg("notes");
const WRITE = process.argv.includes("--write");

/** Solana is base58; EVM chains are 0x + 40 hex. */
function validAddress(chain: string, address: string): boolean {
  if (chain === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

async function main() {
  if (!CHAIN || !ADDRESS || !LABEL) {
    console.error("usage: --chain <solana|rh|bsc|base|ethereum> --address <addr> --label <label> [--notes <text>] [--write]");
    process.exit(1);
  }
  if (!validAddress(CHAIN, ADDRESS)) {
    console.error(`address does not look valid for chain "${CHAIN}": ${ADDRESS}`);
    process.exit(1);
  }

  // Addresses are stored lowercase on EVM chains, where they are
  // case-insensitive. Solana base58 is case-SENSITIVE — lowercasing one
  // silently produces a different, non-existent wallet.
  const address = CHAIN === "solana" ? ADDRESS : ADDRESS.toLowerCase();

  const { data: existing } = await supabase
    .from("alpha_wallets")
    .select("id,label,is_active,source,added_at")
    .eq("chain", CHAIN)
    .eq("address", address)
    .maybeSingle();

  const { data: labelClash } = await supabase
    .from("alpha_wallets")
    .select("id,chain,address")
    .eq("label", LABEL)
    .maybeSingle();
  if (labelClash && labelClash.address !== address) {
    console.error(`label "${LABEL}" is already used by ${labelClash.chain}:${labelClash.address} — labels are UNIQUE`);
    process.exit(1);
  }

  console.log(`chain   : ${CHAIN}`);
  console.log(`address : ${address}`);
  console.log(`label   : ${LABEL}`);
  console.log(`existing: ${existing ? `yes (added ${existing.added_at}, active=${existing.is_active})` : "no — new wallet"}`);

  if (!WRITE) {
    console.log("\nDRY RUN — nothing written. Re-run with --write.");
    return;
  }

  const row = {
    label: LABEL,
    address,
    chain: CHAIN,
    token_count: 0,
    tokens: [] as string[],
    total_pnl_usd: null,
    total_invested_usd: null,
    aggregate_roi_pct: null,
    best_rank: null,
    max_tx_on_a_token: null,
    // Marks this as a judgement call, not a corpus promotion. Anything that
    // recomputes the alpha list from a dataset must not silently drop it.
    source: "manual",
    notes: NOTES ?? `added by hand ${new Date().toISOString().slice(0, 10)}`,
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("alpha_wallets").upsert(row, { onConflict: "chain,address" });
  if (error) throw new Error(error.message);
  console.log(`\n${existing ? "updated" : "added"}: ${LABEL} (${CHAIN})`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
