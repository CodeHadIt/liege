interface RateLimiterConfig {
  maxTokens: number;
  refillRate: number; // tokens per second
}

class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = config;
    this.tokens = config.maxTokens;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.config.maxTokens,
      this.tokens + elapsed * this.config.refillRate
    );
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitTime = ((1 - this.tokens) / this.config.refillRate) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.refill();
    }
    this.tokens -= 1;
  }
}

const limiters: Record<string, TokenBucketRateLimiter> = {};

const API_RATE_LIMITS: Record<string, RateLimiterConfig> = {
  dexscreener: { maxTokens: 60, refillRate: 1 },
  geckoterminal: { maxTokens: 30, refillRate: 0.5 },
  birdeye: { maxTokens: 10, refillRate: 0.16 },
  solscan: { maxTokens: 10, refillRate: 0.16 },
  coingecko: { maxTokens: 30, refillRate: 0.5 },
  helius: { maxTokens: 20, refillRate: 8 },
  basescan: { maxTokens: 5, refillRate: 0.08 },
  bscscan: { maxTokens: 5, refillRate: 0.08 },
  // Robinhood Chain Blockscout reads. Sized for the 30s on-chain watcher, which
  // can spend several calls per pass (latest block + getLogs + token meta +
  // enrich). Blockscout's read API allows well above this, so 2/s with a burst of
  // 10 keeps the watcher from ever blocking on the limiter while staying polite.
  robinscan: { maxTokens: 10, refillRate: 2 },
  stonkfun: { maxTokens: 10, refillRate: 0.5 },
  // o1's public API. Documented limits are 20/s, 300/min, 25k/day on the
  // developer plan. The pollers need ~2/min, so this is sized well under the
  // per-minute quota rather than near the per-second ceiling — bursts are what
  // trip the limiter, and there is no reason to burst.
  o1: { maxTokens: 4, refillRate: 0.5 },
  sunrise: { maxTokens: 10, refillRate: 0.5 },
  robinhood: { maxTokens: 10, refillRate: 0.5 },
  // BSC stock-quote watchers. Both scrape a page (and, for Flap, its app bundle)
  // rather than an API, so they poll gently — new quote assets are listed on the
  // order of days, not seconds.
  fourmeme: { maxTokens: 5, refillRate: 0.2 },
  flap: { maxTokens: 6, refillRate: 0.2 },
  // Public BNB Chain RPCs, used by the on-chain launch watcher. A pass costs a
  // block number, one getLogs per watched platform, and a couple of calls per
  // matching launch — well inside the free endpoints' limits at 5/s, and the
  // client rotates endpoints on failure anyway.
  bscrpc: { maxTokens: 20, refillRate: 5 },
  // Robinhood Chain JSON-RPC, used by the alpha-wallet watcher. A poll costs a
  // block number plus one getLogs; only a detected buy adds calls, and those are
  // rare, so this is generous headroom.
  rhrpc: { maxTokens: 20, refillRate: 5 },
  // OpenSea's public v2 endpoints — a couple of calls per NFT alert.
  opensea: { maxTokens: 10, refillRate: 1 },
  // Pump.fun's frontend API, used by the launch-window watcher. A pass is
  // normally a single /coins page every 60s; the burst allowance covers the
  // extra pages pulled when a poll has been delayed and one page no longer
  // spans the gap.
  pumpfun: { maxTokens: 10, refillRate: 0.5 },
  jupiter: { maxTokens: 30, refillRate: 0.5 },
  moralis: { maxTokens: 20, refillRate: 0.33 },
};

export async function rateLimit(api: string): Promise<void> {
  if (!limiters[api]) {
    const config = API_RATE_LIMITS[api];
    if (!config) return;
    limiters[api] = new TokenBucketRateLimiter(config);
  }
  await limiters[api].acquire();
}
