// ── Rendering a report into Telegram messages ─────────────────────────────────
// Two deliverables, in this order, because they answer different questions:
//
//   1. The TLDR — one message. What this is, the handful of features that make it
//      worth a second look, the numbers, and anything alarming. A reader who
//      stops here should still have been told the truth.
//   2. The detailed report — as many messages as the sections need. Same facts,
//      with the quotes, the addresses and the sources.
//
// Every quoted sentence keeps a link to the page it came from, so the report is
// checkable line by line rather than in aggregate.

import { escapeHtml, formatCompact } from "@/lib/telegram/utils/format";
import { TOPICS, topEvidence, type Topic } from "./extract";
import { verdictSummary } from "./verify";
import type { Evidence, ResearchReport, RiskFlag } from "./types";

const LIMIT = 3_600; // Telegram's cap is 4096; headroom for the page header.

const SEVERITY_ICON: Record<RiskFlag["severity"], string> = {
  high: "🔴",
  medium: "🟠",
  info: "⚪️",
};

const STATE_ICON = { ok: "✅", empty: "➖", failed: "⚠️", skipped: "⏭" } as const;

function link(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** A quoted sentence with a superscript source link. */
function quote(e: Evidence, sourceIndex?: number): string {
  const src = sourceIndex !== undefined ? ` ${link(e.url, `[${sourceIndex}]`)}` : "";
  const where = e.heading ? `<i>${escapeHtml(e.heading)}</i> — ` : "";
  return `• ${where}${escapeHtml(e.text)}${src}`;
}

function usd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1) return `$${n.toPrecision(3)}`;
  return `$${formatCompact(n)}`;
}

function ageOf(ts: number | undefined): string {
  if (!ts) return "—";
  const days = (Date.now() - ts) / 86_400_000;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 60) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}

