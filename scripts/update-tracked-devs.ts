/**
 * Update the tracked-DEV export — deployers of $2M-ATH tokens on Robinhood Chain.
 *
 *   npx tsx scripts/update-tracked-devs.ts            # preview the diff
 *   npx tsx scripts/update-tracked-devs.ts --write
 *
 * Sibling of scripts/update-tracked-wallets.ts, with the same guarantees:
 * new devs land at the bottom under a dated batch header, and a dev keeps its
 * icon across re-runs. Two files again, because JSON has no comment syntax:
 *
 *   data/tracked-devs.json   strict JSON — this is the one you import
 *   data/tracked-devs.jsonc  the same list with `// Added <date>` batch headers
 *
 * WHAT COUNTS AS A DEV HERE
 *
 * `token_deployers` currently holds every address that deployed a token which
 * reached a $2M ATH — one runner each. It is NOT the curated "alpha deployer"
 * set: nobody is flagged `is_alpha`, because that bar is 2+ runners and the only
 * address that ever cleared it (RH_nvda_spcx_Dep) was removed as a tokenized
 * stock rather than a real dev. So this export is the broader deployer list, and
 * the promoted-alpha subset is empty by construction until someone ships a
 * second $2M token.
 *
 * NAMES ARE DERIVED, NOT STORED
 *
 * These rows have no `label` — labelling happens on promotion to alpha, which
 * hasn't occurred. Names are therefore built from the dev's $2M token via
 * `ath_tokens`, following the established convention: RH_<symbol>_Dep. Devs
 * whose token can't be resolved fall back to an address-derived name so they are
 * still exported rather than silently dropped.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { existsSync, readFileSync, writeFileSync } from "fs";
import { supabase } from "../src/lib/supabase";

const JSON_PATH = "data/tracked-devs.json";
const JSONC_PATH = "data/tracked-devs.jsonc";

/** Devs sit in their own group alongside Main. */
const GROUPS = ["Main", "RobinhoodDevs"];

/**
 * Every dev gets a pan or a pot — they're cooking.
 *
 * Unlike the alpha wallets, the icon is not an identity here: the point is that
 * a dev is recognisable as a dev at a glance in the feed. Cycling a few pan/pot
 * variants keeps the list readable without ever breaking that association.
 */
const COOKING_EMOJI = ["🍳", "🍲", "🥘", "🫕"];

interface TrackedWallet {
  trackedWalletAddress: string;
  name: string;
  emoji: string;
  alertsOnToast: boolean;
  alertsOnBubble: boolean;
  alertsOnFeed: boolean;
  groups: string[];
  sound: string;
}

function makeEntry(address: string, name: string, emoji: string): TrackedWallet {
  return {
    trackedWalletAddress: address,
    name,
    emoji,
    alertsOnToast: true,
    alertsOnBubble: true,
    alertsOnFeed: true,
    groups: [...GROUPS],
    sound: "default",
  };
}

function loadExisting(): Map<string, TrackedWallet> {
  const map = new Map<string, TrackedWallet>();
  if (!existsSync(JSON_PATH)) return map;
  try {
    const parsed = JSON.parse(readFileSync(JSON_PATH, "utf8")) as TrackedWallet[];
    for (const w of parsed) {
      if (w?.trackedWalletAddress) map.set(w.trackedWalletAddress.toLowerCase(), w);
    }
  } catch (e) {
    throw new Error(`${JSON_PATH} exists but could not be parsed: ${String(e)}`);
  }
  return map;
}

/** Strip characters that make a name awkward to read or type. */
function cleanSymbol(symbol: string): string {
  return (symbol ?? "").replace(/[^\w]/g, "").trim();
}

const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
const RPC_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://robinhoodchain.blockscout.com",
  Referer: "https://robinhoodchain.blockscout.com/",
};

