import { rateLimit } from "@/lib/rate-limiter";

// Sunrise is a Solana platform for trading tokenized stocks (and other assets)
// against USDC. The tradable list is server-rendered into /tokens as an escaped
// JSON payload — there's no separate list API — so we parse it from the HTML.
export const SUNRISE_BASE = "https://sunrise.xyz";
export const SUNRISE_TOKENS_URL = `${SUNRISE_BASE}/tokens`;

export interface SunriseToken {
  symbol: string;
  name: string;
  address: string;
  icon: string | null;
  /** ISO date the asset went live on Sunrise */
  launchDate: string | null;
  /** "stock" | "crypto" | "commodity" | "stablecoin" | … */
  assetClass: string;
  decimals: number;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * Fetch the full list of assets listed on Sunrise by parsing the /tokens page's
 * embedded RSC JSON. Resilient to field reordering: for each token block we pull
 * fields individually rather than relying on a fixed order.
 */
export async function fetchSunriseTokens(): Promise<SunriseToken[]> {
  await rateLimit("sunrise");
  try {
    const res = await fetch(SUNRISE_TOKENS_URL, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const u = html.replace(/\\"/g, '"'); // unescape the RSC-embedded JSON

    const out: SunriseToken[] = [];
    const seen = new Set<string>();
    const parts = u.split('"tokenSymbol":"');
    for (let i = 1; i < parts.length; i++) {
      const rest = parts[i];
      const symbol = rest.slice(0, rest.indexOf('"'));
      const w = rest.slice(0, 1400); // this token's field window
      const field = (name: string): string => {
        const m = new RegExp(`"${name}":"(.*?)"`).exec(w);
        return m ? m[1] : "";
      };
      const address = field("tokenAddress");
      if (!address || seen.has(address)) continue;
      seen.add(address);

      const dm = /"tokenDecimals":(\d+)/.exec(w);
      out.push({
        symbol,
        name: field("tokenName"),
        address,
        icon: field("tokenIcon") || null,
        launchDate: field("sunriseLaunchDate") || null,
        assetClass: field("assetClass") || "unknown",
        decimals: dm ? parseInt(dm[1], 10) : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function orbMarketsTokenUrl(mint: string): string {
  return `https://orbmarkets.io/token/${mint}`;
}

export function sunriseTokenUrl(mint: string): string {
  return `${SUNRISE_BASE}/tokens/${mint}`;
}
