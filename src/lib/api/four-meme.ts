import { rateLimit } from "@/lib/rate-limiter";

// Four.meme (four.meme/en/create-token) lets you launch a BSC token against a
// chosen "counter" asset — BNB, stablecoins, and increasingly Binance tokenized
// stocks (bStocks, e.g. NVDAB). There's no public catalog API, but the create
// page server-renders the full list into its RSC payload as `commonConfig`, so
// we parse it from the HTML — the same data the launch form itself uses.
export const FOUR_MEME_BASE = "https://four.meme";
export const FOUR_MEME_CREATE_URL = `${FOUR_MEME_BASE}/en/create-token`;

export interface FourMemeQuoteToken {
  symbol: string;
  /** ERC-20 on BSC, lowercase */
  address: string;
  logoUrl: string | null;
  /** "PUBLISH" = selectable in the launch form, "INIT" = staged but not live */
  status: string;
  /** "BSC" today; kept so a future chain rollout is visible rather than silent */
  networkCode: string;
  /** Convenience: whether the asset is actually launchable right now. */
  live: boolean;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Extract a `key:[...]` array by matching brackets (the payload is not valid JSON on its own). */
function sliceArray(source: string, key: string): string | null {
  const start = source.indexOf(`"${key}":[`);
  if (start === -1) return null;
  const open = source.indexOf("[", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Fetch four.meme's counter-asset (quote token) catalog. Returns every asset the
 * launch form knows about, live or staged, so callers can spot both a brand-new
 * listing and an existing one flipping to PUBLISH.
 */
export async function fetchFourMemeQuoteTokens(): Promise<FourMemeQuoteToken[]> {
  await rateLimit("fourmeme");
  try {
    const res = await fetch(FOUR_MEME_CREATE_URL, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    // The config is embedded inside an RSC string literal, so quotes are escaped.
    const unescaped = html.replace(/\\"/g, '"');

    const arr = sliceArray(unescaped, "commonConfig");
    if (!arr) return [];

    const out: FourMemeQuoteToken[] = [];
    const seen = new Set<string>();
    // Each entry is a flat object; pull fields individually so field reordering
    // (or new fields) can't break parsing.
    for (const m of arr.matchAll(/\{"symbol":"(.*?)","nativeSymbol":.*?\}/g)) {
      const block = m[0];
      const field = (name: string): string => {
        const f = new RegExp(`"${name}":"(.*?)"`).exec(block);
        return f ? f[1] : "";
      };
      const address = field("symbolAddress").toLowerCase();
      if (!address || seen.has(address)) continue;
      seen.add(address);

      const status = field("status");
      out.push({
        symbol: m[1],
        address,
        logoUrl: field("logoUrl") || null,
        status,
        networkCode: field("networkCode") || "BSC",
        live: status.toUpperCase() === "PUBLISH",
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function fourMemeTokenUrl(address: string): string {
  return `${FOUR_MEME_BASE}/en/token/${address}`;
}