/**
 * Is this address a contract? Answered by `eth_getCode`, with retries.
 *
 * `isContractAddress()` in ath-tokens.ts is NOT used here on purpose. It asks
 * Blockscout and returns `false` on any fetch failure — "unknown, treat as a
 * wallet" — which is a sane fail-open for the alerting path but wrong for an
 * export: a transient blip silently reclassifies a launchpad factory as a dev.
 * Running it twice over this table genuinely returned 9 contracts and then 7.
 *
 * `eth_getCode` is definitive (non-empty code = contract) and comes straight
 * from a node, and an address that still cannot be classified after retries is
 * reported rather than quietly assumed to be a wallet.
 */
async function isContract(address: string): Promise<boolean | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(RH_RPC, {
        method: "POST",
        headers: RPC_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getCode",
          params: [address, "latest"],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const json = await res.json();
        const code = json?.result;
        if (typeof code === "string") return code !== "0x" && code.length > 2;
      }
    } catch {
      // fall through to retry
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null; // undetermined — caller decides, loudly
}

function renderJsonc(batches: Array<{ date: string; entries: TrackedWallet[] }>): string {
  const lines: string[] = ["["];
  const total = batches.reduce((n, b) => n + b.entries.length, 0);
  let written = 0;
  for (const batch of batches) {
    const plural = batch.entries.length === 1 ? "dev" : "devs";
    lines.push(`  // ── Added ${batch.date} — ${batch.entries.length} ${plural} ${"─".repeat(28)}`);
    for (const entry of batch.entries) {
      written++;
      const body = JSON.stringify(entry, null, 2)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
      lines.push(written < total ? `${body},` : body);
    }
  }
  lines.push("]");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const write = process.argv.includes("--write");

  const [{ data: deployers, error: depErr }, { data: tokens, error: tokErr }] = await Promise.all([
    supabase
      .from("token_deployers")
      .select("address,label,chain,is_alpha,ath_token_count,first_seen_at")
      .order("first_seen_at", { ascending: true }),
    supabase.from("ath_tokens").select("symbol,deployer_address,ath_mc_usd"),
  ]);

  if (depErr) throw new Error(`token_deployers read failed: ${depErr.message}`);
  if (tokErr) throw new Error(`ath_tokens read failed: ${tokErr.message}`);

  const allRows = (deployers ?? []).filter((r) => r.address);
  if (allRows.length === 0) {
    throw new Error("no deployers found — refusing to overwrite the export with an empty list");
  }

  // Contracts must never enter a dev list. token_deployers holds launchpad
  // factories alongside real devs — the creator of a token is sometimes the
  // factory that minted it, not the person who pressed launch — and tracking a
  // factory as a "dev" would fire on every launch the whole platform ever does.
  const rows: typeof allRows = [];
  const excludedContracts: string[] = [];
  const undetermined: string[] = [];
  for (const r of allRows) {
    const contract = await isContract(r.address);
    if (contract === null) {
      undetermined.push(r.address);
      continue; // excluded and reported — never silently included
    }
    if (contract) excludedContracts.push(r.address);
    else rows.push(r);
  }
  if (rows.length === 0) {
    throw new Error("every deployer classified as a contract — refusing to write an empty export");
  }

  // Biggest runner per dev, so the name reflects their best-known token.
  const bestToken = new Map<string, { symbol: string; ath: number }>();
  for (const t of tokens ?? []) {
    if (!t.deployer_address || !t.symbol) continue;
    const key = t.deployer_address.toLowerCase();
    const ath = Number(t.ath_mc_usd ?? 0);
    const prev = bestToken.get(key);
    if (!prev || ath > prev.ath) bestToken.set(key, { symbol: t.symbol, ath });
  }

  const existing = loadExisting();
  const dbAddresses = new Set(rows.map((r) => r.address.toLowerCase()));

  const added: Array<{ name: string; emoji: string; batch: string }> = [];
  let unresolved = 0;
  let cursor = 0;

  const byBatch = new Map<string, typeof rows>();
  for (const r of rows) {
    const day = (r.first_seen_at ?? "").slice(0, 10) || "unknown";
    if (!byBatch.has(day)) byBatch.set(day, []);
    byBatch.get(day)!.push(r);
  }

  const batches: Array<{ date: string; entries: TrackedWallet[] }> = [];
  for (const day of [...byBatch.keys()].sort()) {
    const group = byBatch.get(day)!;
    const named = group.map((r) => {
      const key = r.address.toLowerCase();
      const symbol = cleanSymbol(bestToken.get(key)?.symbol ?? "");
      if (!symbol) unresolved++;
      // Stored label wins if one ever exists (i.e. once promoted to alpha).
      const name = r.label ?? (symbol ? `RH_${symbol}_Dep` : `RH_${r.address.slice(2, 8)}_Dep`);
      return { row: r, name };
    });
    // Stable order inside a batch so a re-run never shuffles same-day devs.
    named.sort((a, b) => a.name.localeCompare(b.name));

    const entries: TrackedWallet[] = [];
    for (const { row, name } of named) {
      const key = row.address.toLowerCase();
      const prev = existing.get(key);
      // Sticky icon, but only if it's still a cooking emoji — so changing the
      // pool below actually takes effect rather than being pinned forever.
      const emoji =
        prev?.emoji && COOKING_EMOJI.includes(prev.emoji)
          ? prev.emoji
          : COOKING_EMOJI[cursor % COOKING_EMOJI.length];
      if (!prev) added.push({ name, emoji, batch: day });
      cursor++;
      entries.push(makeEntry(row.address, name, emoji));
    }
    batches.push({ date: day, entries });
  }

  const all = batches.flatMap((b) => b.entries);
  const removed = [...existing.values()].filter(
    (w) => !dbAddresses.has(w.trackedWalletAddress.toLowerCase())
  );

  console.log(`deployers in DB  : ${allRows.length}`);
  console.log(`  contracts excl.  : ${excludedContracts.length}  (launchpad factories, not devs)`);
  console.log(`  undetermined     : ${undetermined.length}  (excluded — could not classify)`);
  console.log(`exported devs    : ${rows.length}`);
  console.log(`  promoted alpha : ${rows.filter((r) => r.is_alpha).length}  (2+ $2M runners)`);
  console.log(`  name derived   : ${rows.length - unresolved} from their $2M token`);
  console.log(`  name fallback  : ${unresolved} (no resolvable token — address-derived)`);
  console.log(`newly added      : ${added.length}`);
  console.log(`removed          : ${removed.length}`);
  console.log(`all cooking      : ${all.every((w) => COOKING_EMOJI.includes(w.emoji))}`);
  console.log(`groups           : ${JSON.stringify(GROUPS)}`);

  console.log(`\nbatches (oldest first, newest at the bottom of the file):`);
  for (const b of batches) console.log(`  ${b.date}  ${String(b.entries.length).padStart(3)} devs`);

  if (added.length) {
    console.log(`\nnew this run:`);
    for (const a of added.slice(0, 50)) console.log(`  ${a.emoji}  ${a.name.padEnd(28)} (batch ${a.batch})`);
    if (added.length > 50) console.log(`  … and ${added.length - 50} more`);
  }
  for (const r of removed) console.log(`  removed: ${r.name} (${r.trackedWalletAddress})`);
  if (excludedContracts.length) {
    console.log(`\ncontracts excluded (not dev wallets):`);
    for (const c of excludedContracts) console.log(`  ${c}`);
  }
  for (const u of undetermined) console.log(`  ⚠️  could not classify, excluded: ${u}`);

  if (!write) {
    console.log(`\nPREVIEW ONLY — re-run with --write to update the files.`);
    return;
  }

  writeFileSync(JSON_PATH, `${JSON.stringify(all, null, 2)}\n`);
  writeFileSync(JSONC_PATH, renderJsonc(batches));
  console.log(`\nwrote ${JSON_PATH}  (strict JSON — import this)`);
  console.log(`wrote ${JSONC_PATH} (annotated with batch dates — for reading)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
