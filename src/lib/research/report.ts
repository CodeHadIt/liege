// ── Risk synthesis ────────────────────────────────────────────────────────────
// Everything else in the pipeline collects facts. This turns them into the flags
// a reader should see before they read anything else.
//
// The rules are deliberately mechanical and each one names its own evidence. No
// score, no grade: a single letter would imply the inputs are commensurable, and
// "unaudited" and "thin liquidity" are not two units of the same thing. A reader
// deciding whether to size a position needs the list, not an average of it.
//
// Severity means:
//   high   — could cost you the position outright (supply can move, code can
//            change under you, you may not be able to exit)
//   medium — materially changes the risk, or a gap where a claim should be
//   info   — worth knowing, including the project's own disclosures

import type {
  DocsFindings,
  Evidence,
  GithubFindings,
  OnChainFacts,
  RiskFlag,
  TokenMarket,
  VerificationCheck,
} from "./types";
import { TOPICS, topEvidence } from "./extract";
import type { SubjectProfile } from "./profile";
import type { TokenShape } from "./token-shape";

export interface RiskInputs {
  profile?: SubjectProfile;
  tokenShape?: TokenShape;
  onchain?: OnChainFacts;
  market?: TokenMarket;
  docs?: DocsFindings;
  github?: GithubFindings;
  evidence: Evidence[];
  verifications: VerificationCheck[];
}

const DAY = 86_400_000;

