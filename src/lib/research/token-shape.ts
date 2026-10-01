// ── What kind of token is this, mechanically? ──────────────────────────────────
// A research report has to answer a question before it describes any mechanism:
// is there a mechanism at all?
//
// Most tokens attached to a project are not protocol tokens. They are a standard
// launchpad mint — one of millions, with no fee switch, no emissions, no
// governance and no contract of their own — and the honest report says so in one
// line rather than printing eight empty sections about tokenomics that were never
// going to exist.
//
// Detection leans on three independent signals, and the report prints which ones
// fired so the conclusion is auditable rather than asserted:
//
//   1. The venue. DexScreener's `dexId` names the launchpad that minted it.
//   2. The address. Launchpads vanity-grind their mints ("…pump", "…bonk").
//   3. The shape. pump.fun mints 1,000,000,000 at 6 decimals and revokes both
//      authorities; that triple is a fingerprint, not a coincidence.
//
// Nothing here is a judgement about the project. A standard mint is the normal
// way to attach a token to something, and saying so plainly is more useful than
// either dressing it up or sneering at it.

import type { OnChainFacts, TokenMarket } from "./types";

export interface TokenShape {
  /**
   * `launchpad-standard` — a stock mint from a launchpad, no bespoke code.
   * `standard-erc20`    — plain ERC-20, nothing beyond the interface.
   * `custom`            — bespoke code: owner, mint, pause, hooks, taxes.
   * `unknown`           — not enough read to say.
   */
  kind: "launchpad-standard" | "standard-erc20" | "custom" | "unknown";
  /** "pump.fun", "bonk.fun / LaunchLab", "Moonshot", "four.meme", … */
  launchpad?: string;
  /** Whether the docs/repo describe any token mechanism at all. */
  mechanics: "documented" | "none-found";
  /** The signals that produced this verdict, for the report. */
  signals: string[];
}

/** DexScreener `dexId` (and label) → the launchpad that minted the token. */
const VENUE_LAUNCHPAD: { match: RegExp; name: string }[] = [
  { match: /^pump(fun|swap)$/i, name: "pump.fun" },
  { match: /launchlab|letsbonk|bonkfun/i, name: "bonk.fun / Raydium LaunchLab" },
  { match: /^moonshot$/i, name: "Moonshot" },
  { match: /^believe$/i, name: "Believe" },
  { match: /^heaven$/i, name: "Heaven" },
  { match: /^boop$/i, name: "Boop" },
  { match: /fourmeme|four\.meme/i, name: "four.meme" },
  { match: /^clanker$/i, name: "Clanker" },
  { match: /^virtuals?$/i, name: "Virtuals" },
  { match: /^stonkfun$/i, name: "StonkFun" },
];

/** Vanity suffixes launchpads grind into their mint addresses. */
const SUFFIX_LAUNCHPAD: { suffix: RegExp; name: string }[] = [
  { suffix: /pump$/, name: "pump.fun" },
  { suffix: /bonk$/, name: "bonk.fun / Raydium LaunchLab" },
  { suffix: /moon$/, name: "Moonshot" },
  { suffix: /BAGS$/, name: "Bags" },
];

const BILLION = 1_000_000_000;

export function classifyTokenShape(
  markets: TokenMarket[],
  onchain: OnChainFacts | undefined,
  mechanicsDocumented: boolean
): TokenShape {
  const signals: string[] = [];
  let launchpad: string | undefined;

  // 1. Venue.
  for (const m of markets) {
    const id = m.dexId ?? "";
    const hit = VENUE_LAUNCHPAD.find((v) => v.match.test(id));
    if (hit && !launchpad) {
      launchpad = hit.name;
      signals.push(`trades on ${id} — ${hit.name}'s own venue`);
    }
  }

  // 2. Address.
  if (onchain?.address) {
    const hit = SUFFIX_LAUNCHPAD.find((s) => s.suffix.test(onchain.address));
    if (hit) {
      signals.push(`mint address ends "${hit.suffix.source.replace("$", "")}" — ${hit.name}'s vanity suffix`);
      launchpad = launchpad ?? hit.name;
    }
  }

  // 3. Shape. The supply test tolerates burns, which only ever reduce it.
  const supplyWhole =
    onchain?.totalSupply !== undefined && onchain.decimals !== undefined
      ? Number(onchain.totalSupply / BigInt(10) ** BigInt(onchain.decimals))
      : undefined;
  const isBillionish = supplyWhole !== undefined && supplyWhole > BILLION * 0.5 && supplyWhole <= BILLION * 1.0001;
  if (onchain?.chain === "solana" && onchain.decimals === 6 && isBillionish) {
    signals.push(`1,000,000,000 supply at 6 decimals — the stock launchpad mint shape`);
  }
  if (onchain?.chain === "solana" && onchain.hasMintSelector === false) {
    signals.push("mint and freeze authorities revoked — no bespoke control surface");
  }

  // Custom code beats everything above: a token with an owner, a mint path or a
  // pause switch is not a stock mint whatever venue it trades on.
  const custom =
    onchain !== undefined &&
    (onchain.hasMintSelector === true ||
      onchain.hasPauseSelector === true ||
      (onchain.ownerAddress !== undefined && onchain.chain !== "solana") ||
      (onchain.contractName !== undefined && !/^(erc20|token|standardtoken)$/i.test(onchain.contractName)));

  const mechanics: TokenShape["mechanics"] = mechanicsDocumented ? "documented" : "none-found";

  if (custom) {
    const bits: string[] = [];
    if (onchain?.contractName) bits.push(`bespoke contract "${onchain.contractName}"`);
    if (onchain?.ownerAddress && onchain.chain !== "solana") bits.push("has an owner");
    if (onchain?.hasMintSelector) bits.push("mint path present");
    if (onchain?.hasPauseSelector) bits.push("pausable");
    if (bits.length) signals.push(bits.join(", "));
    return { kind: "custom", launchpad, mechanics, signals };
  }

  if (launchpad || (onchain?.chain === "solana" && onchain.decimals === 6 && isBillionish)) {
    return { kind: "launchpad-standard", launchpad, mechanics, signals };
  }

  if (onchain?.chain !== "solana" && onchain?.totalSupply !== undefined) {
    signals.push("plain ERC-20 surface: no owner, no mint path, no pause switch");
    return { kind: "standard-erc20", launchpad, mechanics, signals };
  }

  return { kind: "unknown", launchpad, mechanics, signals };
}

/**
 * The sentence the TLDR leads with when the token has no mechanism of its own.
 *
 * Written to be read by somebody deciding whether to buy: what the thing
 * mechanically IS, what it is attached to, and the fact that those are two
 * separate questions.
 */
export function describeAttachedToken(
  shape: TokenShape,
  opts: { projectName?: string; purpose?: string; mentionedInRepo?: boolean }
): string {
  const venue = shape.launchpad ?? "standard launchpad";
  const base =
    shape.kind === "launchpad-standard"
      ? `${venue} mint — no contract, fees, emissions or governance of its own`
      : shape.kind === "standard-erc20"
        ? `plain ERC-20 — no fees, emissions or governance`
        : `mechanics could not be established`;

  /*
   * No self-description here, and no long caveat.
   *
   * Both were already in the TL;DR two lines above — the project's own sentence is
   * the first thing the report says. Repeating it inside this line made the single
   * most important sentence in the report something a reader skims past.
   */
  const attach = opts.projectName ? `, attached to **${opts.projectName}**` : "";
  const caveat = opts.mentionedInRepo === false ? " The repo never mentions a token." : "";

  return `${base}${attach}.${caveat}`;
}

