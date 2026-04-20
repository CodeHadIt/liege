export const MSG_LIMIT = 3800; // Telegram max is 4096; leave headroom

/**
 * Pack pre-built entry strings into pages that each fit within MSG_LIMIT.
 * headerFn(page, total) returns the header string prepended to each page.
 */
export function splitPages(
  entries: string[],
  headerFn: (page: number, total: number) => string
): string[] {
  const HEADER_RESERVE = 150;
  const rawPages: string[] = [];
  let current = "";

  for (const entry of entries) {
    if (current.length + entry.length > MSG_LIMIT - HEADER_RESERVE) {
      if (current.length > 0) rawPages.push(current);
      current = entry;
    } else {
      current += entry;
    }
  }
  if (current.length > 0) rawPages.push(current);

  const total = rawPages.length;
  return rawPages.map((body, i) => headerFn(i + 1, total) + body);
}

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return "N/A";
  if (price === 0) return "$0";
  if (price < 0.0001) {
    // work out how many leading zeros after the decimal point
    const exp = -Math.floor(Math.log10(price));
    const zeros = exp - 1;
    const sig = price.toFixed(exp + 3).replace(/^0\.0+/, "").slice(0, 4);
    if (zeros > 1) {
      return `$0.0(${zeros})${sig}`;
    }
    return `$${price.toFixed(8)}`;
  }
  if (price < 1) return `$${price.toFixed(6)}`;
  if (price < 1000) return `$${price.toFixed(4)}`;
  return `$${formatCompact(price)}`;
}

export function formatCompact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

export function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "";
  const abs = Math.abs(pnl);
  if (abs >= 1000) return `${sign}$${formatCompact(pnl)}`;
  return `${sign}$${pnl.toFixed(2)}`;
}

export function truncateAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function chainEmoji(chain: string): string {
  switch (chain) {
    case "solana": return "◎";
    case "base":   return "🔵";
    case "bsc":    return "🟡";
    case "eth":    return "🔷";
    default: return "⛓";
  }
}

export function chainLabel(chain: string): string {
  switch (chain) {
    case "solana": return "Solana";
    case "base":   return "Base";
    case "bsc":    return "BSC";
    case "eth":    return "Ethereum";
    default: return chain;
  }
}

export function formatPercent(n: number | null | undefined): string {
  if (n === null || n === undefined) return "N/A";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function formatAge(createdAt: number | null | undefined): string {
  if (!createdAt) return "N/A";
  const now = Date.now();
  const ts = createdAt > 1e12 ? createdAt : createdAt * 1000;
  const diffMs = now - ts;
  if (diffMs < 0) return "just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.floor(diffHr / 24)}d`;
}

/** Human-readable "X ago" string for ATH timestamps — more granular than formatAge */
export function formatTimeAgo(timestamp: number | null | undefined): string {
  if (!timestamp) return "N/A";
  const now = Date.now();
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const diffMs = now - ts;
  if (diffMs < 0) return "just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}
