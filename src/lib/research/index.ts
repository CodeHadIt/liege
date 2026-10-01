// ── /research: one command, four kinds of input, one report ───────────────────
// The resolution graph. Whatever the user hands over, the run converges on the
// same set of facts:
//
//   address ──► DexScreener ──► chain, market, the project's own links
//           └─► CoinGecko   ──► homepage, whitepaper, repo, X handle, categories
//           └─► RPC + explorer ─► supply, owner, proxy, selectors, verification
//   website ──► docs discovery ──► crawl ──► extraction ──► verification
//   github  ──► liveness, docs/, audits/, tests/
//   query   ──► DexScreener + CoinGecko search, then as above
//
// The order matters: the address stage is what produces a website, the website
// stage is what produces the docs, and the docs are what the chain then gets
// checked against. A run that starts from a docs URL simply enters the chain
// lower down and works outward — which is why `/research <docs url>` and
// `/research <ca>` end up at the same report.
//
// Everything is wrapped in one wall-clock budget. Sources that do not answer in
// time are recorded as skipped and the report still goes out: a late report
// nobody reads is worse than a report that says which source was quiet.

import { getTokenPairs, searchPairs, type DexScreenerPair } from "@/lib/api/dexscreener";
import type { ChainId } from "@/types/chain";
import { classifyInput } from "./classify";
import { extractFromDocs, gapsFor, pickHighlightsFor, TOPICS } from "./extract";
import { profileSubject } from "./profile";
import { classifyTokenShape } from "./token-shape";
import { budgetLeft, newBudget } from "./fetcher";
import { primaryMarket, synthesiseRisks } from "./report";
import { coinByContract, coinById, linksOf, searchCoins, type CoinGeckoCoin } from "./sources/coingecko";
import { crawlDocs, discoverDocs, extractContracts } from "./sources/docs";
import { fetchRepoDocs, inspectGithub, parseGithubUrl } from "./sources/github";
import { detectEvmChain, inspectEvm, inspectSolana } from "./sources/onchain";
import { verifyAgainstChain } from "./verify";
import type {
  DocsFindings,
  GithubFindings,
  OnChainFacts,
  ResearchReport,
  SocialFindings,
  SourceStatus,
  Subject,
  TokenMarket,
} from "./types";

/** DexScreener's chain slugs → our ids. */
const DS_CHAIN: Record<string, ChainId> = {
  ethereum: "eth",
  base: "base",
  bsc: "bsc",
  solana: "solana",
  robinhood: "rh",
  ton: "ton",
};

export interface ResearchOptions {
  /** Total wall-clock budget. Default 110s — a Telegram user waits, but not long. */
  budgetMs?: number;
  /** Docs pages to read. Default 8. */
  maxDocPages?: number;
}

