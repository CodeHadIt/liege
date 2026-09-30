// ── Input classification ──────────────────────────────────────────────────────
// `/research` takes whatever the user has to hand: a contract address, a project
// website, a docs page, a GitHub org, a PDF whitepaper, a Mirror post, or just a
// name. Each of those is a different starting point into the same graph, so the
// first job is to say which one we were given.
//
// Classification is deliberately conservative. A URL we cannot categorise is a
// plain "website", which is the cheapest correct answer: the website stage
// discovers docs and GitHub links anyway, so mislabelling a docs page as a site
// costs one extra fetch, while mislabelling a site as docs would crawl the
// marketing pages as if they were a reference.

import type { ClassifiedInput } from "./types";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
// Base58, 32–44 chars. Same pattern the chain configs use for Solana mints.
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Hosts that are documentation platforms whatever the path says. */
const DOCS_HOSTS = [
  "gitbook.io",
  "gitbook.com",
  "readme.io",
  "mintlify.app",
  "mintlify.com",
  "docusaurus.io",
  "readthedocs.io",
  "notion.site",
  "hackmd.io",
];

/** Path or subdomain markers for documentation. */
const DOCS_MARKERS = [
  "docs",
  "documentation",
  "developer",
  "developers",
  "dev-docs",
  "guide",
  "guides",
  "learn",
  "wiki",
  "reference",
  "handbook",
];

/** Long-form writing platforms — an article, not a reference. */
const ARTICLE_HOSTS = [
  "medium.com",
  "mirror.xyz",
  "substack.com",
  "hackernoon.com",
  "blog.",
  "paragraph.xyz",
];

const WHITEPAPER_MARKERS = ["whitepaper", "white-paper", "litepaper", "lightpaper", "yellowpaper", "tokenomics"];

function firstLabel(host: string): string {
  return host.split(".")[0] ?? "";
}

/**
 * Work out what the user gave us.
 *
 * Accepts a bare host ("sender.family") as well as a full URL, because that is
 * how people paste projects into chat.
 */
export function classifyInput(raw: string): ClassifiedInput {
  const input = raw.trim().replace(/^<|>$/g, "");

  if (EVM_ADDRESS.test(input)) {
    return {
      kind: "evm-address",
      value: input.toLowerCase(),
      reason: "20-byte hex address — EVM contract or token",
    };
  }

  // Order matters: an EVM address also satisfies nothing else, but a Solana mint
  // and a bare word can look alike, so the base58 test runs before the
  // URL/keyword fallbacks and after the stricter hex test.
  if (SOLANA_ADDRESS.test(input) && !input.includes(".") && !input.includes("/")) {
    return {
      kind: "solana-address",
      value: input,
      reason: "base58, 32–44 chars — Solana mint or program",
    };
  }

  const looksLikeUrl =
    /^https?:\/\//i.test(input) ||
    // bare host with a TLD and no spaces: "sender.family", "docs.uniswap.org/x"
    (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(input) && !input.includes(" "));

  if (looksLikeUrl) {
    const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return { kind: "query", value: input, reason: "not parseable as a URL — treated as a search term" };
    }

    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const full = `${host}${path}`;

    if (host === "github.com" || host === "www.github.com" || host.endsWith(".github.io")) {
      return { kind: "url-github", value: url.toString(), host, reason: "GitHub — repository or organisation" };
    }

    if (path.endsWith(".pdf") || WHITEPAPER_MARKERS.some((m) => full.includes(m))) {
      return { kind: "url-whitepaper", value: url.toString(), host, reason: "whitepaper / tokenomics document" };
    }

    if (DOCS_HOSTS.some((h) => host.endsWith(h))) {
      return { kind: "url-docs", value: url.toString(), host, reason: `hosted on a documentation platform (${host})` };
    }

    const sub = firstLabel(host);
    const segments = path.split("/").filter(Boolean);
    if (DOCS_MARKERS.includes(sub) || segments.some((s) => DOCS_MARKERS.includes(s))) {
      return { kind: "url-docs", value: url.toString(), host, reason: "path or subdomain names a docs section" };
    }

    if (ARTICLE_HOSTS.some((h) => host.includes(h))) {
      return { kind: "url-article", value: url.toString(), host, reason: "long-form publishing platform — an article" };
    }

    return { kind: "url-website", value: url.toString(), host, reason: "project website — docs and repo will be discovered from it" };
  }

  return {
    kind: "query",
    value: input,
    reason: "no address or URL — treated as a name/ticker search",
  };
}

/** Does this look like a docs URL? Used when scoring discovered links. */
export function looksLikeDocsUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (DOCS_HOSTS.some((h) => host.endsWith(h))) return true;
  if (DOCS_MARKERS.includes(firstLabel(host))) return true;
  return path.split("/").filter(Boolean).some((s) => DOCS_MARKERS.includes(s));
}

export function looksLikeWhitepaperUrl(href: string): boolean {
  const lower = href.toLowerCase();
  return lower.endsWith(".pdf") || WHITEPAPER_MARKERS.some((m) => lower.includes(m));
}
