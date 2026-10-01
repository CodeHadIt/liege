// ── GitHub: is anybody home, and is the code where the docs say it is ─────────
// Two things a research report needs from a repo, and neither is the code:
//
//   1. Liveness. `pushed_at` and the open-issue count separate a protocol being
//      maintained from a snapshot someone abandoned. This is the cheapest real
//      signal in the whole run.
//   2. Whether the repo carries its own docs, audits and tests. A `docs/` tree
//      is another docs source; an `audits/` tree is the only honest way to check
//      an "audited" claim without taking marketing's word for it.
//
// Unauthenticated: 60 requests/hour per IP, which is plenty for one report.
// `GITHUB_TOKEN` is used when present, purely for the higher limit.

import { fetchPage, getJson, markdownToText, type Budget } from "../fetcher";
import type { DocPage, GithubFindings } from "../types";

const API = "https://api.github.com";

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

interface Repo {
  name: string;
  full_name: string;
  html_url: string;
  description?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  language?: string | null;
  license?: { spdx_id?: string | null } | null;
  pushed_at?: string;
  created_at?: string;
  default_branch?: string;
  archived?: boolean;
}

interface ContentEntry {
  name: string;
  type: string;
  path: string;
  download_url?: string | null;
}

/** Parse "github.com/owner", "github.com/owner/repo", "owner.github.io". */
export function parseGithubUrl(url: string): { owner: string; repo?: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.endsWith(".github.io")) {
      const owner = host.replace(/\.github\.io$/, "");
      const seg = u.pathname.split("/").filter(Boolean);
      return { owner, repo: seg[0] };
    }
    if (!host.endsWith("github.com")) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length === 0) return null;
    // Skip GitHub's own routes.
    if (["orgs", "topics", "collections", "sponsors", "features", "about"].includes(seg[0])) return null;
    return { owner: seg[0], repo: seg[1]?.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

export async function inspectGithub(url: string, budget: Budget): Promise<GithubFindings | null> {
  const parsed = parseGithubUrl(url);
  if (!parsed) return null;
  const { owner } = parsed;
  let repoName = parsed.repo;

  // An org/user URL: take its most recently pushed repo as the primary, and keep
  // the rest as siblings. Protocols routinely split contracts, frontend and docs
  // across repos, so the busiest one is the best single answer to "the code".
  let siblings: GithubFindings["siblingRepos"];
  if (!repoName) {
    const list =
      (await getJson<Repo[]>(`${API}/orgs/${owner}/repos?sort=pushed&per_page=20`, budget, { headers: headers() })) ??
      (await getJson<Repo[]>(`${API}/users/${owner}/repos?sort=pushed&per_page=20`, budget, { headers: headers() }));
    if (!list || list.length === 0) {
      return { owner, url, siblingRepos: [] };
    }
    const live = list.filter((r) => !r.archived);
    const pick = (live.length ? live : list)[0];
    repoName = pick.name;
    siblings = (live.length ? live : list)
      .slice(0, 8)
      .map((r) => ({ name: r.name, stars: r.stargazers_count ?? 0, pushedAt: r.pushed_at }));
  }

  const repo = await getJson<Repo>(`${API}/repos/${owner}/${repoName}`, budget, { headers: headers() });
  if (!repo) return { owner, repo: repoName, url, siblingRepos: siblings ?? [] };

  // Root listing: cheap, and answers docs/audits/tests in one call.
  const root = await getJson<ContentEntry[]>(`${API}/repos/${owner}/${repoName}/contents`, budget, {
    headers: headers(),
  });
  const dirs = new Set((root ?? []).filter((e) => e.type === "dir").map((e) => e.name.toLowerCase()));
  const files = new Set((root ?? []).filter((e) => e.type === "file").map((e) => e.name.toLowerCase()));

  let readmeExcerpt: string | undefined;
  const readme = await getJson<{ content?: string; encoding?: string }>(
    `${API}/repos/${owner}/${repoName}/readme`,
    budget,
    { headers: headers() }
  );
  if (readme?.content && readme.encoding === "base64") {
    try {
      const decoded = Buffer.from(readme.content, "base64").toString("utf8");
      readmeExcerpt = decoded.slice(0, 6_000);
    } catch {
      /* unreadable README — not worth a note */
    }
  }

  return {
    owner,
    repo: repoName,
    url: repo.html_url ?? url,
    description: repo.description ?? undefined,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    language: repo.language ?? undefined,
    license: repo.license?.spdx_id ?? undefined,
    pushedAt: repo.pushed_at,
    createdAt: repo.created_at,
    siblingRepos: siblings ?? [],
    readmeExcerpt,
    hasDocsDir: dirs.has("docs") || dirs.has("documentation") || files.has("docs.md"),
    hasAuditsDir: dirs.has("audits") || dirs.has("audit") || dirs.has("security"),
    hasTestsDir: dirs.has("test") || dirs.has("tests") || dirs.has("spec"),
    // A repository root is a place people commit things by accident. This is not a
    // secret scan — it reads filenames only — but a file called `.admin_credentials`
    // in a public repo is worth a line in a report whatever it turns out to hold.
    suspiciousFiles: [...files].filter((f) =>
      /^(\.env(\..*)?|.*credential.*|.*secret.*|id_rsa|.*\.pem|.*\.key|.*keystore.*|\.npmrc|\.pypirc)$/i.test(f)
    ),
  };
}


/**
 * The repository AS documentation.
 *
 * For a code-first project there is no website and no docs site — the README and
 * a `docs/` tree are the whole specification. The first version of this pipeline
 * skipped the docs stage entirely when no homepage existed, which meant a project
 * that documents itself properly in its repo scored as having no documentation at
 * all. That is backwards.
 *
 * Returns pages in the same shape the HTML crawl produces, so extraction,
 * verification and rendering do not care which source a sentence came from.
 */
export async function fetchRepoDocs(
  owner: string,
  repo: string,
  budget: Budget,
  opts: { maxFiles?: number } = {}
): Promise<DocPage[]> {
  const maxFiles = opts.maxFiles ?? 8;
  const pages: DocPage[] = [];

  const readme = await getJson<{ content?: string; encoding?: string; html_url?: string }>(
    `${API}/repos/${owner}/${repo}/readme`,
    budget,
    { headers: headers() }
  );
  if (readme?.content && readme.encoding === "base64") {
    const md = safeDecode(readme.content);
    if (md) pages.push(toPage(readme.html_url ?? `https://github.com/${owner}/${repo}`, md));
  }

  // Root-level Markdown that is documentation by name, then the docs tree.
  const root = await getJson<ContentEntry[]>(`${API}/repos/${owner}/${repo}/contents`, budget, {
    headers: headers(),
  });
  const ROOT_DOCS = /^(whitepaper|litepaper|tokenomics|architecture|spec|specification|design|protocol|overview|contributing|security|audit)\b.*\.mdx?$/i;
  const candidates: { path: string; url?: string }[] = [];
  for (const e of root ?? []) {
    if (e.type === "file" && ROOT_DOCS.test(e.name)) candidates.push({ path: e.path, url: e.download_url ?? undefined });
  }

  const docsDir = (root ?? []).find((e) => e.type === "dir" && /^(docs|documentation)$/i.test(e.name));
  if (docsDir) {
    const listing = await getJson<ContentEntry[]>(
      `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(docsDir.path)}`,
      budget,
      { headers: headers() }
    );
    for (const e of listing ?? []) {
      if (e.type === "file" && /\.mdx?$/i.test(e.name)) candidates.push({ path: e.path, url: e.download_url ?? undefined });
    }
  }

  // Biggest-signal first: a file named for a topic beats an index page.
  candidates.sort((a, b) => topicRank(b.path) - topicRank(a.path));

  for (const c of candidates.slice(0, maxFiles)) {
    if (!c.url) continue;
    const res = await fetchPage(c.url, budget, { timeoutMs: 10_000, maxBytes: 400_000 });
    if (!res || res.binary || !res.body) continue;
    const page = toPage(`https://github.com/${owner}/${repo}/blob/HEAD/${c.path}`, res.body);
    if (page.chars >= 300) pages.push(page);
  }

  return pages;
}

const DOC_TOPIC_ORDER = ["tokenomic", "whitepaper", "protocol", "architecture", "spec", "design", "overview", "security", "audit"];

function topicRank(path: string): number {
  const p = path.toLowerCase();
  const i = DOC_TOPIC_ORDER.findIndex((w) => p.includes(w));
  return i === -1 ? 0 : DOC_TOPIC_ORDER.length - i;
}

function toPage(url: string, markdown: string): DocPage {
  const { title, headings, text } = markdownToText(markdown);
  return { url, title, headings, text, chars: text.length };
}

function safeDecode(b64: string): string | null {
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}