export async function runResearch(rawInput: string, opts: ResearchOptions = {}): Promise<ResearchReport> {
  const started = Date.now();
  const budget = newBudget(opts.budgetMs ?? 110_000);
  const coverage: SourceStatus[] = [];

  /*
   * More than one input is the normal case, not an edge case.
   *
   * People hand over what they have: a contract address AND the repo, or a site
   * AND its docs. Taking only the first token threw away the half the user had
   * gone to the trouble of finding — and the discovery stages, good as they are,
   * cannot beat somebody telling us where the code lives.
   *
   * The address wins the "primary" slot because it is what anchors the chain
   * reads; every other token becomes a hint that short-circuits a discovery step.
   */
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const classified = tokens.map(classifyInput);
  const input =
    classified.find((c) => c.kind === "evm-address" || c.kind === "solana-address") ??
    classified.find((c) => c.kind.startsWith("url-") && c.kind !== "url-github") ??
    classified[0] ??
    classifyInput(rawInput);
  const hints = classified.filter((c) => c !== input);
  const ghHint = hints.find((h) => h.kind === "url-github")?.value;
  const docsHint = hints.find((h) => h.kind === "url-docs" || h.kind === "url-whitepaper")?.value;
  const siteHint = hints.find((h) => h.kind === "url-website")?.value;
  if (hints.length) {
    coverage.push({
      id: "hints",
      state: "ok",
      detail: hints.map((h) => `${h.kind.replace("url-", "")} supplied by the user`).join("; "),
      count: hints.length,
    });
  }

  const subject: Subject = { name: "", categories: [] };
  const social: SocialFindings = { otherLinks: [] };
  let markets: TokenMarket[] = [];
  let onchain: OnChainFacts | undefined;
  let docs: DocsFindings | undefined;
  let github: GithubFindings | undefined;
  let coin: CoinGeckoCoin | null = null;
  let address: string | undefined;
  let chain: ChainId | undefined;
  let entryUrl: string | undefined;

  // ── stage 1: establish the address and/or the entry URL ────────────────────
  if (input.kind === "evm-address" || input.kind === "solana-address") {
    address = input.value;
  } else if (input.kind === "query") {
    const hits = await searchPairs(input.value);
    if (hits.length) {
      const best = [...hits].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      address = best.baseToken.address;
      coverage.push({ id: "search", state: "ok", detail: `matched "${input.value}" to ${best.baseToken.symbol} via DexScreener`, count: hits.length });
    } else {
      const cgHits = await searchCoins(input.value, budget);
      if (cgHits.length) {
        coin = await coinById(cgHits[0].id, budget);
        coverage.push({ id: "search", state: "ok", detail: `matched "${input.value}" to ${cgHits[0].name} via CoinGecko` });
      } else {
        coverage.push({ id: "search", state: "empty", detail: `nothing matched "${input.value}" on DexScreener or CoinGecko` });
      }
    }
  } else {
    entryUrl = input.value;
  }

  // ── stage 2: DexScreener — chain, market, and the project's own links ──────
  if (address) {
    const pairs = await dexScreenerFor(address);
    if (pairs.length) {
      markets = pairs.map(toMarket);
      chain = DS_CHAIN[pairs[0].chainId] ?? chain;
      const withInfo = pairs.find((p) => p.info?.websites?.length || p.info?.socials?.length);
      if (withInfo?.info) {
        for (const w of withInfo.info.websites ?? []) if (w.url) social.otherLinks.push(w.url);
        for (const s of withInfo.info.socials ?? []) {
          if (!s.url) continue;
          if (/twitter|^x$/i.test(s.type)) social.twitter = s.url;
          else if (/telegram/i.test(s.type)) social.telegram = s.url;
          else if (/discord/i.test(s.type)) social.discord = s.url;
          else social.otherLinks.push(s.url);
        }
      }
      const base = pairs[0].baseToken;
      subject.name = base.name || subject.name;
      subject.symbol = base.symbol || subject.symbol;
      coverage.push({ id: "dexscreener", state: "ok", detail: `${pairs.length} pair(s) across ${new Set(pairs.map((p) => p.chainId)).size} chain(s)`, count: pairs.length });
    } else {
      coverage.push({
        id: "dexscreener",
        state: "empty",
        detail: "no trading pair — normal for an infrastructure contract (factory, router, locker)",
      });
    }

    // No pair means no chain yet. Probe rather than assume Ethereum.
    if (!chain) {
      if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
        chain = (await detectEvmChain(address, budget)) ?? undefined;
        if (chain) coverage.push({ id: "chain-probe", state: "ok", detail: `code found on ${chain} by eth_getCode probe` });
        else coverage.push({ id: "chain-probe", state: "empty", detail: "no code on Ethereum, Base, BNB Chain or Robinhood Chain" });
      } else {
        chain = "solana";
      }
    }
  }

  // ── stage 3: on-chain facts ────────────────────────────────────────────────
  if (address && chain) {
    onchain = chain === "solana" ? await inspectSolana(address, budget) : await inspectEvm(chain, address, budget);
    const bits = [
      onchain.contractName ? `source: ${onchain.contractName}` : undefined,
      onchain.verified ? "verified" : undefined,
      onchain.proxyType,
      onchain.symbol ? `symbol ${onchain.symbol}` : undefined,
      // An SPL mint exposes none of the above, so without this the coverage line
      // read "no facts read" on a run that had just read supply, decimals and both
      // authorities. A source that answered must never report as silent.
      onchain.totalSupply !== undefined ? `supply read${onchain.decimals !== undefined ? ` (${onchain.decimals} dp)` : ""}` : undefined,
      onchain.chain === "solana" && onchain.hasMintSelector === false ? "mint authority revoked" : undefined,
      onchain.chain === "solana" && onchain.hasMintSelector === true ? "mint authority LIVE" : undefined,
    ].filter(Boolean);
    coverage.push({
      id: "chain",
      state: bits.length || onchain.totalSupply !== undefined ? "ok" : "empty",
      detail: bits.length ? `${chain}: ${bits.join(", ")}` : `${chain}: ${onchain.notes[0] ?? "no facts read"}`,
    });
    subject.name = subject.name || onchain.name || onchain.contractName || "";
    subject.symbol = subject.symbol || onchain.symbol;
  }

  // ── stage 4: CoinGecko — the link graph ───────────────────────────────────
  if (!coin && address && chain) {
    coin = await coinByContract(chain, address, budget);
    coverage.push(
      coin
        ? { id: "coingecko", state: "ok", detail: `listed as "${coin.name}" (${coin.id})` }
        : { id: "coingecko", state: "empty", detail: "not listed — no homepage/whitepaper/repo links from this source" }
    );
  }
  if (coin) {
    subject.name = coin.name || subject.name;
    subject.symbol = subject.symbol || coin.symbol?.toUpperCase();
    subject.categories = (coin.categories ?? []).filter((c): c is string => !!c).slice(0, 6);
    if (coin.links?.whitepaper) subject.whitepaperUrl = coin.links.whitepaper;
    if (coin.links?.twitter_screen_name && !social.twitter) {
      social.twitter = `https://x.com/${coin.links.twitter_screen_name}`;
    }
    if (coin.community_data?.twitter_followers) social.twitterFollowers = coin.community_data.twitter_followers;
    if (coin.links?.telegram_channel_identifier && !social.telegram) {
      social.telegram = `https://t.me/${coin.links.telegram_channel_identifier}`;
    }
    social.otherLinks.push(...linksOf(coin));
    entryUrl = entryUrl ?? coin.links?.homepage?.find((h) => /^https?:\/\//.test(h ?? ""));
  }

  // The website, in order of trust: what the user gave us (as the primary input or
  // as a hint), then what the token's own DexScreener profile links, then
  // CoinGecko's homepage.
  entryUrl = entryUrl ?? siteHint ?? docsHint;
  if (!entryUrl) {
    entryUrl = social.otherLinks.find((u) => !/x\.com|twitter\.com|t\.me|discord|github\.com/i.test(u));
  }
  subject.website = entryUrl;

  // ── stage 5: documentation ────────────────────────────────────────────────
  if (entryUrl && budgetLeft(budget) > 8_000) {
    const { found, siteLinks, note } = await discoverDocs(docsHint ?? entryUrl, budget, {
      given: docsHint !== undefined || input.kind === "url-docs" || input.kind === "url-whitepaper",
      externalCandidates: social.otherLinks,
    });
    social.otherLinks.push(...siteLinks);
    if (found) {
      docs = await crawlDocs(found, budget, { maxPages: opts.maxDocPages ?? 8 });
      subject.docsUrl = docs.rootUrl;
      coverage.push({
        id: "docs",
        state: "ok",
        detail: `${docs.pages.length} page(s), ${docs.pages.reduce((n, p) => n + p.chars, 0).toLocaleString("en-US")} chars — found by ${docs.discovery}`,
        count: docs.pages.length,
      });
    } else {
      coverage.push({ id: "docs", state: budget.blocked.size ? "failed" : "empty", detail: note });
    }
  } else if (!entryUrl) {
    coverage.push({ id: "docs", state: "skipped", detail: "no website to search — nothing linked a homepage for this address" });
  } else {
    coverage.push({ id: "docs", state: "skipped", detail: "budget spent before the docs stage" });
  }

  // ── stage 6: GitHub ───────────────────────────────────────────────────────
  const ghCandidate =
    ghHint ??
    (input.kind === "url-github" ? input.value : undefined) ??
    coin?.links?.repos_url?.github?.find((u) => !!u) ??
    social.otherLinks.find((u) => parseGithubUrl(u) !== null);
  if (ghCandidate && budgetLeft(budget) > 5_000) {
    github = (await inspectGithub(ghCandidate, budget)) ?? undefined;
    if (github) {
      subject.githubUrl = github.url;
      coverage.push({
        id: "github",
        state: "ok",
        detail: `${github.owner}/${github.repo ?? "?"} — ${github.stars ?? 0}★, last push ${github.pushedAt?.slice(0, 10) ?? "unknown"}`,
      });
    } else {
      coverage.push({ id: "github", state: "failed", detail: `could not read ${ghCandidate}` });
    }
  } else {
    coverage.push({ id: "github", state: "skipped", detail: ghCandidate ? "budget spent" : "no repository linked anywhere we looked" });
  }

  /*
   * The repository is the documentation, when nothing else is.
   *
   * A code-first project publishes no docs site: its README and `docs/` tree ARE
   * the specification. Skipping the docs stage for want of a homepage scored those
   * projects as undocumented, which is exactly backwards — they document
   * themselves better than most sites do.
   *
   * Also used when a docs site was found but turned out to be a stub, because a
   * 900-character landing page should not outrank a real README.
   */
  /*
   * A repo README often names the live site ("Live: clanker.church") where no
   * other source has a homepage at all — the token has no website in its
   * metadata, and CoinGecko has never heard of it. Worth one regex.
   */
  const siteFromReadme = (text: string): string | undefined => {
    const m = text.match(/\b(?:live|website|site|demo|homepage|hosted at)\b[^\n]{0,40}?\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
    const host = m?.[1];
    if (!host || /github\.com|x\.com|twitter\.com|t\.me|discord|\.(py|ts|js|md|json|toml|yml)$/i.test(host)) return undefined;
    return `https://${host}`;
  };

  const docsChars = docs?.pages.reduce((n, p) => n + p.chars, 0) ?? 0;
  if (github?.repo && docsChars < 4_000 && budgetLeft(budget) > 6_000) {
    const repoPages = await fetchRepoDocs(github.owner, github.repo, budget);
    const repoChars = repoPages.reduce((n, p) => n + p.chars, 0);
    if (repoChars > docsChars) {
      docs = {
        rootUrl: github.url,
        discovery: docs ? "repo (richer than the docs site we found)" : "repo",
        pages: repoPages,
        contracts: extractContracts(repoPages),
      };
      subject.docsUrl = subject.docsUrl ?? github.url;
      if (!subject.website) {
        const fromReadme = siteFromReadme(repoPages.map((p) => p.text).join("\n").slice(0, 4_000));
        if (fromReadme) {
          subject.website = fromReadme;
          coverage.push({ id: "site:readme", state: "ok", detail: `homepage taken from the README: ${fromReadme}` });
        }
      }
      coverage.push({
        id: "docs:repo",
        state: "ok",
        detail: `${repoPages.length} file(s) from the repository, ${repoChars.toLocaleString("en-US")} chars — README${
          github.hasDocsDir ? " + docs/" : ""
        }`,
        count: repoPages.length,
      });
    } else if (repoPages.length === 0) {
      coverage.push({ id: "docs:repo", state: "empty", detail: "repository has no README or docs/ Markdown we could read" });
    }
  }

  // ── stage 7: extraction, verification, risk ───────────────────────────────
  const extraction = docs
    ? extractFromDocs(docs.pages, subject.name || subject.symbol)
    : { evidence: [], metrics: [], highlights: [], openQuestions: [], oneLiner: undefined, topicsCovered: new Set<string>() };

  /*
   * Classify the subject, THEN re-derive the gap list.
   *
   * The gaps depend on the shape and the shape depends on the evidence, so the
   * extraction runs once shape-blind and only the cheap, pure part is recomputed.
   * Re-running extraction would re-walk every page for nothing.
   */
  const profile = profileSubject({
    evidence: extraction.evidence,
    docs,
    github,
    hasToken: markets.length > 0 || onchain?.totalSupply !== undefined,
  });
  const tokenShape =
    address !== undefined ? classifyTokenShape(markets, onchain, profile.mechanicsDocumented) : undefined;

  if (extraction.oneLiner) {
    subject.oneLiner = extraction.oneLiner.text;
    subject.oneLinerUrl = extraction.oneLiner.url;
  } else if (coin?.description?.en) {
    // CoinGecko descriptions are project-supplied, so this is still a quote
    // rather than our own prose — but it is marketing copy, not a reference, so
    // it is only used when the docs gave us nothing.
    const firstSentence = coin.description.en.split(/(?<=[.!?])\s+/)[0]?.replace(/<[^>]*>/g, "").trim();
    if (firstSentence && firstSentence.length > 30) {
      subject.oneLiner = firstSentence;
      subject.oneLinerUrl = `https://www.coingecko.com/en/coins/${coin.id}`;
    }
  }
  if (!subject.name) subject.name = subject.symbol ?? input.value;

  // A ready-made X search is the honest answer to "what is being said about this
  // CA": reading the timeline needs an API key this bot does not have, so the
  // report links the search instead of pretending to have read it.
  if (address) social.caSearchUrl = `https://x.com/search?q=${encodeURIComponent(address)}&f=live`;
  social.otherLinks = [...new Set(social.otherLinks)].filter(
    (u) => u !== subject.website && u !== social.twitter && u !== social.telegram
  );

  const verifications = verifyAgainstChain(extraction.evidence, extraction.metrics, onchain);
  const market = primaryMarket(markets);
  const risks = synthesiseRisks({
    onchain,
    market,
    docs,
    github,
    evidence: extraction.evidence,
    verifications,
    profile,
    tokenShape,
  });

  const openQuestions = [...gapsFor(extraction.topicsCovered as Set<never>, profile.shape)];
  if (!docs) openQuestions.unshift("No documentation was found, so nothing in this report about the mechanism is sourced from the project.");
  if (onchain?.implementation && !extraction.topicsCovered.has(TOPICS.UPGRADE)) {
    openQuestions.push(
      `This address is ${/^[aeiou]/i.test(onchain.proxyType ?? "p") ? "an" : "a"} ${onchain.proxyType ?? "proxy"} pointing at ${onchain.implementation}, which the docs never mention. Read the implementation, not this address.`
    );
  }

  return {
    input,
    subject,
    profile,
    tokenShape,
    // Recomputed now that the shape is known — same reason as the gap list.
    highlights: pickHighlightsFor(extraction.evidence, profile.shape),
    docMetrics: extraction.metrics,
    market,
    markets,
    onchain,
    docs,
    github,
    social,
    evidence: extraction.evidence,
    verifications,
    risks,
    openQuestions,
    coverage,
    elapsedMs: Date.now() - started,
    generatedAt: Date.now(),
  };
}

/**
 * Every pair for an address, without knowing its chain first.
 *
 * DexScreener's per-chain endpoint needs a chain id, which is the thing we are
 * trying to learn, so the search endpoint goes first — it matches an address
 * across every chain it indexes. The per-chain call is kept as the follow-up for
 * the case where search returns a token that merely mentions the address.
 */
async function dexScreenerFor(address: string): Promise<DexScreenerPair[]> {
  const hits = await searchPairs(address);
  const own = hits.filter(
    (p) =>
      p.baseToken.address.toLowerCase() === address.toLowerCase() ||
      p.quoteToken.address.toLowerCase() === address.toLowerCase()
  );
  if (own.length) return own;
  for (const slug of ["ethereum", "base", "bsc", "solana"]) {
    const pairs = await getTokenPairs(slug, address);
    if (pairs.length) return pairs;
  }
  return [];
}

function toMarket(p: DexScreenerPair): TokenMarket {
  const txns = p.txns?.h24 ? p.txns.h24.buys + p.txns.h24.sells : undefined;
  return {
    chain: p.chainId,
    pairLabel: p.baseToken?.symbol && p.quoteToken?.symbol ? `${p.baseToken.symbol}/${p.quoteToken.symbol}` : undefined,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
    fdv: p.fdv,
    marketCap: p.marketCap,
    liquidityUsd: p.liquidity?.usd,
    volume24h: p.volume?.h24,
    priceChange24h: p.priceChange?.h24,
    txns24h: txns,
    pairCreatedAt: p.pairCreatedAt,
    url: p.url,
  };
}

export { classifyInput } from "./classify";
export type { ResearchReport } from "./types";
