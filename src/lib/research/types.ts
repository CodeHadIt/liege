// ── Research types ────────────────────────────────────────────────────────────
// Shared vocabulary for the /research pipeline. Every stage adds to a single
// `Subject` (what we now know about the protocol) and a list of `Evidence`
// (sentences we can quote, each with the URL it came from).
//
// Two rules the shapes here enforce:
//
//   1. Nothing in a report is unsourced. An `Evidence` carries its own URL, so
//      a claim that reaches the reader can always be traced back. Deriving a
//      claim and then hunting for its source afterwards is how reports end up
//      asserting things nobody checked.
//   2. A source that failed is not a source that found nothing. `SourceStatus`
//      distinguishes ok / empty / failed / skipped, and the report prints the
//      coverage line from it — the same reasoning as the alert feeds' health
//      model, where a skipped chain must never look like a clean check.

import type { ChainId } from "@/types/chain";
import type { SubjectProfile } from "./profile";
import type { TokenShape } from "./token-shape";

/** What the user typed, once we have worked out what it is. */
export type InputKind =
  | "evm-address"
  | "solana-address"
  | "url-github"
  | "url-docs"
  | "url-whitepaper"
  | "url-article"
  | "url-website"
  | "query";

export interface ClassifiedInput {
  kind: InputKind;
  /** Normalised form: checksum-ish address, or a URL with scheme. */
  value: string;
  /** For URLs. */
  host?: string;
  /** Why we classified it this way — shown in the report's provenance block. */
  reason: string;
}

export type SourceState = "ok" | "empty" | "failed" | "skipped";

export interface SourceStatus {
  /** Stable id: "dexscreener", "coingecko", "docs", "github", "chain", … */
  id: string;
  state: SourceState;
  /** One line for the coverage block: what answered, or why it didn't. */
  detail: string;
  /** How many items the source contributed (pages, pairs, files…). */
  count?: number;
}

/** A quotable fact, tied to where it came from. */
export interface Evidence {
  /** Topic bucket — see TOPICS in extract.ts. */
  topic: string;
  /** The sentence, cleaned but not paraphrased. */
  text: string;
  /** Page URL. */
  url: string;
  /** Nearest heading above the sentence, when the page had one. */
  heading?: string;
  /** Higher = more likely to be worth printing. */
  weight: number;
  /** From the primary page (a repo's README, a docs root) rather than a sub-page. */
  primary?: boolean;
}

/** A number pulled out of the docs, with the sentence it came from. */
export interface DocMetric {
  label: string;
  value: string;
  url: string;
  /** The line the number was read from, so a reader can sanity-check it. */
  context?: string;
}

export interface TokenMarket {
  chain: string;
  /** "SEND/WETH" — without it every row of a multi-pair table reads the same. */
  pairLabel?: string;
  pairAddress?: string;
  dexId?: string;
  priceUsd?: number;
  fdv?: number;
  marketCap?: number;
  liquidityUsd?: number;
  volume24h?: number;
  priceChange24h?: number;
  txns24h?: number;
  pairCreatedAt?: number;
  url?: string;
}

export interface OnChainFacts {
  chain: ChainId;
  address: string;
  /** ERC-20 / SPL metadata. */
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  /** Verified-source name from the explorer, e.g. "SendItFactory". */
  contractName?: string;
  verified?: boolean;
  /** EIP-1167 / 1967 implementation, when this is a proxy. */
  implementation?: string;
  proxyType?: string;
  /** owner() answered — i.e. the contract has an owner at all. */
  ownerAddress?: string;
  /** Selectors found in the deployed bytecode that matter for trust. */
  hasMintSelector?: boolean;
  hasPauseSelector?: boolean;
  holderCount?: number;
  creator?: string;
  creationTx?: string;
  /** Anything we tried and could not read, for the caveats block. */
  notes: string[];
}

export interface DocsFindings {
  /** The docs root we settled on. */
  rootUrl: string;
  /** How we found it: "given", "link", "probe", "coingecko", "github". */
  discovery: string;
  pages: DocPage[];
  /** Contract addresses the docs publish, with their labels. */
  contracts: { label: string; address: string }[];
}

export interface DocPage {
  url: string;
  /** True when a headless browser had to assemble the text. */
  rendered?: boolean;
  title?: string;
  /** Section headings in document order. */
  headings: string[];
  /** Cleaned text. */
  text: string;
  chars: number;
}

export interface GithubFindings {
  owner: string;
  repo?: string;
  url: string;
  description?: string;
  stars?: number;
  forks?: number;
  openIssues?: number;
  language?: string;
  license?: string;
  pushedAt?: string;
  createdAt?: string;
  /** Repos on the org, when the input pointed at an org rather than a repo. */
  siblingRepos?: { name: string; stars: number; pushedAt?: string }[];
  readmeExcerpt?: string;
  hasDocsDir?: boolean;
  hasAuditsDir?: boolean;
  hasTestsDir?: boolean;
  /** Root-level filenames that look like committed secrets. */
  suspiciousFiles?: string[];
}

export interface SocialFindings {
  twitter?: string;
  twitterFollowers?: number;
  telegram?: string;
  discord?: string;
  /** Ready-made X search for the contract address — the "what is being said
   *  about this CA" link, which we cannot answer ourselves without an X key. */
  caSearchUrl?: string;
  otherLinks: string[];
}

/** A docs claim checked against the chain. */
export interface VerificationCheck {
  claim: string;
  claimUrl?: string;
  /** What the chain says. */
  observed: string;
  verdict: "match" | "mismatch" | "unverifiable";
  note?: string;
}

export interface RiskFlag {
  severity: "high" | "medium" | "info";
  label: string;
  detail: string;
}

export interface Highlight {
  /** Short label, e.g. "Liquidity locked at birth". */
  label: string;
  /** One sentence of substance, ideally quoted from the docs. */
  detail: string;
  url?: string;
}

export interface Subject {
  /** Best display name we could establish. */
  name: string;
  /** Ticker, when there is one. */
  symbol?: string;
  chain?: ChainId;
  /** The address the user asked about, when they gave one. */
  address?: string;
  website?: string;
  docsUrl?: string;
  githubUrl?: string;
  whitepaperUrl?: string;
  categories: string[];
  /** One-line "what it is", extracted rather than invented. */
  oneLiner?: string;
  oneLinerUrl?: string;
}

export interface ResearchReport {
  input: ClassifiedInput;
  subject: Subject;
  /** protocol | project-with-token | token-only, and why. */
  profile: SubjectProfile;
  /** What the token mechanically is, independent of what it is attached to. */
  tokenShape?: TokenShape;
  highlights: Highlight[];
  docMetrics: DocMetric[];
  market?: TokenMarket;
  markets: TokenMarket[];
  onchain?: OnChainFacts;
  docs?: DocsFindings;
  github?: GithubFindings;
  social: SocialFindings;
  evidence: Evidence[];
  verifications: VerificationCheck[];
  risks: RiskFlag[];
  /** Questions the docs did not answer — the honest end of the report. */
  openQuestions: string[];
  coverage: SourceStatus[];
  /** Wall-clock milliseconds the whole run took. */
  elapsedMs: number;
  generatedAt: number;
}
