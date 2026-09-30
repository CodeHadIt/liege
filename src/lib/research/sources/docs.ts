// ── Finding and reading a protocol's own documentation ────────────────────────
// This is the most valuable source in the pipeline and the least standardised.
// For almost every protocol worth researching, the docs say plainly what the
// marketing page implies and what the token page cannot show: how the mechanism
// works, where fees go, what the admin can do, and what the team already knows
// is imperfect.
//
// Four discovery routes, tried in order and recorded in the report so a reader
// knows how we got there:
//
//   given      — the user handed us a docs URL
//   link       — a link on the project's own site, scored for docs-ness
//   probe      — the conventional paths (/docs, docs.<apex>, /whitepaper …)
//   external   — a link from CoinGecko or GitHub
//
// A candidate is only accepted if the page it returns actually reads like
// documentation. Single-page apps answer 200 for everything, so "the URL
// resolved" proves nothing — hence `looksLikeDocs`, which asks the text.

import { looksLikeDocsUrl, looksLikeWhitepaperUrl } from "../classify";
import {
  extractLinks,
  extractUrlsFromText,
  fetchPage,
  htmlToText,
  budgetSpent,
  type Budget,
} from "../fetcher";
import type { DocPage, DocsFindings } from "../types";

/** Conventional docs locations, tried against the project's own origin. */
const PROBE_PATHS = [
  "/docs",
  "/docs/",
  "/documentation",
  "/developers",
  "/developer",
  "/docs/introduction",
  "/docs/overview",
  "/whitepaper",
  "/litepaper",
  "/learn",
];

/** Words that make a page read like a reference rather than a landing page. */
const DOC_SIGNALS = [
  "overview",
  "getting started",
  "introduction",
  "how it works",
  "architecture",
  "contracts",
  "parameters",
  "tokenomics",
  "fees",
  "api",
  "reference",
  "faq",
  "guide",
  "integration",
  "protocol",
];

export function looksLikeDocs(text: string, headings: string[]): boolean {
  if (text.length < 800) return false;
  const lower = text.toLowerCase();
  if (/\b(404|page not found|this page could not be found)\b/.test(lower.slice(0, 400))) return false;
  const hits = DOC_SIGNALS.filter((w) => lower.includes(w)).length;
  return headings.length >= 3 || hits >= 3;
}

function apexOf(host: string): string {
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : host;
}

/**
 * Score a candidate link for how likely it is to be THE docs root.
 *
 * Deeper paths lose: a link to one page of a reference is worse than a link to
 * its index, because the crawler expands from wherever it starts.
 */
function scoreDocsLink(href: string, anchorHint = ""): number {
  let score = 0;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return -1;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase().replace(/\/$/, "");
  const hint = anchorHint.toLowerCase();

  if (host.startsWith("docs.")) score += 40;
  if (/gitbook|mintlify|readme\.io|readthedocs|docusaurus/.test(host)) score += 35;
  if (path === "/docs" || path === "/documentation") score += 45;
  if (path.startsWith("/docs/") || path.startsWith("/documentation/")) score += 25;
  if (/\b(developer|developers|dev)\b/.test(path)) score += 15;
  if (looksLikeWhitepaperUrl(href)) score += 18;
  if (hint.includes("doc")) score += 12;
  if (hint.includes("whitepaper") || hint.includes("litepaper")) score += 10;
  if (hint.includes("developer")) score += 8;

  // Penalise depth, and anything that is obviously not reference material.
  score -= Math.max(0, path.split("/").filter(Boolean).length - 1) * 4;
  if (/\b(blog|careers|jobs|terms|privacy|press|brand|legal|dmca|status)\b/.test(path)) score -= 50;
  return score;
}

/** Anchor text for each href on a page, so link scoring can use the label. */
function anchorHints(html: string, baseUrl: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl);
      abs.hash = "";
      const label = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (label) out.set(abs.toString(), label);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export interface DocsDiscovery {
  rootUrl: string;
  discovery: string;
  firstPage: DocPage;
  /** Links seen on the entry page, reused by the caller to find GitHub/socials. */
  seenLinks: string[];
}

/**
 * Find the docs. `entryUrl` is the project's website (or the docs URL itself,
 * when `given` is true).
 */
