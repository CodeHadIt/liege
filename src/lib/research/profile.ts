// ── Which kind of thing are we researching? ───────────────────────────────────
// `/research` covers two populations that need different reports:
//
//   protocol           — crypto-native. There is a mechanism: fees, supply
//                        policy, rewards, admin powers, contracts of its own.
//                        The report's job is to describe it and check it against
//                        the deployed code.
//   project-with-token — software that exists on its own terms, with a token
//                        attached. The report's job is to describe what the
//                        software does, and to say plainly that the token is a
//                        separate object with no mechanism of its own.
//   token-only         — a token and nothing else: no docs, no repo, no site.
//                        The report's job is to not pretend otherwise.
//
// Getting this wrong in either direction is the failure mode. Treating a research
// repo as a protocol prints "the docs do not state a fee schedule" about something
// that was never going to have one; treating a protocol as a project skips the
// mechanism that is the entire point of reading its docs.
//
// The test is evidence, not vocabulary. A project that merely says "token" in a
// README is not a protocol; a protocol is one whose own documentation describes
// what happens to money.

import { TOPICS } from "./extract";
import type { DocsFindings, Evidence, GithubFindings } from "./types";

export type SubjectShape = "protocol" | "project-with-token" | "token-only";

export interface SubjectProfile {
  shape: SubjectShape;
  /** One line for the report: why we classified it this way. */
  reason: string;
  /** Whether any token mechanism is documented anywhere we read. */
  mechanicsDocumented: boolean;
  /** Whether the project's own docs/repo ever reference a token at all. */
  mentionsToken: boolean;
}

/** Topics that only a protocol's documentation covers. */
const MECHANISM_TOPICS = [TOPICS.FEES, TOPICS.TOKENOMICS, TOPICS.REWARDS, TOPICS.BURN, TOPICS.GOVERNANCE, TOPICS.CUSTODY];

export function profileSubject(args: {
  evidence: Evidence[];
  docs?: DocsFindings;
  github?: GithubFindings;
  hasToken: boolean;
}): SubjectProfile {
  const { evidence, docs, github, hasToken } = args;

  const publishesContracts = (docs?.contracts.length ?? 0) >= 2;
  const docText = (docs?.pages ?? []).map((p) => p.text).join("\n");

  /*
   * The mechanism test needs crypto CONTEXT, not crypto vocabulary.
   *
   * "fee", "supply", "token" and "burn" are ordinary English and ordinary ML
   * jargon. An AI research repo with a GPU hosting plan ("Cost math — if fees are
   * lower than that, run the pod only during live sessions") and LLM tokens
   * ("110 tokens under each framing") scored two mechanism topics and was
   * classified crypto-native — which then printed a protocol report about a
   * project with no protocol.
   *
   * So a mechanism sentence only counts if that sentence itself is about crypto,
   * and the document as a whole has to carry several distinct crypto terms.
   */
  const CRYPTO_TERM =
    /\b(on-?chain|smart contract|erc-?20|erc-?721|spl token|mainnet|blockchain|liquidity|liquidity pool|swap|amm|dex|wallet|tokenomics|airdrop|staking|apy|apr|gwei|solana|ethereum|uniswap|pump\.fun|market cap|vesting|cliff|treasury|holders|mint authority|burn address|0x[a-f0-9]{40})\b/gi;
  const cryptoTerms = new Set((docText.match(CRYPTO_TERM) ?? []).map((t) => t.toLowerCase()));

  const mechanismEvidence = evidence.filter(
    (e) => MECHANISM_TOPICS.includes(e.topic as never) && new RegExp(CRYPTO_TERM.source, "i").test(e.text)
  );
  const mechanismTopics = new Set(mechanismEvidence.map((e) => e.topic));

  /*
   * "token" alone is not a crypto signal. In an ML repo it is a unit of text, and
   * this corpus is full of sentences like "110 tokens under each framing" — so the
   * test requires either a crypto-specific word, or "token" next to one.
   */
  const mentionsToken =
    /\b(tokenomics|airdrop|liquidity pool|market cap|on-chain|onchain|smart contract|erc-?20|spl token|mint address|contract address|ticker|\$[A-Z]{2,10}\b)/i.test(
      docText
    ) || /\b(token|coin)\b[^.\n]{0,40}\b(launch|supply|holders?|buy|trade|contract|address|chain)\b/i.test(docText);

  const mechanicsDocumented = (mechanismTopics.size >= 2 && cryptoTerms.size >= 3) || publishesContracts;

  // Protocol: its own documentation describes what happens to money.
  if (mechanicsDocumented) {
    const bits = [
      mechanismTopics.size >= 2
        ? `${mechanismTopics.size} mechanism topics documented in crypto context (${[...mechanismTopics].join(", ")})`
        : undefined,
      publishesContracts ? `${docs?.contracts.length} contract addresses published` : undefined,
    ].filter(Boolean);
    return {
      shape: "protocol",
      reason: `Crypto-native: ${bits.join("; ")}.`,
      mechanicsDocumented: true,
      mentionsToken: true,
    };
  }

  // Project with a token: real software, documented, but no token mechanism.
  const hasSubstance = (docs?.pages.reduce((n, p) => n + p.chars, 0) ?? 0) > 2_000 || github !== undefined;
  if (hasToken && hasSubstance) {
    return {
      shape: "project-with-token",
      reason: mentionsToken
        ? "Software project with a token attached: its documentation describes the software, not a token mechanism."
        : "Software project with a token attached: the project's own documentation never references a token at all.",
      mechanicsDocumented: false,
      mentionsToken,
    };
  }

  if (hasToken) {
    return {
      shape: "token-only",
      reason: "A token with no documentation, repository or site we could reach — nothing describes what it is for.",
      mechanicsDocumented: false,
      mentionsToken,
    };
  }

  // No token at all: a codebase or a protocol being researched before it ships.
  return {
    shape: hasSubstance ? "project-with-token" : "token-only",
    reason: hasSubstance
      ? "Software project, with no token found on any chain we check."
      : "Nothing readable was found for this input.",
    mechanicsDocumented: false,
    mentionsToken,
  };
}