function shortAddr(a: string): string {
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

// ── TLDR ──────────────────────────────────────────────────────────────────────

export function renderTldr(r: ResearchReport): string {
  const L: string[] = [];
  const title = r.subject.symbol ? `${r.subject.name} ($${r.subject.symbol})` : r.subject.name;

  L.push(`🔬 <b>RESEARCH — ${escapeHtml(title)}</b>`);

  const chainBits = [
    r.onchain ? chainName(r.onchain.chain) : undefined,
    r.subject.categories[0],
    r.onchain?.contractName ? `<code>${escapeHtml(r.onchain.contractName)}</code>` : undefined,
  ].filter(Boolean);
  if (chainBits.length) L.push(chainBits.join(" · "));

  if (r.subject.oneLiner) {
    L.push("");
    L.push(`<b>TL;DR</b> — ${escapeHtml(r.subject.oneLiner)}`);
  }

  if (r.highlights.length) {
    L.push("");
    L.push("<b>What stands out</b>");
    for (const h of r.highlights.slice(0, 5)) {
      L.push(`▸ <b>${escapeHtml(h.label)}</b> — ${escapeHtml(trim(h.detail, 220))}`);
    }
  }

  const numbers: string[] = [];
  for (const m of r.docMetrics.slice(0, 6)) numbers.push(`${escapeHtml(m.label)}: <b>${escapeHtml(m.value)}</b>`);
  if (r.market) {
    if (r.market.priceUsd !== undefined) numbers.push(`Price: <b>${usd(r.market.priceUsd)}</b>`);
    if (r.market.fdv !== undefined) numbers.push(`FDV: <b>${usd(r.market.fdv)}</b>`);
    if (r.market.liquidityUsd !== undefined) numbers.push(`Liquidity: <b>${usd(r.market.liquidityUsd)}</b>`);
    if (r.market.volume24h !== undefined) numbers.push(`24h vol: <b>${usd(r.market.volume24h)}</b>`);
  }
  if (numbers.length) {
    L.push("");
    L.push("<b>Numbers</b>");
    L.push(numbers.join(" · "));
  }

  const verdict = verdictSummary(r.verifications);
  if (verdict) {
    L.push("");
    L.push(`<b>Docs vs deployed code</b> — ${escapeHtml(verdict)}`);
    const mismatch = r.verifications.find((v) => v.verdict === "mismatch");
    if (mismatch) L.push(`🔴 ${escapeHtml(trim(mismatch.claim, 120))} → ${escapeHtml(mismatch.observed)}`);
  }

  const topRisks = r.risks.filter((f) => f.severity !== "info").slice(0, 4);
  if (topRisks.length) {
    L.push("");
    L.push("<b>Flags</b>");
    for (const f of topRisks) L.push(`${SEVERITY_ICON[f.severity]} <b>${escapeHtml(f.label)}</b> — ${escapeHtml(trim(f.detail, 160))}`);
  }

  const links: string[] = [];
  if (r.subject.website) links.push(link(r.subject.website, "site"));
  if (r.subject.docsUrl) links.push(link(r.subject.docsUrl, "docs"));
  if (r.subject.githubUrl) links.push(link(r.subject.githubUrl, "github"));
  if (r.social.twitter) links.push(link(r.social.twitter, "X"));
  if (r.market?.url) links.push(link(r.market.url, "chart"));
  if (links.length) {
    L.push("");
    L.push(links.join(" · "));
  }

  L.push("");
  L.push(`<i>Full report follows. ${r.coverage.filter((c) => c.state === "ok").length}/${r.coverage.length} sources answered in ${(r.elapsedMs / 1000).toFixed(1)}s.</i>`);

  return L.join("\n");
}

// ── detailed report ───────────────────────────────────────────────────────────

interface Section {
  title: string;
  lines: string[];
}

export function renderDetail(r: ResearchReport): string[] {
  const sections: Section[] = [];

  // 1. Identity and provenance — how we got here, so nothing downstream is magic.
  {
    const lines: string[] = [];
    lines.push(`Input: <code>${escapeHtml(r.input.value)}</code>`);
    lines.push(`Read as: ${escapeHtml(r.input.reason)}`);
    if (r.subject.symbol) lines.push(`Ticker: <b>$${escapeHtml(r.subject.symbol)}</b>`);
    if (r.subject.categories.length) lines.push(`Categories: ${escapeHtml(r.subject.categories.join(", "))}`);
    if (r.onchain) {
      lines.push(`Chain: ${chainName(r.onchain.chain)}`);
      lines.push(`Address: <code>${escapeHtml(r.onchain.address)}</code>`);
      if (r.onchain.contractName) lines.push(`Verified source: <code>${escapeHtml(r.onchain.contractName)}</code>${r.onchain.verified ? " ✅" : ""}`);
      if (r.onchain.proxyType) lines.push(`Proxy: ${escapeHtml(r.onchain.proxyType)} → <code>${escapeHtml(r.onchain.implementation ?? "?")}</code>`);
      if (r.onchain.creator) lines.push(`Deployed by: <code>${escapeHtml(shortAddr(r.onchain.creator))}</code>`);
      if (r.onchain.holderCount) lines.push(`Holders: ${r.onchain.holderCount.toLocaleString("en-US")}`);
    }
    if (r.docs) lines.push(`Docs: ${link(r.docs.rootUrl, r.docs.rootUrl)} (found by ${escapeHtml(r.docs.discovery)})`);
    if (r.subject.whitepaperUrl) lines.push(`Whitepaper: ${link(r.subject.whitepaperUrl, "linked")}`);
    sections.push({ title: "Identity", lines });
  }

  // 2–10: the framework buckets, each quoting the docs.
  const buckets: { title: string; topic: Topic; limit: number; blurb?: string }[] = [
    { title: "How it works", topic: TOPICS.MECHANISM, limit: 5 },
    { title: "Fees and value capture", topic: TOPICS.FEES, limit: 5, blurb: "Who pays, and who is paid." },
    { title: "Supply and tokenomics", topic: TOPICS.TOKENOMICS, limit: 5 },
    { title: "Rewards and emissions", topic: TOPICS.REWARDS, limit: 5, blurb: "The documented reason to hold." },
    { title: "Burn and buybacks", topic: TOPICS.BURN, limit: 3 },
    { title: "Admin powers and governance", topic: TOPICS.GOVERNANCE, limit: 5, blurb: "What someone else can change." },
    { title: "What cannot change", topic: TOPICS.GUARANTEE, limit: 5, blurb: "The checkable claims." },
    { title: "Custody and locks", topic: TOPICS.CUSTODY, limit: 4 },
    { title: "Security and testing", topic: TOPICS.SECURITY, limit: 4 },
    { title: "External dependencies", topic: TOPICS.DEPENDENCIES, limit: 3 },
    { title: "Integration surface", topic: TOPICS.INTEGRATION, limit: 3 },
  ];
  for (const b of buckets) {
    const ev = topEvidence(r.evidence, b.topic, b.limit);
    if (!ev.length) continue;
    const lines: string[] = [];
    if (b.blurb) lines.push(`<i>${escapeHtml(b.blurb)}</i>`);
    for (const e of ev) lines.push(quote(e));
    sections.push({ title: b.title, lines });
  }

  // Headline numbers, with the line each was read from.
  if (r.docMetrics.length) {
    const lines = r.docMetrics.map(
      (m) => `• <b>${escapeHtml(m.label)}</b>: ${escapeHtml(m.value)}${m.context ? `\n   <i>${escapeHtml(trim(m.context, 150))}</i>` : ""}`
    );
    sections.push({ title: "Numbers, as the docs state them", lines });
  }

  // Docs vs chain — the differentiator.
  if (r.verifications.length) {
    const lines: string[] = [];
    lines.push("<i>Each claim below was read from the docs and then checked against the deployed contract.</i>");
    // Grouped by claim: one sentence can carry several checkable assertions
    // ("supply is fixed, with no mint, no owner and no pause" is three), and
    // repeating it once per check reads as the report stuttering.
    const grouped = new Map<string, typeof r.verifications>();
    for (const v of r.verifications) {
      const key = v.claim;
      grouped.set(key, [...(grouped.get(key) ?? []), v]);
    }
    for (const [claim, checks] of grouped) {
      const worst = checks.some((c) => c.verdict === "mismatch")
        ? "🔴"
        : checks.every((c) => c.verdict === "match")
          ? "✅"
          : "❔";
      lines.push(`${worst} <b>Claim:</b> ${escapeHtml(trim(claim, 200))}`);
      for (const c of checks) {
        lines.push(`     <b>Chain:</b> ${escapeHtml(c.observed)}`);
        if (c.note) lines.push(`     <i>${escapeHtml(c.note)}</i>`);
      }
    }
    sections.push({ title: "Docs vs deployed code", lines });
  }

  // Market.
  if (r.markets.length) {
    const lines: string[] = [];
    for (const m of [...r.markets].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, 6)) {
      const bits = [
        m.pairLabel ? `<b>${escapeHtml(m.pairLabel)}</b>` : undefined,
        `${escapeHtml(m.chain)}/${escapeHtml(m.dexId ?? "?")}`,
        m.priceUsd !== undefined ? usd(m.priceUsd) : undefined,
        m.liquidityUsd !== undefined ? `liq ${usd(m.liquidityUsd)}` : undefined,
        m.volume24h !== undefined ? `24h ${usd(m.volume24h)}` : undefined,
        m.txns24h !== undefined ? `${m.txns24h} txns` : undefined,
        m.pairCreatedAt ? `age ${ageOf(m.pairCreatedAt)}` : undefined,
      ].filter(Boolean);
      lines.push(`• ${bits.join(" · ")}`);
    }
    if (r.market?.fdv !== undefined) lines.push(`FDV ${usd(r.market.fdv)}${r.market.marketCap !== undefined ? ` · MC ${usd(r.market.marketCap)}` : ""}`);
    sections.push({ title: "Market", lines });
  }

  // On-chain facts.
  if (r.onchain) {
    const o = r.onchain;
    const lines: string[] = [];
    if (o.totalSupply !== undefined) {
      const human = o.decimals !== undefined ? (o.totalSupply / BigInt(10) ** BigInt(o.decimals)).toLocaleString("en-US") : o.totalSupply.toString();
      lines.push(`• totalSupply(): ${escapeHtml(human)}${o.decimals !== undefined ? ` (${o.decimals} dp)` : ""}`);
    }
    lines.push(`• owner(): ${o.ownerAddress ? `<code>${escapeHtml(o.ownerAddress)}</code>` : "no owner slot exposed"}`);
    if (o.chain !== "solana") {
      lines.push(`• mint selector in bytecode: ${o.hasMintSelector === undefined ? "unknown" : o.hasMintSelector ? "🔴 present" : "✅ absent"}`);
      lines.push(`• pause selector in bytecode: ${o.hasPauseSelector === undefined ? "unknown" : o.hasPauseSelector ? "🟠 present" : "✅ absent"}`);
    }
    for (const n of o.notes) lines.push(`• ${escapeHtml(n)}`);
    sections.push({ title: "On-chain facts", lines });
  }

  // Published contract set — the map of the protocol.
  if (r.docs?.contracts.length) {
    const lines = r.docs.contracts
      .slice(0, 16)
      .map((c) => `• ${escapeHtml(c.label)}: <code>${escapeHtml(c.address)}</code>`);
    sections.push({ title: "Contracts the docs publish", lines });
  }

  // Repo.
  if (r.github) {
    const g = r.github;
    const lines: string[] = [];
    lines.push(`${link(g.url, `${g.owner}/${g.repo ?? "?"}`)}${g.description ? ` — ${escapeHtml(trim(g.description, 140))}` : ""}`);
    lines.push(
      [
        g.stars !== undefined ? `${g.stars}★` : undefined,
        g.forks !== undefined ? `${g.forks} forks` : undefined,
        g.openIssues !== undefined ? `${g.openIssues} open issues` : undefined,
        g.language,
        g.license,
        g.pushedAt ? `last push ${g.pushedAt.slice(0, 10)}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    );
    lines.push(`docs/ ${g.hasDocsDir ? "✅" : "➖"} · audits/ ${g.hasAuditsDir ? "✅" : "➖"} · tests/ ${g.hasTestsDir ? "✅" : "➖"}`);
    if (g.siblingRepos?.length) {
      lines.push(`Other repos: ${g.siblingRepos.map((s) => escapeHtml(s.name)).join(", ")}`);
    }
    sections.push({ title: "Repository", lines });
  }

  // Social — what we have, and honestly what we do not.
  {
    const lines: string[] = [];
    if (r.social.twitter) {
      lines.push(`X: ${link(r.social.twitter, r.social.twitter.replace(/^https?:\/\//, ""))}${r.social.twitterFollowers ? ` — ${r.social.twitterFollowers.toLocaleString("en-US")} followers` : ""}`);
    }
    if (r.social.telegram) lines.push(`Telegram: ${link(r.social.telegram, "channel")}`);
    if (r.social.discord) lines.push(`Discord: ${link(r.social.discord, "server")}`);
    if (r.social.caSearchUrl) {
      lines.push(`Mentions of the address on X: ${link(r.social.caSearchUrl, "open live search")}`);
      lines.push("<i>Not read here — the timeline needs an X API key this bot does not hold, so the search is linked rather than summarised.</i>");
    }
    if (lines.length) sections.push({ title: "Social", lines });
  }

  // Risk register.
  if (r.risks.length) {
    const lines = r.risks.map((f) => `${SEVERITY_ICON[f.severity]} <b>${escapeHtml(f.label)}</b> — ${escapeHtml(trim(f.detail, 300))}`);
    sections.push({ title: "Risk register", lines });
  }

  // Open questions.
  if (r.openQuestions.length) {
    const lines = r.openQuestions.map((q) => `• ${escapeHtml(q)}`);
    sections.push({ title: "What this report could not answer", lines });
  }

  // Coverage — which source answered, and which did not.
  {
    const lines = r.coverage.map((c) => `${STATE_ICON[c.state]} <b>${escapeHtml(c.id)}</b> — ${escapeHtml(c.detail)}`);
    lines.push("");
    lines.push(`<i>Generated ${new Date(r.generatedAt).toISOString().replace("T", " ").slice(0, 19)}Z in ${(r.elapsedMs / 1000).toFixed(1)}s. Quotes are the project's own words; on-chain values were read at generation time.</i>`);
    sections.push({ title: "Sources and coverage", lines });
  }

  // Numbered here rather than in each title: buckets drop out when the docs say
  // nothing about them, and hardcoded numbers then leave gaps that read like
  // missing sections rather than absent topics.
  const numbered = sections.map((s, i) => ({ ...s, title: `${i + 1} · ${s.title}` }));
  return paginate(numbered, r.subject.name);
}

/**
 * Pack sections into messages.
 *
 * A section is never split across messages unless it cannot fit in one, because a
 * risk register that breaks mid-flag reads as two unrelated lists.
 */
function paginate(sections: Section[], subjectName: string): string[] {
  const pages: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) pages.push(current.trimEnd());
    current = "";
  };

  for (const s of sections) {
    const header = `<b>${escapeHtml(s.title)}</b>\n`;
    const block = header + s.lines.join("\n") + "\n\n";

    if (block.length > LIMIT) {
      // Oversized section: emit its header, then fill pages line by line.
      flush();
      let buf = header;
      for (const line of s.lines) {
        if (buf.length + line.length + 1 > LIMIT) {
          pages.push(buf.trimEnd());
          buf = `<b>${escapeHtml(s.title)} (cont.)</b>\n`;
        }
        buf += line + "\n";
      }
      current = buf + "\n";
      continue;
    }

    if (current.length + block.length > LIMIT) flush();
    current += block;
  }
  flush();

  const total = pages.length;
  return pages.map((p, i) => `<i>${escapeHtml(subjectName)} — research ${i + 1}/${total}</i>\n\n${p}`);
}

function trim(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= n ? clean : `${clean.slice(0, n - 1)}…`;
}

function chainName(c: string): string {
  switch (c) {
    case "eth": return "🔷 Ethereum";
    case "base": return "🔵 Base";
    case "bsc": return "🟡 BNB Chain";
    case "solana": return "🟣 Solana";
    case "rh": return "🟢 Robinhood Chain";
    case "ton": return "💎 TON";
    default: return c;
  }
}

/** TLDR first, then the detail pages — the order they should be sent in. */
export function renderReport(r: ResearchReport): string[] {
  return [renderTldr(r), ...renderDetail(r)];
}