export async function discoverDocs(
  entryUrl: string,
  budget: Budget,
  opts: { given?: boolean; externalCandidates?: string[] } = {}
): Promise<{ found: DocsDiscovery | null; siteLinks: string[]; note: string }> {
  const siteLinks: string[] = [];

  // Route 1: the user gave us the docs.
  if (opts.given) {
    const page = await readDocPage(entryUrl, budget);
    if (page) {
      return {
        found: { rootUrl: page.url, discovery: "given", firstPage: page, seenLinks: [] },
        siteLinks: [],
        note: "docs URL supplied by the user",
      };
    }
    // Fall through: a docs URL that would not load is still a website we can try.
  }

  // Fetch the entry page once and mine it for everything: docs links, repo,
  // socials. One fetch, three jobs.
  const entry = await fetchPage(entryUrl, budget);
  if (entry && !entry.binary && entry.body) {
    const hints = anchorHints(entry.body, entry.finalUrl);
    const links = [
      ...extractLinks(entry.body, entry.finalUrl),
      ...extractUrlsFromText(entry.body, entry.finalUrl),
    ];
    siteLinks.push(...links);

    const scored = links
      .map((href) => ({ href, score: scoreDocsLink(href, hints.get(href) ?? "") }))
      .filter((c) => c.score > 20)
      .sort((a, b) => b.score - a.score);

    for (const cand of scored.slice(0, 4)) {
      if (budgetSpent(budget)) break;
      const page = await readDocPage(cand.href, budget);
      if (page && looksLikeDocs(page.text, page.headings)) {
        return {
          found: { rootUrl: page.url, discovery: "link", firstPage: page, seenLinks: links },
          siteLinks,
          note: `docs found by link from ${entryUrl}`,
        };
      }
    }
  } else if (entry && entry.status === 403) {
    return { found: null, siteLinks, note: `${new URL(entryUrl).hostname} refused the request (HTTP 403 — WAF or geo block)` };
  }

  // Route 3: probe the conventional paths.
  let origin = "";
  let host = "";
  try {
    const u = new URL(entryUrl);
    origin = u.origin;
    host = u.hostname;
  } catch {
    /* ignore */
  }
  const probes: string[] = [];
  if (origin) probes.push(...PROBE_PATHS.map((p) => `${origin}${p}`));
  if (host) {
    const apex = apexOf(host);
    probes.push(`https://docs.${apex}`, `https://developer.${apex}`, `https://${apex}/docs`);
  }
  for (const probe of [...new Set(probes)]) {
    if (budgetSpent(budget)) break;
    const page = await readDocPage(probe, budget, { quick: true });
    if (page && looksLikeDocs(page.text, page.headings)) {
      return {
        found: { rootUrl: page.url, discovery: "probe", firstPage: page, seenLinks: siteLinks },
        siteLinks,
        note: `docs found by probing ${new URL(probe).pathname || "subdomain"}`,
      };
    }
  }

  // Route 4: links from CoinGecko / GitHub.
  for (const cand of (opts.externalCandidates ?? []).filter((c) => looksLikeDocsUrl(c) || looksLikeWhitepaperUrl(c))) {
    if (budgetSpent(budget)) break;
    const page = await readDocPage(cand, budget);
    if (page && looksLikeDocs(page.text, page.headings)) {
      return {
        found: { rootUrl: page.url, discovery: "external", firstPage: page, seenLinks: siteLinks },
        siteLinks,
        note: "docs found via a link published off-site (CoinGecko/GitHub)",
      };
    }
  }

  return { found: null, siteLinks, note: "no documentation found at the conventional locations" };
}

async function readDocPage(
  url: string,
  budget: Budget,
  opts: { quick?: boolean } = {}
): Promise<DocPage | null> {
  const res = await fetchPage(url, budget, { timeoutMs: opts.quick ? 8_000 : 15_000 });
  if (!res || res.status >= 400) return null;
  if (res.binary) {
    // A PDF whitepaper. We record that it exists — parsing PDFs is not something
    // this pipeline does, and pretending to read one would be worse than saying so.
    return { url: res.finalUrl, title: "(binary document)", headings: [], text: "", chars: 0 };
  }
  const { title, headings, text } = htmlToText(res.body);
  return { url: res.finalUrl, title, headings, text, chars: text.length };
}

