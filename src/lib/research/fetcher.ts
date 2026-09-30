// ── Budgeted page fetching, and HTML → text ───────────────────────────────────
// Research runs against strangers' websites: some are static, some are SPAs,
// some are behind a WAF, some are slow. Three rules keep one bad host from
// taking a report down with it:
//
//   1. Everything runs inside a wall-clock BUDGET. When it is spent, remaining
//      work is skipped and the report says so, rather than the command hanging
//      until Telegram gives up on it.
//   2. Every fetch has its own timeout and never throws — callers get null and
//      record a source status.
//   3. Nothing retries more than once. A site that needs three attempts is a
//      site whose content we will report as unreachable, which is a fact worth
//      printing rather than a delay worth absorbing.

export interface Budget {
  /** Absolute deadline, ms since epoch. */
  deadline: number;
  /** Pages fetched so far, for the coverage block. */
  fetches: number;
  /** Hosts we have already been refused by, so we stop asking. */
  blocked: Set<string>;
}

export function newBudget(totalMs: number): Budget {
  return { deadline: Date.now() + totalMs, fetches: 0, blocked: new Set() };
}

export function budgetLeft(b: Budget): number {
  return Math.max(0, b.deadline - Date.now());
}

export function budgetSpent(b: Budget): boolean {
  return budgetLeft(b) <= 0;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

export interface FetchedPage {
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  /** True when the body is not HTML/text we can read (e.g. a PDF). */
  binary: boolean;
}

/**
 * GET a page inside the budget. Returns null on any failure, and remembers a
 * host that answered 403/429/451 so later stages stop trying it — a geo or WAF
 * block is a property of the host, not of the request.
 */
export async function fetchPage(
  url: string,
  budget: Budget,
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<FetchedPage | null> {
  if (budgetSpent(budget)) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (budget.blocked.has(host)) return null;

  const timeout = Math.min(opts.timeoutMs ?? 15_000, Math.max(2_000, budgetLeft(budget)));
  const maxBytes = opts.maxBytes ?? 1_500_000;

  try {
    budget.fetches++;
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });

    if (res.status === 403 || res.status === 429 || res.status === 451) {
      budget.blocked.add(host);
      return { url, finalUrl: res.url || url, status: res.status, contentType: "", body: "", binary: false };
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const binary =
      contentType.includes("pdf") ||
      contentType.startsWith("image/") ||
      contentType.startsWith("video/") ||
      contentType.includes("octet-stream");

    if (binary) {
      return { url, finalUrl: res.url || url, status: res.status, contentType, body: "", binary: true };
    }

    const text = await res.text();
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      contentType,
      body: text.length > maxBytes ? text.slice(0, maxBytes) : text,
      binary: false,
    };
  } catch {
    return null;
  }
}

/** POST JSON inside the budget, for JSON-RPC and JSON APIs. */
export async function postJson<T>(
  url: string,
  body: unknown,
  budget: Budget,
  timeoutMs = 12_000
): Promise<T | null> {
  if (budgetSpent(budget)) return null;
  try {
    budget.fetches++;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(timeoutMs, Math.max(2_000, budgetLeft(budget)))),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getJson<T>(
  url: string,
  budget: Budget,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<T | null> {
  if (budgetSpent(budget)) return null;
  try {
    budget.fetches++;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers ?? {}) },
      signal: AbortSignal.timeout(Math.min(opts.timeoutMs ?? 12_000, Math.max(2_000, budgetLeft(budget)))),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── HTML → text ───────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&middot;": "·",
  "&bull;": "•",
  "&times;": "×",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&ldquo;": '"',
  "&rdquo;": '"',
  "&Xi;": "Ξ",
  "&#916;": "Δ",
};

export function decodeEntities(s: string): string {
  let out = s;
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  // Numeric entities, decimal and hex.
  out = out.replace(/&#(\d+);/g, (_, d) => {
    const code = Number(d);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    const code = parseInt(h, 16);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
  return out;
}

export interface ExtractedHtml {
  title?: string;
  headings: string[];
  /** Plain text, one block per line, headings prefixed with "## ". */
  text: string;
}

/**
 * Strip an HTML page to readable text, keeping headings as structure markers.
 *
 * Headings are kept because the extraction stage attributes each sentence to the
 * section it sits under, and "Holder rewards" above a sentence about fees is
 * most of what tells you the sentence is about rewards rather than trading.
 */
export function htmlToText(html: string): ExtractedHtml {
  let s = html;
  // Drop anything that is not prose.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : undefined;

  const headings: string[] = [];
  // Mark headings so they survive tag stripping, and collect them in order.
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, _lvl, inner) => {
    const h = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    if (h && h.length <= 140) headings.push(h);
    return `\n\n## ${h}\n`;
  });

  // Block elements become line breaks so sentences do not weld together.
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|li|tr|td|th|ul|ol|table|blockquote|pre|header|footer|nav|main|span)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n• ");

  s = stripTags(s);
  s = decodeEntities(s);

  const lines = s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l.length > 0);

  // Collapse repeated nav lines. SPA pages print their whole table of contents
  // twice (once for desktop, once for mobile), which otherwise dominates the
  // extracted text.
  //
  // Scoped to the lines BEFORE the first heading, because a global dedup of
  // short lines silently eats content: a fee table's "Protocol" label is also a
  // nav entry, and dropping it leaves "6% of trading fees" with nothing to
  // attach to — a missing label reads as a missing fact.
  const deduped: string[] = [];
  const seen = new Set<string>();
  let inNav = true;
  for (const l of lines) {
    if (l.startsWith("## ")) inNav = false;
    const key = l.toLowerCase();
    if (inNav && l.length < 60) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    deduped.push(l);
  }

  return { title, headings, text: deduped.join("\n") };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

/** Absolute links on a page, de-duplicated, same-page anchors dropped. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = decodeEntities(m[1]).trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    try {
      const abs = new URL(href, baseUrl);
      abs.hash = "";
      out.add(abs.toString());
    } catch {
      /* unparseable href — ignore */
    }
  }
  return [...out];
}

/**
 * Links an SPA only puts in its JSON payload rather than in an <a href>.
 *
 * Next.js ships its route data inside the page, so a docs URL frequently appears
 * as a bare string in a script payload and nowhere else. The link crawler misses
 * those entirely, which is how a site with perfectly good docs reads as having
 * none.
 */
export function extractUrlsFromText(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    /* ignore */
  }
  const re = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[0].replace(/[\\"'),.]+$/, "");
    try {
      const u = new URL(raw);
      // Only keep links plausibly about this project: same host, a docs host, a
      // repo, or a social profile. Everything else on a page is noise.
      const h = u.hostname.toLowerCase();
      const keep =
        h === host ||
        h.endsWith("github.com") ||
        h.includes("gitbook") ||
        h.includes("docs.") ||
        h.endsWith("x.com") ||
        h.endsWith("twitter.com") ||
        h.endsWith("t.me") ||
        h.includes("discord");
      if (keep) out.add(u.toString());
    } catch {
      /* ignore */
    }
  }
  return [...out];
}
