# Dex Orders: Data Flow Deep Dive

## Overview

The dex-orders feature checks pump.fun tokens against DexScreener's orders API to find tokens that have paid for a profile ("DEX PAID") or are a community takeover ("CTO"). Here's every step, layer by layer.

---

## 1. Frontend: `page.tsx` — How the UI Requests Data

```
User opens /dex-orders → period defaults to "1h"
                        → useInfiniteQuery fires with offset=0
```

### The Hook

```ts
function useDexOrders(period: Period) {
  return useInfiniteQuery<DexOrdersPage>({
    queryKey: ["dex-orders", period],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        period,
        offset: String(pageParam ?? 0),   // starts at 0
      });
      const res = await fetch(`/api/dex-orders?${params}`);
      return res.json();
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextOffset ?? undefined) : undefined,
  });
}
```

**Request 1:** `GET /api/dex-orders?period=1h&offset=0`
**Request 2:** `GET /api/dex-orders?period=1h&offset=50` (if `hasMore` was `true`)
**...continues until `hasMore` is `false`**

### Auto-fetch loop

```ts
useEffect(() => {
  if (hasNextPage && !isFetchingNextPage) {
    fetchNextPage();
  }
}, [hasNextPage, isFetchingNextPage, fetchNextPage]);
```

This fires continuously, fetching batch after batch until all tokens are checked.

### Token accumulation

```ts
const tokens = useMemo(() => {
  if (!data?.pages) return [];
  const seen = new Set<string>();
  const result: DexOrderToken[] = [];
  for (const page of data.pages) {
    for (const token of page.data) {       // page.data = only tokens WITH orders
      if (!seen.has(token.address)) {
        seen.add(token.address);
        result.push(token);
      }
    }
  }
  return result;
}, [data]);
```

**Key point:** Each page's `data` array only contains tokens that PASSED the filter (have approved orders). Most batches will return `data: []`.

---

## 2. API Route: `/api/dex-orders/
route.ts` — Batch Processing

### Step 2a: Get all pump.fun tokens for the period

```ts
const allTokens = await fetchAllPumpFunForPeriod(period);  // e.g. "1h"
const totalTokens = allTokens.length;
const batch = allTokens.slice(offset, offset + BATCH_SIZE);  // BATCH_SIZE = 50
```

This calls the shared utility which fetches from Moralis and is cached for 1 hour.

### Step 2b: For each token in the batch, check DexScreener orders

```ts
for (const token of batch) {
  const cacheKey = `dex-orders:${token.address}`;
  let tags = serverCache.get<DexOrderTag[]>(cacheKey);

  if (tags === null) {
    const orderData = await getTokenOrders("solana", token.address);
    tags = [];

    if (orderData?.orders) {
      for (const order of orderData.orders) {
        if (order.status !== "approved") continue;        // <<<< FILTER 1: only "approved"
        if (order.type === "tokenProfile") tags.push("dexPaid");
        if (order.type === "communityTakeover") tags.push("cto");
      }
    }

    serverCache.set(cacheKey, tags, CACHE_TTL.DEX_ORDERS);  // cache for 1 hour
  }

  if (tags.length > 0) {                                    // <<<< FILTER 2: only if tags exist
    results.push({ ...token, tags });
  }
}
```

### POTENTIAL PROBLEM AREAS HERE:

1. **`order.status !== "approved"` filter** — If DexScreener returns orders with a different status string (e.g., `"active"`, `"completed"`, `"fulfilled"`, `"processing"`), they get silently skipped. **This is the most likely cause of your issue.**

2. **`order.type` matching** — We look for exact strings `"tokenProfile"` and `"communityTakeover"`. If DexScreener uses different type strings (e.g., `"token_profile"`, `"TokenProfile"`, `"boostTop"`, `"boost"`), they won't match.

3. **`getTokenOrders` returns `null`** — If the DexScreener API returns a non-200 status or errors, `fetchDexScreener` returns `null`, so `orderData` is `null`, so `tags = []`, and the token is cached as "no orders" for 1 hour.

4. **Empty array cached as "checked"** — Once a token is cached with `tags = []`, it won't be re-checked for 1 hour, even if you restart the page.

---

## 3. DexScreener API Call: `getTokenOrders()`

```ts
export async function getTokenOrders(
  chainId: string,
  tokenAddress: string
): Promise<{ orders: DexScreenerOrder[] } | null> {
  const data = await fetchDexScreener<DexScreenerOrder[]>(
    `/orders/v1/${chainId}/${tokenAddress}`
  );
  if (Array.isArray(data)) return { orders: data };
  return null;
}
```

**What this calls:** `https://api.dexscreener.com/orders/v1/solana/{tokenAddress}`

### POTENTIAL PROBLEM AREAS:

5. **Response shape assumption** — We assume the API returns a raw JSON array `[{type, status}, ...]`. If it returns `{ orders: [...] }` or `{ pairs: [...] }` or some other wrapper, `Array.isArray(data)` is `false` and we return `null` (meaning: no orders found).

6. **`fetchDexScreener` silently swallows errors** — It catches all errors and returns `null`. If DexScreener is rate-limiting (429) or returning 403, you'll never know — it just looks like "no orders."

