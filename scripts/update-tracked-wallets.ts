/**
 * Update the tracked-wallet export after new alpha wallets are promoted.
 *
 *   npx tsx scripts/update-tracked-wallets.ts            # preview the diff
 *   npx tsx scripts/update-tracked-wallets.ts --write
 *
 * Writes two files, because they answer different questions:
 *
 *   data/tracked-wallets.json   strict JSON — this is the one you import
 *   data/tracked-wallets.jsonc  the same list with `// Added <date>` batch
 *                               headers, for reading and diffing
 *
 * The split is not a preference. JSON has no comment syntax, so a `//` line
 * makes the file invalid and most importers reject it outright. Rather than
 * choose between an annotated file and an importable one, the script emits both
 * from the same data — they can never disagree.
 *
 * Two properties this script guarantees, both of which matter more than they
 * look:
 *
 *   1. NEW WALLETS GO AT THE BOTTOM. Wallets are ordered by the batch they were
 *      added in, oldest first, so the newest promotions are always the last
 *      entries and a re-export reads as an append rather than a reshuffle.
 *
 *   2. EMOJI ARE STICKY PER ADDRESS. The existing export is read back and each
 *      address keeps the icon it already had; only genuinely new wallets draw
 *      from the pool. Without this, adding one wallet would renumber the pool
 *      and silently repaint every icon in a list you've learned to read.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { existsSync, readFileSync, writeFileSync } from "fs";
import { supabase } from "../src/lib/supabase";

const JSON_PATH = "data/tracked-wallets.json";
const JSONC_PATH = "data/tracked-wallets.jsonc";

/** The one wallet that gets the crown. Never drawn from the pool. */
const CROWNED_LABEL = "rh_sestri_frong_80k";
const CROWN = "👑";

/**
 * Groups every wallet in this export belongs to.
 *
 * Applied from here rather than carried over from the previous file, so
 * changing this list and re-running updates the whole export in one pass and
 * every wallet added later inherits it automatically — there is no path where
 * old and new wallets end up in different groups.
 */
const GROUPS = ["Main", "RobinhoodAlphas"];

/** Distinct single-codepoint emoji — no ZWJ sequences an importer might mangle. */
const EMOJI_POOL = [
  "🦊","🐺","🦁","🐯","🐸","🐙","🦈","🐳","🐬","🦀",
  "🦉","🦅","🕊️","🦇","🐝","🦋","🐞","🦂","🕷️","🐢",
  "🌵","🍄","🌻","🌹","🍁","🌲","🌊","🔥","⚡","❄️",
  "🌙","⭐","☄️","🌈","💧","🪐","🌚","🌞","🎯","🎲",
  "🎰","🧩","🎸","🎺","🥁","🎹","🎻","🪕","🎬","🎧",
  "⚔️","🛡️","🏹","🔱","⚓","🪝","🔧","🔨","⛏️","🧲",
  "💎","💰","🪙","💣","🧨","🔮","🧿","🪬","🗝️","🔒",
  "🚀","🛸","🚁","⛵","🏎️","🚂","🛰️","🎈","🪂","🧭",
  "🍎","🍊","🍋","🍉","🍇","🍒","🥑","🌶️","🧊","🍯",
  "☕","🍵","🥤","🍺","🧃","🍩","🍪","🧁","🍫","🥨",
  "👽","🤖","👾","🎃","💀","🧠","👁️","🦴","🫀","🪸",
  "🏔️","🏝️","🗿","🏰","⛩️","🎡","🗼","🌋","🕳️","🪞",
];

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

/** Previous export, keyed by lowercase address, so icons survive a re-run. */
function loadExisting(): Map<string, TrackedWallet> {
  const map = new Map<string, TrackedWallet>();
  if (!existsSync(JSON_PATH)) return map;
  try {
    const parsed = JSON.parse(readFileSync(JSON_PATH, "utf8")) as TrackedWallet[];
    for (const w of parsed) {
      if (w?.trackedWalletAddress) map.set(w.trackedWalletAddress.toLowerCase(), w);
    }
  } catch (e) {
    // A corrupt export must not silently become "no history" — that would
    // repaint every icon on the next write.
    throw new Error(`${JSON_PATH} exists but could not be parsed: ${String(e)}`);
  }
  return map;
}