export function synthesiseRisks(input: RiskInputs): RiskFlag[] {
  const out: RiskFlag[] = [];
  const { onchain, market, docs, github, evidence, verifications, profile, tokenShape } = input;

  // ── the token-vs-project distinction ───────────────────────────────────────
  if (profile?.shape === "project-with-token") {
    out.push({
      severity: tokenShape?.kind === "launchpad-standard" ? "medium" : "info",
      label: "Token has no mechanism of its own",
      detail:
        `${tokenShape?.launchpad ? `${tokenShape.launchpad} mint` : "Standard token"}` +
        ": no fees, emissions, governance or revenue share. A bet on attention, not on cash flow.",
    });
    if (profile.mentionsToken === false) {
      out.push({
        severity: "high",
        label: "The project never mentions the token",
        detail:
          "No reference to a token, ticker or contract address anywhere in it. The link comes from the token's metadata — treat any claim of endorsement as unverified.",
      });
    }
  }
  if (profile?.shape === "token-only") {
    out.push({
      severity: "high",
      label: "Nothing documents this token",
      detail: "No docs, repo or site reachable — nothing to research beyond the market data.",
    });
  }
  for (const f of github?.suspiciousFiles ?? []) {
    out.push({
      severity: "medium",
      label: `Possible committed secret: ${f}`,
      detail: "In the repo root. Filename only, contents not read — but worth checking.",
    });
  }
  if (github && (!github.license || /^(noassertion|other)$/i.test(github.license))) {
    out.push({
      severity: "info",
      label: "No recognised licence",
      detail: "No SPDX licence GitHub recognises — reuse rights unclear.",
    });
  }

  // ── documentation ──────────────────────────────────────────────────────────
  // Only a protocol is faulted for having no documentation site: a code-first
  // project's README IS its documentation, and `docs` already carries it.
  if (!docs && profile?.shape === "protocol") {
    out.push({
      severity: "high",
      label: "No documentation found",
      detail:
        "Nothing at /docs, docs.<domain> or any whitepaper link — every claim about the mechanism is unsourced.",
    });
  } else if (docs && profile?.shape === "protocol" && docs.pages.reduce((n, p) => n + p.chars, 0) < 4_000) {
    out.push({
      severity: "medium",
      label: "Documentation is thin",
      detail: `${docs.pages.reduce((n, p) => n + p.chars, 0).toLocaleString("en-US")} chars across ${docs.pages.length} page(s) — not enough to describe a mechanism.`,
    });
  }

  // ── audit status ───────────────────────────────────────────────────────────
  const unaudited = evidence.find((e) =>
    /\bunaudited\b|\bnot been audited\b|\bno audit\b|\btreat the code as unaudited\b/i.test(e.text)
  );
  const auditMention = topEvidence(evidence, TOPICS.SECURITY, 1)[0];
  if (unaudited) {
    out.push({
      severity: "high",
      label: "Unaudited, by the project's own statement",
      detail: unaudited.text,
    });
  } else if (!auditMention && !github?.hasAuditsDir) {
    out.push({
      severity: "medium",
      label: "No audit statement anywhere",
      detail:
        "No audit, test or bug-bounty claim in the docs or the repo. Nothing supports the code having been reviewed.",
    });
  }

  // ── on-chain trust surface ─────────────────────────────────────────────────
  if (onchain?.hasMintSelector && onchain.chain !== "solana") {
    out.push({
      severity: "high",
      label: "Bytecode contains a mint selector",
      detail:
        "Supply may not be fixed. It could sit behind a check that always reverts — only the source settles it.",
    });
  }
  for (const note of onchain?.notes ?? []) {
    if (/mint authority is live/i.test(note)) {
      out.push({ severity: "high", label: "Mint authority is live", detail: note });
    } else if (/freeze authority is live/i.test(note)) {
      out.push({ severity: "high", label: "Freeze authority is live", detail: note });
    }
  }
  if (onchain?.proxyType?.includes("1967")) {
    out.push({
      severity: "high",
      label: "Upgradeable proxy",
      detail: `${onchain.proxyType} → ${onchain.implementation}. Today's code can be replaced by whoever holds the key.`,
    });
  }
  if (onchain?.ownerAddress) {
    const ownerPowers = evidence.find((e) => e.topic === TOPICS.GOVERNANCE && /\bowner can\b/i.test(e.text));
    out.push({
      severity: ownerPowers ? "info" : "medium",
      label: "Contract has an owner",
      detail: ownerPowers
        ? `owner() = ${onchain.ownerAddress}. Documented powers: ${ownerPowers.text}`
        : `owner() = ${onchain.ownerAddress}; the docs do not say what it can do.`,
    });
  }
  if (onchain?.hasPauseSelector) {
    out.push({
      severity: "medium",
      label: "Pausable",
      detail: "Pause/unpause selector in the bytecode — trading or transfers may be stoppable.",
    });
  }
  if (onchain && onchain.verified === false) {
    out.push({
      severity: "high",
      label: "Contract source is not verified",
      detail: "No published source to check the docs against.",
    });
  }

  // ── market ─────────────────────────────────────────────────────────────────
  if (market?.liquidityUsd !== undefined) {
    if (market.liquidityUsd < 10_000) {
      out.push({
        severity: "high",
        label: "Very thin liquidity",
        detail: `$${Math.round(market.liquidityUsd).toLocaleString("en-US")} in the deepest pool — an exit moves the price against you.`,
      });
    } else if (market.liquidityUsd < 75_000) {
      out.push({
        severity: "medium",
        label: "Thin liquidity",
        detail: `$${Math.round(market.liquidityUsd).toLocaleString("en-US")} in the deepest pool — size against depth, not market cap.`,
      });
    }
  }
  if (market?.pairCreatedAt) {
    const ageDays = (Date.now() - market.pairCreatedAt) / DAY;
    if (ageDays < 30) {
      out.push({
        severity: "info",
        label: "Young market",
        detail: `Deepest pair ${Math.max(0, Math.round(ageDays))}d old — no track record yet.`,
      });
    }
  }

  // ── repository liveness ────────────────────────────────────────────────────
  if (github?.pushedAt) {
    const staleDays = (Date.now() - Date.parse(github.pushedAt)) / DAY;
    if (staleDays > 180) {
      out.push({
        severity: "medium",
        label: "Repository looks abandoned",
        detail: `Last push ${Math.round(staleDays)}d ago.`,
      });
    }
  }

  // ── contradictions found by verify.ts outrank everything above ─────────────
  for (const v of verifications.filter((c) => c.verdict === "mismatch")) {
    out.unshift({
      severity: "high",
      label: "Docs contradicted by the chain",
      detail: `Claim: "${truncate(v.claim, 140)}" — observed: ${v.observed}`,
    });
  }

  // ── the project's own disclosures, kept as info ─────────────────────────────
  for (const r of topEvidence(evidence, TOPICS.RISKS, 2)) {
    out.push({ severity: "info", label: "Stated by the project", detail: r.text });
  }

  return dedupe(out);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function dedupe(flags: RiskFlag[]): RiskFlag[] {
  const seen = new Set<string>();
  const out: RiskFlag[] = [];
  for (const f of flags) {
    const key = `${f.label}|${f.detail.slice(0, 60)}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  const rank = { high: 0, medium: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The pair a reader should judge the market by: deepest liquidity, not newest. */
export function primaryMarket(markets: TokenMarket[]): TokenMarket | undefined {
  if (markets.length === 0) return undefined;
  return [...markets].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
}
