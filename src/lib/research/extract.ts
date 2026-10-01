// ── Turning documentation into a research report ──────────────────────────────
// This module is the framework, encoded. It reads whatever the docs crawl
// returned and pulls out the answers a due-diligence review actually needs,
// each one still attached to the sentence and URL it came from.
//
// The topic list is the union of the standard token/protocol DD checklists —
// supply and allocation, emissions against demand, value capture, admin powers,
// audit status, upgradeability, custody, stated risks and external dependencies
// (EY's token due-diligence paper and the common "15-point" retail checklists
// agree on these buckets, and the process-quality reviews add documentation
// coverage itself as a signal) — plus one bucket those frameworks leave out and
// this bot treats as first class:
//
//   **Negative guarantees.** In crypto the load-bearing sentences are the ones
//   that say what CANNOT happen: "no mint function", "the owner cannot withdraw
//   locked liquidity", "fixed at launch and can never change". They are the only
//   claims a reader can check against bytecode, and they are what `verify.ts`
//   then checks. A report that quotes the features and skips the constraints has
//   copied the marketing.
//
// Everything here is deterministic: keyword and pattern rules over the docs text,
// never paraphrase. A sentence printed in a report is a sentence the project
// wrote. That is a deliberate constraint — a summariser that rewrites claims can
// invent, and an invented claim about someone's money is the one failure mode
// this feature cannot have.

import type { DocPage, DocMetric, Evidence, Highlight } from "./types";

