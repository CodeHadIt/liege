// ── Checking the documentation against the deployed code ──────────────────────
// The step that separates a research report from a summary of someone's website.
//
// Docs are marketing until something checks them. Every claim below is one a
// protocol makes in prose and the chain answers in bytecode, and the interesting
// outcome is not "match" — it is a mismatch, or an `unverifiable` on a claim the
// reader was going to rely on.
//
// Three wording rules, because being wrong here is expensive:
//
//   * Selector ABSENCE is proof: code with no mint selector cannot mint.
//   * Selector PRESENCE is not proof of reachability — it may sit behind a
//     modifier that always reverts — so it is reported as "the bytecode contains",
//     and the verdict is a mismatch only when the docs claimed the function does
//     not exist at all.
//   * A claim we cannot test says `unverifiable` and says why. Silence would let
//     a reader assume it passed.

import type { Evidence, OnChainFacts, VerificationCheck, DocMetric } from "./types";
import { TOPICS } from "./extract";

/** First evidence sentence matching a pattern, searched across topics. */
function findClaim(evidence: Evidence[], re: RegExp, topics?: string[]): Evidence | undefined {
  return evidence.find((e) => (!topics || topics.includes(e.topic)) && re.test(e.text));
}

function fmtSupply(raw: bigint, decimals?: number): string {
  if (decimals === undefined) return raw.toString();
  const d = BigInt(10) ** BigInt(decimals);
  const whole = raw / d;
  return whole.toLocaleString("en-US");
}