```ts
async function fetchDexScreener<T>(path: string): Promise<T | null> {
  await rateLimit("dexscreener");
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;    // <<<< 429, 403, 500 all become null
    return res.json();
  } catch {
    return null;                 // <<<< network errors become null
  }
}
```

7. **Rate limiter** — DexScreener rate limit is `{ maxTokens: 60, refillRate: 1 }` (60 burst, then 1/sec). A batch of 50 tokens will exhaust the burst on the first call, then subsequent batches will be throttled to 1 req/sec. This is correct but slow — 50 tokens = ~50 seconds per batch after the first.

8. **`next: { revalidate: 30 }`** — This is a Next.js fetch cache directive. It caches the fetch response for 30 seconds at the Next.js layer. This means if the same token address is checked twice within 30 seconds (from different batch requests or page loads), Next.js serves the stale response. This is SEPARATE from our LRU cache. **This could mask fresh data.**

---

## 4. Moralis Token Fetching: `fetchAllPumpFunForPeriod()`

```ts
export async function fetchAllPumpFunForPeriod(period: TimePeriod): Promise<PumpFunToken[]> {
  const cacheKey = `pump-fun:${period}`;
  const cached = serverCache.get<PumpFunToken[]>(cacheKey);
  if (cached) return cached;      // <<<< returns cached list for 1 hour

  const cutoff = Date.now() - PERIOD_MS[period];
  const all: PumpFunToken[] = [];
  let cursor: string | undefined;

  while (true) {
    const response = await getPumpFunNewTokens(100, cursor);
    if (!response?.result?.length) break;

    const tokens = mapMoralisTokens(response.result);
    const filtered = tokens.filter(
      (t) => new Date(t.createdAt).getTime() >= cutoff
    );
    all.push(...filtered);

    const oldest = tokens[tokens.length - 1];
    if (!oldest || new Date(oldest.createdAt).getTime() < cutoff) break;
    if (!response.cursor) break;
    cursor = response.cursor;
  }

  serverCache.set(cacheKey, all, PERIOD_CACHE_TTL);  // cache for 1 hour
  return all;
}
```

### POTENTIAL PROBLEM AREAS:

9. **If Moralis returns 0 tokens** — If the API key is missing, rate-limited, or the endpoint returns an error, `getPumpFunNewTokens` returns `null`, the loop breaks immediately, and `allTokens` is `[]`. The dex-orders route would then return `totalTokens: 0` and the progress bar would show "0 / 0".

10. **Moralis returns tokens but in unexpected order** — The loop assumes tokens come newest-first. If they don't, the cutoff check (`oldest.createdAt < cutoff`) might stop too early.

---

## 5. Cache Interactions (Two Layers)

### Layer A: LRU Cache (`serverCache`)

| Cache Key | What's Stored | TTL | Purpose |
|---|---|---|---|
| `pump-fun:1h` | `PumpFunToken[]` (all tokens for period) | 1 hour | Avoid re-fetching Moralis |
| `dex-orders:{address}` | `DexOrderTag[]` (could be `[]`) | 1 hour | Per-token DexScreener result |

### Layer B: Next.js Fetch Cache

```ts
next: { revalidate: 30 }  // in fetchDexScreener
```

This is an additional fetch-level cache. Even if our LRU cache expires, Next.js might serve a 30-second-old response.

### POTENTIAL PROBLEM:

11. **Cache poisoning with empty arrays** — If DexScreener returns a non-200 (rate limit, server error), `getTokenOrders` returns `null`, we set `tags = []`, and cache that for 1 hour. That token is now marked as "no orders" for the next hour, even though the real reason was an API failure.

---

## 6. Summary of Most Likely Causes for "0 Results"

| # | Cause | How to Verify |
|---|---|---|
| **1** | `order.status` is not `"approved"` | Add `console.log` in the route to log raw `orderData` for a token you know has orders |
| **2** | `order.type` is not `"tokenProfile"` / `"communityTakeover"` | Same — log the raw response |
| **5** | DexScreener returns a wrapped object, not a raw array | Manually `curl https://api.dexscreener.com/orders/v1/solana/{address}` and check shape |
| **6** | DexScreener returning 429/403 silently → all results are `null` → cached as empty | Add logging in `fetchDexScreener` for non-200 responses |
| **8** | Next.js fetch cache serving stale empty responses | Try with `cache: "no-store"` instead of `next: { revalidate: 30 }` |
| **9** | Moralis returning 0 tokens → nothing to check | Check `totalTokens` in the API response — if it's 0, the problem is Moralis, not DexScreener |
| **11** | Rate limit hit → first 60 tokens cached correctly, rest cached as empty | Check if you get some results for short periods but 0 for longer ones |

---

## 7. Recommended Debug Steps

```bash
# 1. Check what DexScreener actually returns for a known token
curl -s "https://api.dexscreener.com/orders/v1/solana/YOUR_TOKEN_ADDRESS" | jq .

# 2. Check your API route directly
curl -s "http://localhost:3000/api/dex-orders?period=1h&offset=0" | jq .

# 3. Check if Moralis is returning tokens
curl -s "http://localhost:3000/api/pump-fun?period=1h" | jq '.data | length'
```

Look at the raw DexScreener response shape and field values — the answer is almost certainly in the `status` or `type` field names not matching what we filter for.