export const TOPICS = {
  WHAT: "what",
  MECHANISM: "mechanism",
  FEES: "fees",
  TOKENOMICS: "tokenomics",
  REWARDS: "rewards",
  BURN: "burn",
  GOVERNANCE: "governance",
  SECURITY: "security",
  UPGRADE: "upgradeability",
  CUSTODY: "custody",
  RISKS: "risks",
  INTEGRATION: "integration",
  DEPENDENCIES: "dependencies",
  GUARANTEE: "guarantee",
  // ── the project-with-token side ──────────────────────────────────────────
  // A research repo or an app has no fee schedule, and asking it for one produces
  // a report full of absences. These buckets are what its documentation actually
  // answers.
  PURPOSE: "purpose",
  METHOD: "method",
  FINDINGS: "findings",
  USAGE: "usage",
  STATUS: "status",
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

interface Rule {
  topic: Topic;
  /** Patterns that put a sentence in this bucket, with their weight. */
  patterns: { re: RegExp; w: number }[];
  /** Headings that make a sentence under them more likely to be on-topic. */
  headingHints: RegExp;
}

const RULES: Rule[] = [
  {
    topic: TOPICS.WHAT,
    patterns: [
      { re: /\b(is|are)\s+(a|an|the)\s+[a-z]/i, w: 2 },
      { re: /\bprotocol\b|\blaunchpad\b|\bexchange\b|\bmarketplace\b|\bplatform\b|\bnetwork\b/i, w: 2 },
      { re: /\ballows?\b|\blets? you\b|\benables?\b|\bmakes it possible\b/i, w: 3 },
      { re: /\bbuilt on\b|\bon (ethereum|solana|base|bnb|arbitrum|bsc)\b/i, w: 2 },
    ],
    headingHints: /overview|introduction|what is|about|abstract|summary/i,
  },
  {
    topic: TOPICS.MECHANISM,
    patterns: [
      { re: /\b(how it works|the mechanism|under the hood)\b/i, w: 4 },
      { re: /\bcurve\b|\bpool\b|\bpair(ing|ed)?\b|\border book\b|\bvault\b|\bauction\b/i, w: 2 },
      { re: /\bwhen (a|an|the|someone|you)\b/i, w: 2 },
      { re: /\beach (trade|swap|launch|deposit|epoch|block)\b/i, w: 3 },
      { re: /\bmigrat(e|ion)\b|\bgraduat(e|ion)\b|\bsettle(s|ment)?\b|\bredeem\b/i, w: 2 },
    ],
    headingHints: /how|mechanism|lifecycle|architecture|design|curve|flow|process/i,
  },
  {
    topic: TOPICS.FEES,
    patterns: [
      { re: /\b\d+(\.\d+)?\s?%[^.]{0,60}\bfee/i, w: 6 },
      { re: /\bfee\b|\bfees\b/i, w: 3 },
      { re: /\bcharged?\b|\bcollect(ed|s|ion)?\b|\baccrue(s|d)?\b/i, w: 2 },
      { re: /\bsplit\b|\bshare\b|\ballocat(ed|ion)\b/i, w: 2 },
    ],
    headingHints: /fee|revenue|economics|cost/i,
  },
  {
    topic: TOPICS.TOKENOMICS,
    patterns: [
      { re: /\b(total|max|circulating|fixed)\s+supply\b/i, w: 6 },
      { re: /\b\d[\d,]{5,}\b[^.]{0,40}\b(supply|tokens|minted)\b/i, w: 5 },
      { re: /\bvest(ing|ed)?\b|\bcliff\b|\bunlock(s|ed)?\b|\bschedule\b/i, w: 5 },
      { re: /\ballocation\b|\btreasury\b|\bteam\b|\binvestors?\b|\bairdrop\b/i, w: 3 },
      { re: /\bno mint\b|\bcannot be minted\b|\bminted once\b/i, w: 6 },
    ],
    headingHints: /tokenomic|supply|distribution|allocation|token/i,
  },
  {
    topic: TOPICS.REWARDS,
    patterns: [
      { re: /\breward(s|ed)?\b|\bemission(s)?\b|\bincentive(s)?\b/i, w: 4 },
      { re: /\bstak(e|ing)\b|\byield\b|\bAPR\b|\bAPY\b/i, w: 4 },
      { re: /\bpaid\b|\bdistribut(e|ed|ion)\b|\bclaim(s|ed|ing)?\b/i, w: 3 },
      { re: /\bpro rata\b|\bper (token|share|block)\b/i, w: 4 },
    ],
    headingHints: /reward|emission|stak|incentive|yield|earn/i,
  },
  {
    topic: TOPICS.BURN,
    patterns: [
      { re: /\bburn(s|ed|ing)?\b/i, w: 5 },
      { re: /\bbuyback\b|\bbuy back\b|\brepurchase\b/i, w: 4 },
      { re: /\bdead\b|\b0x0+dead\b/i, w: 2 },
    ],
    headingHints: /burn|buyback|deflation/i,
  },
  {
    topic: TOPICS.GOVERNANCE,
    patterns: [
      { re: /\bowner\b|\badmin\b|\bmultisig\b|\btimelock\b/i, w: 5 },
      { re: /\bgovernance\b|\bDAO\b|\bvote(s|d|rs)?\b|\bproposal\b/i, w: 4 },
      { re: /\bcan (change|set|add|remove|pause|update)\b/i, w: 5 },
      { re: /\bpermission(ed|less)?\b|\bonly(Owner)?\b/i, w: 3 },
    ],
    headingHints: /governance|owner|admin|permission|role|control/i,
  },
  {
    topic: TOPICS.SECURITY,
    patterns: [
      { re: /\baudit(ed|s|or)?\b/i, w: 6 },
      { re: /\bunaudited\b|\bnot been audited\b|\bno audit\b/i, w: 7 },
      { re: /\b(fuzz|invariant|fork|unit)\s+test/i, w: 4 },
      { re: /\bbug bounty\b|\bimmunefi\b|\bdisclosure\b/i, w: 4 },
      { re: /\bexploit\b|\bvulnerabilit(y|ies)\b|\bincident\b/i, w: 3 },
    ],
    headingHints: /security|audit|safety|guarantee|bounty/i,
  },
  {
    topic: TOPICS.UPGRADE,
    patterns: [
      { re: /\bproxy\b|\bupgrade(able|d|s)?\b|\bimplementation contract\b/i, w: 5 },
      { re: /\bimmutable\b|\bcannot be changed\b|\bno setter\b|\bwritten once\b/i, w: 5 },
    ],
    headingHints: /upgrade|proxy|immutab/i,
  },
  {
    topic: TOPICS.CUSTODY,
    patterns: [
      { re: /\block(ed|s|ing)?\b[^.]{0,40}\b(liquidity|position|token)/i, w: 6 },
      { re: /\bcustod(y|ial|ies)\b|\bnever takes custody\b|\bself[- ]custody\b/i, w: 5 },
      { re: /\bwithdraw\b|\brug\b|\bno withdraw\b/i, w: 4 },
      { re: /\byour own wallet\b|\bnon[- ]custodial\b/i, w: 4 },
    ],
    headingHints: /custody|lock|safety|liquidity/i,
  },
  {
    topic: TOPICS.RISKS,
    patterns: [
      { re: /\brisk(s|y)?\b/i, w: 5 },
      { re: /\bnot guaranteed\b|\bno guarantee\b|\bmay (lose|fail|go to zero)\b/i, w: 6 },
      { re: /\bvolatile\b|\bworthless\b|\bcannot be reversed\b/i, w: 5 },
      { re: /\blimitation(s)?\b|\bcaveat(s)?\b|\bknown issue(s)?\b/i, w: 5 },
      { re: /\bno review\b|\bunreviewed\b|\bat your own risk\b/i, w: 5 },
    ],
    headingHints: /risk|disclosure|limitation|caveat|warning/i,
  },
  {
    topic: TOPICS.INTEGRATION,
    patterns: [
      { re: /\bcontract(s)? (address(es)?|are|live)\b/i, w: 5 },
      { re: /\bAPI\b|\bendpoint\b|\bSDK\b|\bevent(s)? to index\b/i, w: 4 },
      { re: /\bfunction \w+\(/i, w: 3 },
      { re: /\bchain id\b|\bmainnet\b|\btestnet\b/i, w: 3 },
    ],
    headingHints: /integrat|contract|api|developer|reference|event/i,
  },
  {
    topic: TOPICS.DEPENDENCIES,
    patterns: [
      // Weighted to clear the threshold alone: naming the protocol you are built on
      // IS the dependency fact, and it rarely co-occurs with another keyword.
      { re: /\buniswap\b|\bcurve finance\b|\baave\b|\bchainlink\b|\bpyth\b|\blayerzero\b|\bpermit2\b/i, w: 7 },
      { re: /\boracle\b|\brelayer\b|\bbridge\b|\bsequencer\b/i, w: 4 },
      { re: /\bdepends on\b|\brelies on\b|\bbuilt on top of\b/i, w: 4 },
    ],
    headingHints: /depend|integrat|oracle|bridge|architecture/i,
  },
  {
    topic: TOPICS.PURPOSE,
    patterns: [
      { re: /\b(aims? to|goal is|purpose|designed to|built to|intended to|exists to|makes? it possible)\b/i, w: 6 },
      { re: /\bthis (project|repo|repository|tool|library|package)\b/i, w: 5 },
      { re: /\b(measur|steer|generat|detect|classif|simulat|optimis|optimiz|analys|analyz)\w*\b/i, w: 3 },
      { re: /\bresearch\b|\bexperiment(s|al)?\b|\bbenchmark\b/i, w: 3 },
    ],
    headingHints: /^(about|overview|introduction|what|purpose|motivation|why|summary|abstract)/i,
  },
  {
    topic: TOPICS.METHOD,
    patterns: [
      { re: /\b(method|methodology|approach|pipeline|architecture|implementation)\b/i, w: 5 },
      { re: /\b(model|layer|dataset|prompt|vector|embedding|probe|lens)\b/i, w: 3 },
      { re: /\b(built (with|on)|written in|uses?|runs? on|powered by)\b/i, w: 4 },
      { re: /\b(python|typescript|rust|go|solidity|pytorch|tensorflow|react|node)\b/i, w: 3 },
    ],
    headingHints: /method|approach|architecture|how|stack|design|models?|implementation/i,
  },
  {
    topic: TOPICS.FINDINGS,
    patterns: [
      { re: /\b(finding|result|conclusion|we (found|show|observe)|confirms?|suggests?)\b/i, w: 6 },
      { re: /\b(null|significant|monotone|correlat|baseline|control)\w*\b/i, w: 3 },
      { re: /\b\d+(\.\d+)?\s?(%|x)\b/i, w: 2 },
    ],
    headingHints: /result|finding|conclusion|evaluation|experiment|exp\d/i,
  },
  {
    topic: TOPICS.USAGE,
    patterns: [
      { re: /\b(install|usage|getting started|quick ?start|run (it|the)|to use)\b/i, w: 6 },
      { re: /\b(requires?|dependenc(y|ies)|prerequisite)\b/i, w: 4 },
      { re: /\b(cli|command|flag|environment variable|api key)\b/i, w: 3 },
    ],
    headingHints: /install|usage|getting started|quick|setup|run/i,
  },
  {
    topic: TOPICS.STATUS,
    patterns: [
      { re: /\b(work in progress|wip|experimental|alpha|beta|unstable|prototype|early)\b/i, w: 6 },
      { re: /\b(roadmap|planned|next steps?|todo|not yet (implemented|supported))\b/i, w: 5 },
      { re: /\b(deprecated|archived|no longer maintained)\b/i, w: 6 },
      { re: /\b(ethic(s|al)|licen[cs]e|disclaimer)\b/i, w: 4 },
    ],
    headingHints: /status|roadmap|todo|ethic|licen|disclaimer|caveat|limitation/i,
  },
  {
    topic: TOPICS.GUARANTEE,
    patterns: [
      // The constraint sentences. Weighted highest in the whole rule set because
      // they are the checkable ones.
      { re: /\bcannot\b|\bcan never\b|\bnever\b|\bno (mint|owner|pause|withdraw|admin)\b/i, w: 6 },
      { re: /\bfixed at\b|\bset once\b|\bimmutable\b|\bpermanent(ly)?\b|\bforever\b/i, w: 5 },
      { re: /\bguarantee(d|s)?\b/i, w: 4 },
      { re: /\bhard[- ]coded\b|\bno setter\b/i, w: 5 },
    ],
    headingHints: /guarantee|safety|owner|power|immutab|lock/i,
  },
];

/** Lines that are navigation, legal furniture or code, not prose. */
function isNoise(line: string): boolean {
  const s = line.trim();
  if (s.length < 40) return true;
  if (s.length > 700) return true;
  if (!/[a-z]/.test(s)) return true;
  if (/^(•\s*)?(home|docs|explore|analytics|profile|launch|connect|terms|privacy|dmca)\b/i.test(s)) return true;
  if (/^(©|all rights reserved)/i.test(s)) return true;
  // Code: braces, arrows, import statements, ABI fragments.
  if (/[{};]\s*$/.test(s) || /=>|\bimport\b .*\bfrom\b|\bconst\s+\w+\s*=/.test(s)) return true;
  if ((s.match(/["`]/g) ?? []).length >= 4) return true;
  // ABI fragments and function signatures. Docs quote these inline in integration
  // sections, and they satisfy the prose tests — a signature has words, spaces and
  // no braces — so they need naming directly.
  if (/^"?\s*(function|event|error|struct|interface)\s+\w+/.test(s)) return true;
  if (/\b(uint\d*|bytes\d*|address|bool)\s+\w+\s*[,)]/.test(s)) return true;
  // Word soup from a stripped nav: many short words, no sentence punctuation.
  if (!/[.!?:]/.test(s) && s.split(/\s+/).length > 14) return true;
  return false;
}

/**
 * Split a text block into sentences.
 *
 * Splitting only before a capital letter is the obvious rule and it is wrong
 * here: plenty of protocols write their own name in lower case ("sender is a
 * launch protocol…"), so that rule welds their definitional sentence onto the
 * one before it — which is exactly the sentence a report wants to lead with.
 * Decimals are safe because "0.002" has no space after the point; abbreviations
 * are handled by merging the fragment back.
 */
const ABBREV = /(?:^|\s)(?:e\.g|i\.e|etc|vs|approx|no|fig|cf|al|inc|ltd|st|mr|ms|dr)\.$/i;

function sentences(block: string): string[] {
  const parts = block.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && ABBREV.test(prev)) {
      out[out.length - 1] = `${prev} ${part}`;
      continue;
    }
    out.push(part);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface ExtractionResult {
  evidence: Evidence[];
  metrics: DocMetric[];
  oneLiner?: { text: string; url: string };
  highlights: Highlight[];
  openQuestions: string[];
  topicsCovered: Set<Topic>;
}

export function extractFromDocs(pages: DocPage[], subjectName?: string, shape?: string): ExtractionResult {
  const evidence: Evidence[] = [];
  const seen = new Set<string>();

  for (const [pageIndex, page] of pages.entries()) {
    if (!page.text) continue;
    /*
     * Only the first page may supply the lead description, and only its PURPOSE
     * sentences carry extra authority.
     *
     * For a repo that page is the README. Letting every file claim a lead let
     * `docs/x_handles.md` and `docs/repo_hosting.md` — operational notes about
     * hosting and a Twitter dogpile — answer "what is this project for".
     */
    const isPrimaryPage = pageIndex === 0;
    let heading: string | undefined;
    /*
     * A README's first prose line is the project's own one-sentence description
     * ("Steering language models into strong negative and positive valence
     * states, and measuring what they say…"). It names no product, contains no
     * "is a", and would score near zero on the protocol rules — yet it is the
     * single most useful sentence in the file, so it is promoted explicitly.
     */
    let headingsSeen = 0;
    let leadTaken = false;

    for (const rawLine of page.text.split("\n")) {
      if (rawLine.startsWith("## ")) {
        heading = rawLine.slice(3).trim();
        headingsSeen++;
        continue;
      }
      if (isPrimaryPage && !leadTaken && headingsSeen <= 1 && !isNoise(rawLine) && rawLine.trim().length >= 55) {
        const lead = rawLine.trim();
        /*
         * Skip the banner. READMEs open with a link line — "Live: clanker.church
         * — the Saw Test, public pages…" — before the sentence that says what the
         * project does. Taking the first paragraph blindly made the TLDR a
         * deployment note. A label-and-colon opener, or a domain in the first
         * breath, means "where to find it", not "what it is".
         */
        const isBanner =
          /^[A-Z][\w ]{0,14}:/.test(lead) ||
          /^(live|website|site|docs?|status|demo|homepage|install)\b/i.test(lead) ||
          /\b[a-z0-9-]+\.(com|org|io|xyz|church|dev|app|ai|net)\b/i.test(lead.slice(0, 40));
        if (!isBanner) {
          leadTaken = true;
          evidence.push({ topic: TOPICS.PURPOSE, text: lead, url: page.url, heading, weight: 30, primary: true });
          seen.add(lead.slice(0, 120).toLowerCase());
        }
      }
      if (isNoise(rawLine)) continue;

      for (const sentence of sentences(rawLine)) {
        if (sentence.length < 40 || sentence.length > 420) continue;
        // A short fragment with no terminal punctuation is a table cell whose
        // label was on the line above ("24% of trading fees, plus half of every
        // launch fee"). Quoting it here strands the number; `extractMetrics`
        // reassembles the row and reports it with its label instead.
        if (sentence.length < 70 && !/[.!?:]$/.test(sentence)) continue;
        const key = sentence.slice(0, 120).toLowerCase();
        if (seen.has(key)) continue;

        for (const rule of RULES) {
          let weight = 0;
          for (const { re, w } of rule.patterns) if (re.test(sentence)) weight += w;
          if (weight === 0) continue;
          if (heading && rule.headingHints.test(heading)) weight += 4;
          // A number in a sentence about economics is usually the fact itself.
          if (/\d/.test(sentence) && (rule.topic === TOPICS.FEES || rule.topic === TOPICS.TOKENOMICS)) weight += 2;
          // Naming the project is a sign of a definitional sentence.
          if (subjectName && rule.topic === TOPICS.WHAT) {
            const first = subjectName.split(/\s+/)[0];
            if (first.length > 2 && new RegExp(`\\b${escapeRe(first)}\\b`, "i").test(sentence)) weight += 5;
          }
          // The canonical description lives in the README; a sub-page's take on the
          // project's purpose is secondary to it.
          if (rule.topic === TOPICS.PURPOSE && isPrimaryPage) weight += 8;
          if (weight < 6) continue;

          evidence.push({ topic: rule.topic, text: sentence, url: page.url, heading, weight, primary: isPrimaryPage });
          seen.add(key);
        }
      }
    }
  }

  evidence.sort((a, b) => b.weight - a.weight);

  const topicsCovered = new Set<Topic>(evidence.map((e) => e.topic as Topic));

  return {
    evidence,
    metrics: extractMetrics(pages),
    oneLiner: pickOneLiner(evidence, subjectName),
    highlights: pickHighlightsFor(evidence, shape),
    openQuestions: gapsFor(topicsCovered, shape),
    topicsCovered,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── headline numbers ──────────────────────────────────────────────────────────

interface MetricRule {
  label: string;
  re: RegExp;
  /** Build the printed value from the match. */
  value: (m: RegExpMatchArray) => string;
}

/**
 * A fee-split share, matched in both word orders.
 *
 * Docs write these either way round — "24% of trading fees" under a "$SEND burn"
 * heading, or "70% belongs to the creator side" in prose — and a rule that only
 * handles one order silently records whichever other number happens to sit near
 * the keyword.
 */
function shareRules(label: string, keyword: string): MetricRule[] {
  return [
    // No commas in the gap. A comma between the keyword and the number means the
    // two are in different clauses — "paid to holders, and 30% goes to the burn"
    // is not a 30% holder share, and adjacency alone cannot tell the difference.
    { label, re: new RegExp(`\\b(${keyword})\\b[^.,\\d]{0,24}(\\d{1,3})\\s?%`, "i"), value: (m) => `${m[2]}%` },
    { label, re: new RegExp(`(\\d{1,3})\\s?%[^.,]{0,24}\\b(${keyword})\\b`, "i"), value: (m) => `${m[1]}%` },
  ];
}

const METRIC_RULES: MetricRule[] = [
  {
    label: "Trading fee",
    re: /(\d+(?:\.\d+)?)\s?%\s*(?:of every |per |on every |trading )?(?:swap|trade|transaction|trading fee|fee)/i,
    value: (m) => `${m[1]}%`,
  },
  {
    label: "Total supply",
    re: /(?:total|fixed|max)\s+supply[^.\d]{0,20}([\d][\d,\s]{5,})/i,
    value: (m) => m[1].replace(/\s/g, ""),
  },
  {
    label: "Total supply",
    re: /\b([\d][\d,]{8,})\b[^.]{0,30}\b(?:tokens?|supply)\b/i,
    value: (m) => m[1],
  },
  {
    label: "Launch / mint fee",
    re: /(Ξ|ETH\s?|SOL\s?|\$)([\d.]+)\s*(?:launch|creation|mint|listing)\s*fee/i,
    value: (m) => `${m[1].trim()}${m[2]}`,
  },
  {
    label: "Launch / mint fee",
    // Lazy gap: greedy would swallow the currency mark before the optional group
    // gets a chance at it, printing "0.002" for "Ξ0.002".
    re: /(?:launch|creation|listing)\s+fee[^.\d]{0,20}?(Ξ|ETH\s?|SOL\s?|\$)?([\d.]+)/i,
    value: (m) => `${(m[1] ?? "").trim()}${m[2]}`,
  },
  ...shareRules("Creator share of fees", /creator|deployer/.source),
  ...shareRules("Burn share of fees", /burn/.source),
  ...shareRules("Protocol / treasury share", /protocol|treasury/.source),
  ...shareRules("Holder / staker share", /holders?|stakers?/.source),
  { label: "Stated APR / APY", re: /(\d+(?:\.\d+)?)\s?%\s*(?:APR|APY)/i, value: (m) => m[0].trim() },
  {
    label: "Vesting / lock period",
    re: /(\d+)\s*(day|week|month|year)s?[^.]{0,30}\b(?:vest|lock|cliff|unlock)/i,
    value: (m) => `${m[1]} ${m[2]}${Number(m[1]) === 1 ? "" : "s"}`,
  },
  { label: "Fee tier / pool fee", re: /\bfee tier\b[^.\d]{0,15}(\d+(?:\.\d+)?)\s?%/i, value: (m) => `${m[1]}%` },
];

/**
 * Docs lay their economics out as two-column tables, and stripping the markup
 * leaves the label and the value on separate lines:
 *
 *     $SEND burn
 *     24% of trading fees, plus half of every launch fee
 *
 * Matching line by line therefore finds "24%" with no idea what it belongs to,
 * and the nearest keyword on the same line wins instead — which is how a burn
 * share gets recorded as a protocol share. So each line is also tested with the
 * short line above it prepended: the table row, reassembled.
 */
function labelledLines(text: string): { line: string; raw: string; isRow: boolean }[] {
  const out: { line: string; raw: string; isRow: boolean }[] = [];
  let prevShort: string | null = null;
  for (const rawLine of text.split("\n")) {
    if (rawLine.startsWith("## ")) {
      prevShort = null;
      continue;
    }
    const line = rawLine.trim();
    if (line.length >= 8 && line.length <= 400) {
      out.push({ line, raw: line, isRow: false });
      // Only pair a label with a value that LOOKS like a table cell: short, and
      // at most one sentence. Without that, a step label followed by a paragraph
      // ("Earn" → "Every trade pays a 1% fee. 70% belongs to the creator side,
      // and 30% goes to the burn and the protocol.") is read as a spec row, and
      // its rounded-up aggregate then outranks the real fee table further down.
      const cellLike = prevShort !== null && line.length <= 140 && (line.match(/[.!?]/g) ?? []).length <= 1;
      if (cellLike) {
        const row = `${prevShort} — ${line}`;
        out.push({ line: row, raw: row, isRow: true });
      }
    }
    // A short line with no digits is a label, not a fact.
    prevShort = line.length > 0 && line.length <= 60 && !/\d/.test(line) ? line : null;
  }
  return out;
}

export function extractMetrics(pages: DocPage[]): DocMetric[] {
  const out: DocMetric[] = [];
  const takenLabels = new Set<string>();

  // Best candidate per label rather than first: a table row is the protocol's own
  // spec sheet, while a prose mention is usually a rounded-up aggregate ("30%
  // goes to the burn and the protocol" is two shares added together).
  const best = new Map<string, { metric: DocMetric; priority: number }>();

  for (const page of pages) {
    for (const { line, raw, isRow } of labelledLines(page.text)) {
      for (const rule of METRIC_RULES) {
        const m = line.match(rule.re);
        if (!m) continue;
        const value = rule.value(m).trim();
        if (!value || value.length > 40) continue;
        const priority = isRow ? 2 : 1;
        const existing = best.get(rule.label);
        if (existing && existing.priority >= priority) continue;
        best.set(rule.label, {
          priority,
          metric: {
            label: rule.label,
            value,
            url: page.url,
            context: raw.length > 160 ? `${raw.slice(0, 157)}…` : raw,
          },
        });
      }
    }
  }

  for (const { metric } of best.values()) {
    if (takenLabels.has(metric.label)) continue;
    takenLabels.add(metric.label);
    out.push(metric);
  }
  return out;
}

// ── TLDR construction ─────────────────────────────────────────────────────────

/** The "what is it" line: the best definitional sentence in the docs. */
function pickOneLiner(evidence: Evidence[], subjectName?: string): { text: string; url: string } | undefined {
  const candidates = evidence
    // PURPOSE carries a README's lead sentence, which is the best "what is this"
    // a software project ever offers; WHAT carries a protocol's "X is a …".
    .filter((e) => (e.topic === TOPICS.WHAT || e.topic === TOPICS.PURPOSE) && e.text.length >= 40 && e.text.length <= 320)
    .sort((a, b) => {
      // Prefer a sentence that opens with the project name — "X is a …".
      const score = (e: Evidence) => {
        let s = e.weight;
        if (subjectName) {
          const first = subjectName.split(/\s+/)[0];
          if (first.length > 2 && new RegExp(`^${escapeRe(first)}\\b`, "i").test(e.text)) s += 12;
        }
        if (/\bis (a|an|the)\b/i.test(e.text.slice(0, 60))) s += 6;
        return s;
      };
      return score(b) - score(a);
    });
  const top = candidates[0];
  if (!top) return undefined;
  /*
   * One sentence, not the whole opening paragraph.
   *
   * The lead-paragraph rule hands over a block, which for a protocol's overview is
   * four sentences of which only the first answers "what is this". The rest belongs
   * in the body, where it already appears.
   */
  const first = sentences(top.text)[0];
  const text = first && first.length >= 40 ? first : top.text;
  return { text, url: top.url };
}

/**
 * The features worth leading with.
 *
 * Ranked by how much a reader's decision changes if the sentence is true, which
 * in practice means: constraints first (they are checkable), then economics (who
 * gets paid), then mechanism, then the rest. One highlight per heading, so a
 * docs page that labours one point cannot fill the whole TLDR.
 */
export function pickHighlightsFor(evidence: Evidence[], shape?: string): Highlight[] {
  /*
   * A project run must not be offered the protocol priorities. "Naming rules —
   * never render handles as names" outranked the README's own description purely
   * because it contains the word "never" and GUARANTEE sits at the head of the
   * protocol list.
   */
  const PROJECT_PRIORITY: Topic[] = [
    TOPICS.PURPOSE,
    TOPICS.FINDINGS,
    TOPICS.METHOD,
    TOPICS.STATUS,
    TOPICS.USAGE,
    TOPICS.SECURITY,
  ];
  const PRIORITY: Topic[] = shape && shape !== "protocol" ? PROJECT_PRIORITY : [
    // Protocol-side first, then project-side. A protocol run never reaches the
    // tail because the early buckets fill; a project run never matches the head,
    // so one ordered list serves both without a mode switch here.
    TOPICS.GUARANTEE,
    TOPICS.CUSTODY,
    TOPICS.FEES,
    TOPICS.REWARDS,
    TOPICS.TOKENOMICS,
    TOPICS.MECHANISM,
    TOPICS.BURN,
    TOPICS.GOVERNANCE,
    TOPICS.PURPOSE,
    TOPICS.FINDINGS,
    TOPICS.METHOD,
    TOPICS.STATUS,
    TOPICS.USAGE,
  ];

  const out: Highlight[] = [];
  const usedHeadings = new Set<string>();
  const usedText = new Set<string>();

  /*
   * Two passes: the primary page first, everything else only to fill.
   *
   * Sorting by `primary` inside a topic was not enough — a topic whose only
   * evidence lives in a sub-page still claimed a slot ahead of the README's other
   * material, so a GPU cost note reached the TLDR of a research project. The
   * README gets first refusal on every slot.
   */
  for (const pass of [true, false]) {
    if (out.length >= 5 && pass === false) break;
    for (const topic of PRIORITY) {
      if (out.length >= 6) break;
      const pick = pickOne(evidence, topic, pass, usedHeadings, usedText);
      if (!pick) continue;
      usedHeadings.add((pick.heading ?? "").toLowerCase());
      usedText.add(pick.text.slice(0, 80));
      out.push({
        label: pick.heading && pick.heading.length <= 48 ? pick.heading : labelFor(topic),
        detail: pick.text,
        url: pick.url,
      });
    }
  }
  return out;
}

function pickOne(
  evidence: Evidence[],
  topic: Topic,
  primaryOnly: boolean,
  usedHeadings: Set<string>,
  usedText: Set<string>
): Evidence | undefined {
  return evidence
    .filter((e) => e.topic === topic)
    .filter((e) => (primaryOnly ? e.primary === true : true))
    // A table cell ("24% of trading fees, plus half of every launch fee") is a
    // fact but not a sentence, and a TLDR built from fragments reads like a spec
    // sheet. Terminal punctuation is what separates prose from a cell.
    .filter((e) => e.text.length >= 55 && e.text.length <= 300 && /[.!?]$/.test(e.text))
    .sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false) || b.weight - a.weight)
    .find((e) => {
      const h = (e.heading ?? "").toLowerCase();
      return !usedHeadings.has(h) && !usedText.has(e.text.slice(0, 80));
    });
}


function labelFor(topic: Topic): string {
  switch (topic) {
    case TOPICS.GUARANTEE: return "What cannot change";
    case TOPICS.CUSTODY: return "Custody and locks";
    case TOPICS.FEES: return "Fees";
    case TOPICS.REWARDS: return "Rewards";
    case TOPICS.TOKENOMICS: return "Supply";
    case TOPICS.MECHANISM: return "How it works";
    case TOPICS.BURN: return "Burn";
    case TOPICS.GOVERNANCE: return "Admin powers";
    case TOPICS.PURPOSE: return "What it is for";
    case TOPICS.METHOD: return "How it is built";
    case TOPICS.FINDINGS: return "What it found";
    case TOPICS.USAGE: return "Running it";
    case TOPICS.STATUS: return "Maturity";
    default: return "Detail";
  }
}

/**
 * What the docs never said.
 *
 * A checklist is only useful if it reports its own misses, so every framework
 * bucket that produced no evidence becomes an explicit open question. Silence on
 * audits reads very differently from a documented "unaudited", and this is what
 * keeps the two apart.
 */
export function gapsFor(covered: Set<Topic>, shape?: string): string[] {
  /*
   * Only a protocol is asked protocol questions.
   *
   * Running the mechanism checklist over a research repo produced a report whose
   * "unanswered" section was mostly "the docs do not state a fee schedule" — true,
   * and completely uninformative, because nothing about the project implied one.
   * A checklist that reports absences nobody expected is noise with a serious
   * face on.
   */
  if (shape === "project-with-token" || shape === "token-only") {
    const PROJECT_REQUIRED: { topic: Topic; question: string }[] = [
      { topic: TOPICS.PURPOSE, question: "The repository does not state what it is for in prose — the purpose has to be inferred from the code." },
      { topic: TOPICS.USAGE, question: "No install or usage instructions, so the code's runnability is unverified." },
      { topic: TOPICS.STATUS, question: "Maturity is unstated: nothing says whether this is experimental, maintained or abandoned." },
      { topic: TOPICS.FINDINGS, question: "No results or outputs are claimed, so there is nothing to evaluate the work against." },
    ];
    return PROJECT_REQUIRED.filter((r) => !covered.has(r.topic)).map((r) => r.question);
  }

  const REQUIRED: { topic: Topic; question: string }[] = [
    { topic: TOPICS.TOKENOMICS, question: "Supply, allocation and any vesting/unlock schedule are not stated in the docs we could read." },
    { topic: TOPICS.FEES, question: "The docs do not state a fee schedule — who pays, how much, and where it goes." },
    { topic: TOPICS.SECURITY, question: "No audit or testing statement found. Treat the contracts as unreviewed until proven otherwise." },
    { topic: TOPICS.GOVERNANCE, question: "Admin powers are undocumented: who can change parameters, and is there a timelock or multisig?" },
    { topic: TOPICS.UPGRADE, question: "Upgradeability is not addressed — whether the contracts are proxies, and who may upgrade them." },
    { topic: TOPICS.CUSTODY, question: "Custody is not addressed: who can move user funds or protocol liquidity." },
    { topic: TOPICS.RISKS, question: "The docs carry no risk disclosure or limitations section." },
    { topic: TOPICS.REWARDS, question: "No reward or emission mechanism is described, so there is no documented reason to hold." },
  ];
  return REQUIRED.filter((r) => !covered.has(r.topic)).map((r) => r.question);
}

/**
 * Evidence for one topic, best first, de-duplicated by opening words.
 *
 * Near-duplicates are the normal case: docs restate a claim in the overview and
 * again in the reference, and a report that prints both looks padded.
 */
export function topEvidence(evidence: Evidence[], topic: Topic, limit: number): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const ordered = evidence
    .filter((x) => x.topic === topic)
    .sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false) || b.weight - a.weight);
  for (const e of ordered) {
    const key = e.text.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