/**
 * Expand from the docs root to the rest of the reference.
 *
 * Constrained to the same host, and to the root's path prefix when it has one,
 * so a docs crawl cannot wander into a blog. Many modern docs sites ship the
 * whole reference on one route, in which case the first page is the whole crawl
 * and `maxPages` is never reached — that is the good case, not a failure.
 */
export async function crawlDocs(
  start: DocsDiscovery,
  budget: Budget,
  opts: { maxPages?: number; maxChars?: number } = {}
): Promise<DocsFindings> {
  const maxPages = opts.maxPages ?? 10;
  const maxChars = opts.maxChars ?? 140_000;

  const pages: DocPage[] = [start.firstPage];
  let chars = start.firstPage.chars;

  const rootUrl = new URL(start.rootUrl);
  const prefix = rootUrl.pathname.replace(/\/$/, "");
  const visited = new Set([start.rootUrl]);

  // Re-fetch the root's HTML for its links. `readDocPage` kept the text, not the
  // markup; one extra fetch is cheaper than threading raw HTML through the
  // discovery result for the single case that needs it.
  const rootRaw = await fetchPage(start.rootUrl, budget);
  const queue: string[] = [];
  if (rootRaw && !rootRaw.binary && rootRaw.body) {
    const hints = anchorHints(rootRaw.body, rootRaw.finalUrl);
    const links = extractLinks(rootRaw.body, rootRaw.finalUrl);
    const inDocs = links.filter((href) => {
      try {
        const u = new URL(href);
        if (u.hostname !== rootUrl.hostname) return false;
        if (visited.has(href)) return false;
        if (prefix && prefix !== "" && !u.pathname.startsWith(prefix)) return false;
        if (/\.(png|jpe?g|svg|gif|webp|zip|css|js)$/i.test(u.pathname)) return false;
        return true;
      } catch {
        return false;
      }
    });
    // Reference-ish links first: the pages that carry mechanism detail.
    inDocs.sort((a, b) => scoreSubPage(b, hints.get(b) ?? "") - scoreSubPage(a, hints.get(a) ?? ""));
    queue.push(...inDocs);
  }

  for (const href of queue) {
    if (pages.length >= maxPages || chars >= maxChars || budgetSpent(budget)) break;
    if (visited.has(href)) continue;
    visited.add(href);
    const page = await readDocPage(href, budget, { quick: true });
    if (!page || page.chars < 400) continue;
    pages.push(page);
    chars += page.chars;
  }

  return {
    rootUrl: start.rootUrl,
    discovery: start.discovery,
    pages,
    contracts: extractContracts(pages),
  };
}

const SUBPAGE_PRIORITY = [
  "fee",
  "token",
  "reward",
  "emission",
  "supply",
  "mechanism",
  "architecture",
  "contract",
  "security",
  "risk",
  "governance",
  "audit",
  "stake",
  "overview",
  "how",
];

function scoreSubPage(href: string, label: string): number {
  const s = `${href} ${label}`.toLowerCase();
  let score = 0;
  SUBPAGE_PRIORITY.forEach((w, i) => {
    if (s.includes(w)) score += SUBPAGE_PRIORITY.length - i;
  });
  return score;
}

/**
 * Contract addresses the docs publish, with the label next to them.
 *
 * A docs page that lists its deployments is handing us the on-chain half of the
 * report: those are the addresses whose code we can then check the docs against.
 */
export function extractContracts(pages: DocPage[]): { label: string; address: string }[] {
  const out = new Map<string, string>();
  for (const p of pages) {
    const lines = p.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/0x[a-fA-F0-9]{40}/g);
      if (!m) continue;
      for (const addr of m) {
        if (out.has(addr.toLowerCase())) continue;
        // The label is whatever sits with the address: same line minus the
        // address, else the line above (docs lay these out as two-column tables).
        const inline = line.replace(addr, "").replace(/[|·—–:]/g, " ").replace(/\s+/g, " ").trim();
        const above = (lines[i - 1] ?? "").replace(/\s+/g, " ").trim();
        const label = inline.length >= 3 && inline.length <= 60 ? inline : above.slice(0, 60);
        out.set(addr.toLowerCase(), label || "(unlabelled)");
      }
    }
  }
  return [...out.entries()].map(([address, label]) => ({ address, label }));
}