export function verifyAgainstChain(
  evidence: Evidence[],
  metrics: DocMetric[],
  onchain: OnChainFacts | undefined
): VerificationCheck[] {
  const out: VerificationCheck[] = [];
  if (!onchain) return out;

  const isSolana = onchain.chain === "solana";

  // ── 1. "Supply is fixed / no mint function" ────────────────────────────────
  const noMintClaim = findClaim(
    evidence,
    /\bno mint\b|\bcannot be minted\b|\bminted once\b|\bfixed supply\b|\bsupply is fixed\b|\bno mint function\b/i
  );
  if (noMintClaim) {
    if (onchain.hasMintSelector === undefined) {
      out.push({
        claim: noMintClaim.text,
        claimUrl: noMintClaim.url,
        observed: "could not read the account/bytecode",
        verdict: "unverifiable",
      });
    } else if (onchain.hasMintSelector) {
      out.push({
        claim: noMintClaim.text,
        claimUrl: noMintClaim.url,
        observed: isSolana
          ? "the SPL mint still has a live mint authority"
          : "the deployed bytecode contains a mint selector",
        verdict: "mismatch",
        note: isSolana
          ? "A live mint authority can increase supply at will."
          : "Presence is not proof it is callable, but the docs claim the function is absent.",
      });
    } else {
      out.push({
        claim: noMintClaim.text,
        claimUrl: noMintClaim.url,
        observed: isSolana
          ? "mint authority is revoked (null)"
          : "no mint selector appears in the deployed bytecode",
        verdict: "match",
      });
    }
  }

  // ── 2. A stated supply figure vs totalSupply() ─────────────────────────────
  const stated = metrics.find((m) => m.label === "Total supply");
  if (stated && onchain.totalSupply !== undefined) {
    const statedDigits = stated.value.replace(/[,\s]/g, "");
    const actual = fmtSupply(onchain.totalSupply, onchain.decimals).replace(/,/g, "");
    const matches = statedDigits === actual;
    out.push({
      claim: `Docs state a supply of ${stated.value}`,
      claimUrl: stated.url,
      observed: `totalSupply() = ${fmtSupply(onchain.totalSupply, onchain.decimals)}${
        onchain.decimals !== undefined ? ` (${onchain.decimals} decimals)` : ""
      }`,
      verdict: matches ? "match" : "mismatch",
      note: matches ? undefined : "Compare before trusting any per-token figure derived from the docs.",
    });
  }

  // ── 3. "No owner" ──────────────────────────────────────────────────────────
  const noOwnerClaim = findClaim(evidence, /\bno owner\b|\bownerless\b|\brenounced ownership\b/i);
  if (noOwnerClaim) {
    out.push({
      claim: noOwnerClaim.text,
      claimUrl: noOwnerClaim.url,
      observed: onchain.ownerAddress
        ? `owner() answers ${onchain.ownerAddress}`
        : "owner() does not answer — no owner slot exposed",
      verdict: onchain.ownerAddress ? "mismatch" : "match",
    });
  } else if (onchain.ownerAddress) {
    // No claim to check, but an owner nobody documented is worth surfacing.
    out.push({
      claim: "(the docs do not mention an owner)",
      observed: `owner() answers ${onchain.ownerAddress}`,
      verdict: "unverifiable",
      note: "An owner exists on chain. What it can do is a code question the docs do not answer.",
    });
  }

  // ── 4. "Immutable / cannot be upgraded" ────────────────────────────────────
  const immutableClaim = findClaim(
    evidence,
    /\bimmutable\b|\bcannot be (changed|upgraded)\b|\bno setter\b|\bwritten once\b/i,
    [TOPICS.UPGRADE, TOPICS.GUARANTEE]
  );
  if (onchain.implementation) {
    out.push({
      claim: immutableClaim?.text ?? "(the docs do not describe this contract as a proxy)",
      claimUrl: immutableClaim?.url,
      observed: `${onchain.proxyType ?? "proxy"} → implementation ${onchain.implementation}`,
      verdict: onchain.proxyType?.includes("1967") ? "mismatch" : "unverifiable",
      note: onchain.proxyType?.includes("1167")
        ? "An EIP-1167 clone cannot be upgraded — its target is fixed in the code — but the logic lives at another address, so the code to read is the implementation's."
        : "An upgradeable proxy means today's code is not a guarantee about tomorrow's.",
    });
  } else if (immutableClaim) {
    out.push({
      claim: immutableClaim.text,
      claimUrl: immutableClaim.url,
      observed: "no proxy pointer found (no EIP-1167 clone pattern, EIP-1967 slot empty)",
      verdict: "match",
    });
  }

  // ── 5. Pausability ─────────────────────────────────────────────────────────
  if (onchain.hasPauseSelector) {
    const pauseClaim = findClaim(evidence, /\bpause(s|d|able)?\b/i);
    out.push({
      claim: pauseClaim?.text ?? "(pausing is not mentioned in the docs)",
      claimUrl: pauseClaim?.url,
      observed: "the deployed bytecode contains a pause/unpause selector",
      verdict: pauseClaim ? "match" : "unverifiable",
      note: pauseClaim ? undefined : "Something can be paused. The docs do not say what, or by whom.",
    });
  }

  // ── 6. Claims we deliberately do not pretend to check ──────────────────────
  const lockClaim = findClaim(
    evidence,
    /\block(ed|s)?\b[^.]{0,40}\b(liquidity|position)\b|\bno withdraw\b|\bcannot be pulled\b/i,
    [TOPICS.CUSTODY, TOPICS.GUARANTEE]
  );
  if (lockClaim) {
    out.push({
      claim: lockClaim.text,
      claimUrl: lockClaim.url,
      observed: "not checked",
      verdict: "unverifiable",
      note: "Proving a lock means reading the locker's withdrawal paths, which is a source review rather than a state read. Verify before sizing a position on it.",
    });
  }

  return out;
}

/** One-line summary for the TLDR: how the docs held up. */
export function verdictSummary(checks: VerificationCheck[]): string | undefined {
  if (checks.length === 0) return undefined;
  const m = checks.filter((c) => c.verdict === "match").length;
  const x = checks.filter((c) => c.verdict === "mismatch").length;
  const u = checks.filter((c) => c.verdict === "unverifiable").length;
  const parts = [`${m} confirmed`];
  if (x) parts.push(`${x} contradicted`);
  if (u) parts.push(`${u} unverifiable`);
  return parts.join(", ");
}
