// ── The TL;DR, composed from the whole run ────────────────────────────────────
// The first version quoted the README's opening sentence and called it a summary.
// That is a description of the project by the project — useful, but it is not the
// answer to "what did you find out", which is the only question a TL;DR exists to
// answer.
//
// So the TL;DR is now ASSEMBLED: one line of what it is, one of what is actually
// there, one of what the token mechanically is, one of what to watch. Every clause
// is a fact established elsewhere in the run — repo age and activity, mechanism
// topic coverage, liquidity, the token's fingerprint, the top flag — slotted into
// a fixed frame.
//
// That is synthesis without paraphrase, which is the line this pipeline holds:
// facts get rearranged and compressed, sentences never get rewritten. The only
// quoted text is the project's own one-liner, trimmed to its first sentence, and
// it is clearly theirs.

import { TOPICS, topEvidence } from "./extract";
import type { ResearchReport } from "./types";

const DAY = 86_400_000;

/** 2–4 compact lines. No bullets, no padding, nothing that repeats a later section. */
export function composeTldr(r: ResearchReport): string[] {
  const lines: string[] = [];
  const isProtocol = r.profile.shape === "protocol";

  /*
   * Line 1 is OURS: what the run established, in facts.
   *
   * It used to be the project's own opening sentence, which is a description of
   * the project by the project — fine, but not an answer to "what did you find
   * out". Their sentence still appears, on the next line and marked as theirs.
   */
  const identity: string[] = [];
  if (isProtocol) {
    const kind = r.subject.categories[0] ?? "protocol";
    identity.push(`${chainWord(r.onchain?.chain)} ${kind.toLowerCase()}`.trim());
    const covered = [TOPICS.FEES, TOPICS.TOKENOMICS, TOPICS.REWARDS, TOPICS.GOVERNANCE, TOPICS.CUSTODY, TOPICS.BURN]
      .filter((t) => topEvidence(r.evidence, t, 1).length > 0)
      .map(String);
    if (covered.length) identity.push(`documents ${covered.join(", ")}`);
    if (r.docs?.contracts.length) identity.push(`${r.docs.contracts.length} contracts published`);
    // Only speak to verification when a contract was actually read. With no
    // address in the input there is no source to verify, and "source not verified"
    // read as a finding about the project rather than an absence of input.
    // EVM only: an SPL mint has no verified-source concept, so saying "source not
    // verified" about one states a shortcoming that cannot exist.
    if (r.onchain && r.onchain.chain !== "solana") {
      identity.push(r.onchain.verified ? "source verified" : "source not verified");
    }
  } else {
    const g = r.github;
    const lang = g?.language ? `${g.language} ` : "";
    identity.push(`${lang}project with a ${r.tokenShape?.launchpad ?? "standard launchpad"} token attached`);
    if (g) {
      const bits: string[] = [];
      if (g.stars !== undefined) bits.push(`${g.stars}★`);
      if (g.createdAt) bits.push(`${ageShort(Date.parse(g.createdAt))} old`);
      if (g.pushedAt) {
        const stale = Math.round((Date.now() - Date.parse(g.pushedAt)) / DAY);
        bits.push(stale <= 7 ? "active" : `last push ${stale}d ago`);
      }
      if (bits.length) identity.push(bits.join(", "));
      identity.push(`${g.hasTestsDir ? "tests present" : "no tests"}, ${licenceWord(g.license)}`);
    }
  }
  if (identity.length) lines.push(`${capitalise(identity.join(" — "))}.`);

  // Their own words, clearly attributed and trimmed to one sentence.
  if (r.subject.oneLiner) lines.push(`Their words: "${clip(stripTrailing(r.subject.oneLiner), 170)}"`);

  /*
   * The token, mechanically, plus where the market actually is.
   *
   * The launchpad fact is stated even when the project documents a mechanism.
   * kairo publishes a real fee split — 70% treasury, 30% rewards — which made it
   * read as a protocol, and the TLDR then never mentioned that $JELLY is a
   * pump.fun mint whose "mechanism" is the team routing creator fees off-chain.
   * Both facts are true and a reader needs both.
   */
  const tokenBits: string[] = [];
  if (r.tokenShape) {
    tokenBits.push(
      r.tokenShape.kind === "launchpad-standard"
        ? `${r.tokenShape.launchpad ?? "launchpad"} mint${r.tokenShape.mechanics === "documented" ? ", mechanics documented off-chain" : ", no mechanism of its own"}`
        : r.tokenShape.kind === "custom"
          ? "custom contract"
          : r.tokenShape.kind === "standard-erc20"
            ? "plain ERC-20"
            : "shape unknown"
    );
  }
  if (r.market?.liquidityUsd !== undefined) tokenBits.push(`${money(r.market.liquidityUsd)} liquidity`);
  if (r.market?.fdv !== undefined) tokenBits.push(`${money(r.market.fdv)} FDV`);
  if (r.market?.volume24h !== undefined) tokenBits.push(`${money(r.market.volume24h)} 24h vol`);
  if (r.market?.pairCreatedAt) tokenBits.push(`pair ${ageShort(r.market.pairCreatedAt)} old`);
  if (tokenBits.length) lines.push(`Token: ${tokenBits.join(", ")}.`);

  const serious = r.risks.filter((f) => f.severity !== "info").slice(0, 2);
  if (serious.length) lines.push(`Watch: ${serious.map((f) => lowerFirst(f.label)).join("; ")}.`);

  return lines;
}

function chainWord(chain?: string): string {
  switch (chain) {
    case "eth": return "Ethereum";
    case "base": return "Base";
    case "bsc": return "BNB Chain";
    case "solana": return "Solana";
    case "rh": return "Robinhood Chain";
    default: return "";
  }
}

/**
 * GitHub answers NOASSERTION for a licence file it cannot identify, which is not
 * a licence name and must not be printed as one.
 */
export function licenceWord(license?: string): string {
  if (!license || /^(noassertion|other)$/i.test(license)) return "no clear licence";
  return license;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

function ageShort(ts: number): string {
  const d = (Date.now() - ts) / DAY;
  if (d < 1) return `${Math.max(1, Math.round(d * 24))}h`;
  if (d < 60) return `${Math.round(d)}d`;
  return `${Math.round(d / 30)}mo`;
}

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/[\s,;:—-]+$/, "")}…`;
}

function stripTrailing(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/[,;:]$/, "");
}


function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
