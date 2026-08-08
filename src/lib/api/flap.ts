import { rateLimit } from "@/lib/rate-limiter";

// Flap (flap.sh/launch) is a multi-chain launchpad where a token is created
// against a chosen "payment token". On BNB Chain that list now includes Binance
// tokenized stocks (bStocks — AAPLB, NVDAB, TSLAB…), plus a long roadmap of
// stocks marked "coming soon" on the launch page.
//
// Flap has no public catalog API: the launch page renders only the ACTIVE tab
// (CRYPTO), so the RWA tab — and every upcoming asset — never reaches the HTML.
// Both lists do ship in the app bundle as two parallel structures:
//   paymentTokens[]              — symbol → address / decimals / logo
//   launchPaymentTokenCatalog[]  — symbol → category ("crypto" | "rwa") and
//                                  status ("coming-soon" when not yet tradable)
// We resolve the (hashed) main-app chunk from the launch page on every poll, so
// a redeploy just changes the URL we follow rather than breaking the feed.
export const FLAP_BASE = "https://flap.sh";
export const FLAP_LAUNCH_URL = `${FLAP_BASE}/launch?chain=bnb&lang=en`;

/** Chain IDs Flap serves that we care about. */
export const FLAP_BSC_CHAIN_ID = 56;
export const FLAP_ROBINHOOD_CHAIN_ID = 4663;

// Flap's launch router ("portal") per chain — the contract a launch tx calls.
// This is the signal that attributes an on-chain launch to Flap; the Robinhood
// deployment is a bare TransparentUpgradeableProxy, so its verified name says
// nothing about Flap and only the address identifies it.
export const FLAP_PORTALS: Record<number, string> = {
  [FLAP_BSC_CHAIN_ID]: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
  [FLAP_ROBINHOOD_CHAIN_ID]: "0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09",
};

export interface FlapPaymentToken {
  symbol: string;
  name: string;
  /** ERC-20 address (lowercase); null for assets announced but not yet deployed */
  address: string | null;
  logoUrl: string | null;
  decimals: number;
  /** "rwa" = tokenized stock/commodity, "crypto" = native/stable/crypto asset */
  category: "rwa" | "crypto";
  /** Tradable now, or announced on the launch page as upcoming */
  status: "available" | "coming-soon";
  chainId: number;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Match brackets from `openIdx` and return the enclosed slice, including delimiters. */
function matchBracket(src: string, openIdx: number, open: string, close: string): string | null {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

/** Split a minified array literal into its top-level `{...}` object literals. */
function topLevelObjects(arr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (arr[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) out.push(arr.slice(start, i + 1));
    }
  }
  return out;
}

function str(block: string, key: string): string | null {
  const m = new RegExp(`\\b${key}:"(.*?)"`).exec(block);
  return m ? m[1] : null;
}

/** Resolve the current main-app bundle URL from the launch page. */
async function fetchMainAppChunk(): Promise<string | null> {
  await rateLimit("flap");
  const page = await fetch(FLAP_LAUNCH_URL, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!page.ok) return null;
  const html = await page.text();
  const m = /\/_next\/static\/chunks\/main-app-[a-zA-Z0-9]+\.js/.exec(html);
  if (!m) return null;

  await rateLimit("flap");
  const chunk = await fetch(`${FLAP_BASE}${m[0]}`, {
    headers: { "User-Agent": UA, Referer: FLAP_LAUNCH_URL },
    signal: AbortSignal.timeout(25_000),
  });
  if (!chunk.ok) return null;
  return chunk.text();
}

/**
 * Fetch Flap's payment-token catalog for every chain it configures, joining the
 * address/metadata list with the category+status catalog. Entries with no
 * matching `paymentTokens` record (announced but undeployed assets) are kept
 * with a null address — those are exactly the "coming soon" stocks.
 */
export async function fetchFlapPaymentTokens(): Promise<FlapPaymentToken[]> {
  try {
    const src = await fetchMainAppChunk();
    if (!src) return [];

    const out: FlapPaymentToken[] = [];

    // Each chain config holds `paymentTokens:[…]` followed by
    // `launchPaymentTokenCatalog:[…]`; anchor on the catalog and walk back for
    // its sibling token list and the chain ID it belongs to.
    for (const m of src.matchAll(/launchPaymentTokenCatalog:\[/g)) {
      const catalogArr = matchBracket(src, m.index + "launchPaymentTokenCatalog:".length, "[", "]");
      if (!catalogArr) continue;

      const before = src.slice(0, m.index);
      const ptIdx = before.lastIndexOf("paymentTokens:[");
      if (ptIdx === -1) continue;
      const tokensArr = matchBracket(src, ptIdx + "paymentTokens:".length, "[", "]");
      if (!tokensArr) continue;

      const chainIds = [...before.matchAll(/chainId:(\d+)/g)];
      const chainId = chainIds.length ? parseInt(chainIds[chainIds.length - 1][1], 10) : 0;

      // symbol → metadata from the address list
      const meta = new Map<string, { name: string; address: string | null; logoUrl: string | null; decimals: number }>();
      for (const block of topLevelObjects(tokensArr)) {
        const symbol = str(block, "symbol");
        if (!symbol) continue;
        const address = str(block, "address");
        const dm = /\bdecimals:(\d+)/.exec(block);
        meta.set(symbol, {
          name: str(block, "name") ?? symbol,
          address: address ? address.toLowerCase() : null,
          logoUrl: str(block, "logoUrl"),
          decimals: dm ? parseInt(dm[1], 10) : 18,
        });
      }

      for (const block of topLevelObjects(catalogArr)) {
        const symbol = str(block, "symbol");
        if (!symbol) continue;
        const category = str(block, "category") === "rwa" ? "rwa" : "crypto";
        const status = str(block, "status") === "coming-soon" ? "coming-soon" : "available";
        const info = meta.get(symbol);
        out.push({
          symbol,
          // Catalog-only entries carry their own name/logo; deployed ones inherit
          // from the address list.
          name: str(block, "name") ?? info?.name ?? symbol,
          address: info?.address ?? null,
          logoUrl: str(block, "logoUrl") ?? info?.logoUrl ?? null,
          decimals: info?.decimals ?? 18,
          category,
          status,
          chainId,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Absolute URL for a Flap-hosted logo path (`/payment-token-catalog/x.svg`). */
export function flapLogoUrl(logoUrl: string | null): string | null {
  if (!logoUrl) return null;
  if (logoUrl.startsWith("http")) return logoUrl;
  return `${FLAP_BASE}${logoUrl}`;
}

export function flapLaunchUrl(chain: "bnb" | "robinhood" = "bnb"): string {
  return `${FLAP_BASE}/launch?chain=${chain}&lang=en`;
}
