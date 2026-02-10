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
  helius: { maxTokens: 10, refillRate: 0.16 },
  basescan: { maxTokens: 5, refillRate: 0.08 },
  bscscan: { maxTokens: 5, refillRate: 0.08 },
  jupiter: { maxTokens: 30, refillRate: 0.5 },
};

export async function rateLimit(api: string): Promise<void> {
  if (!limiters[api]) {
    const config = API_RATE_LIMITS[api];
    if (!config) return;
    limiters[api] = new TokenBucketRateLimiter(config);
  }
  await limiters[api].acquire();
}