/** Render the annotated twin: same entries, with a header per batch. */
function renderJsonc(batches: Array<{ date: string; entries: TrackedWallet[] }>): string {
  const lines: string[] = ["["];
  const total = batches.reduce((n, b) => n + b.entries.length, 0);
  let written = 0;

  for (const batch of batches) {
    const plural = batch.entries.length === 1 ? "wallet" : "wallets";
    lines.push(`  // ── Added ${batch.date} — ${batch.entries.length} ${plural} ${"─".repeat(28)}`);
    for (const entry of batch.entries) {
      written++;
      const body = JSON.stringify(entry, null, 2)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
      // No trailing comma after the final entry — JSONC still forbids it.
      lines.push(written < total ? `${body},` : body);
    }
  }
  lines.push("]");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const write = process.argv.includes("--write");

  const { data, error } = await supabase
    .from("alpha_wallets")
    .select("label,address,added_at,is_active")
    .order("added_at", { ascending: true });

  if (error) throw new Error(`alpha_wallets read failed: ${error.message}`);

  const rows = (data ?? []).filter((r) => r.is_active !== false && r.address);
  if (rows.length === 0) {
    throw new Error("no active alpha wallets — refusing to overwrite the export with an empty list");
  }

  const existing = loadExisting();
  const dbAddresses = new Set(rows.map((r) => r.address.toLowerCase()));

  // Emoji already committed to an address stay claimed. A wallet that left the
  // list releases its icon back to the pool.
  const claimed = new Set<string>([CROWN]);
  for (const r of rows) {
    const prev = existing.get(r.address.toLowerCase());
    if (prev?.emoji) claimed.add(prev.emoji);
  }

  const added: Array<{ name: string; emoji: string; batch: string }> = [];
  const renamed: Array<{ from: string; to: string }> = [];
  let poolCursor = 0;

  function nextEmoji(): string {
    while (poolCursor < EMOJI_POOL.length) {
      const candidate = EMOJI_POOL[poolCursor++];
      if (!claimed.has(candidate)) {
        claimed.add(candidate);
        return candidate;
      }
    }
    // Pool exhausted: reuse rather than emit an empty icon, and say so.
    const fallback = EMOJI_POOL[added.length % EMOJI_POOL.length];
    console.warn(`⚠️  emoji pool exhausted — reusing ${fallback}`);
    return fallback;
  }

  // Group by the day the wallet was promoted; batches ordered oldest first so
  // the newest wallets land at the bottom of the file.
  const byBatch = new Map<string, typeof rows>();
  for (const r of rows) {
    const day = (r.added_at ?? "").slice(0, 10) || "unknown";
    if (!byBatch.has(day)) byBatch.set(day, []);
    byBatch.get(day)!.push(r);
  }

  const batches: Array<{ date: string; entries: TrackedWallet[] }> = [];
  for (const day of [...byBatch.keys()].sort()) {
    const entries: TrackedWallet[] = [];
    // Stable order inside a batch, so a re-run never shuffles same-day wallets.
    for (const r of byBatch.get(day)!.sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""))) {
      const key = r.address.toLowerCase();
      const label = r.label ?? r.address;
      const isCrowned = label.toLowerCase() === CROWNED_LABEL;
      const prev = existing.get(key);

      let emoji: string;
      if (isCrowned) {
        emoji = CROWN;
      } else if (prev?.emoji && prev.emoji !== CROWN) {
        emoji = prev.emoji; // sticky
      } else {
        emoji = nextEmoji();
      }

      if (!prev) added.push({ name: label, emoji, batch: day });
      else if (prev.name !== label) renamed.push({ from: prev.name, to: label });

      entries.push(makeEntry(r.address, label, emoji));
    }
    batches.push({ date: day, entries });
  }

  const all = batches.flatMap((b) => b.entries);
  const removed = [...existing.values()].filter(
    (w) => !dbAddresses.has(w.trackedWalletAddress.toLowerCase())
  );

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`wallets in DB    : ${rows.length}`);
  console.log(`already exported : ${rows.length - added.length}`);
  console.log(`newly added      : ${added.length}`);
  console.log(`renamed          : ${renamed.length}`);
  console.log(`removed          : ${removed.length}`);
  console.log(`distinct emoji   : ${new Set(all.map((w) => w.emoji)).size}/${all.length}`);
  console.log(`crowned          : ${all.find((w) => w.emoji === CROWN)?.name ?? "NONE ⚠️"}`);

  console.log(`\nbatches (oldest first, newest at the bottom of the file):`);
  for (const b of batches) console.log(`  ${b.date}  ${String(b.entries.length).padStart(3)} wallets`);

  if (added.length) {
    console.log(`\nnew this run:`);
    for (const a of added) console.log(`  ${a.emoji}  ${a.name.padEnd(32)} (batch ${a.batch})`);
  }
  for (const r of renamed) console.log(`  renamed: ${r.from} -> ${r.to}`);
  for (const r of removed) console.log(`  removed: ${r.name} (${r.trackedWalletAddress})`);

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
