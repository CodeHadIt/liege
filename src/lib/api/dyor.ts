/**
 * DYOR.io REST API client
 * https://docs.dyor.io/rest-api
 *
 * Used for TON jetton price charts. Returns price points per resolution;
 * we synthesise OHLCV bars from consecutive points.
 */

import type { OHLCVBar, Timeframe } from "@/types/token";

const BASE = "https://api.dyor.io";

async function dyorGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface DyorPricePoint {
  value: {
    value:    string;   // raw integer string
    decimals: number;   // divide by 10^decimals to get real price
  };
  time: string;         // ISO 8601 timestamp
}

interface DyorPriceChartResponse {
  points: DyorPricePoint[];
}

// ── Timeframe → DYOR resolution mapping ──────────────────────────────────────

type DyorResolution = "min1" | "min15" | "hour1" | "day1";

// Max history the API serves per resolution (DYOR enforces these).
// We use them to build a `from` timestamp that requests enough bars.
const RESOLUTION_MAP: Record<
  Timeframe,
  { resolution: DyorResolution; barsToFetch: number }
> = {
  "1m":  { resolution: "min1",  barsToFetch: 300  },  // ~5 h of 1-min bars
  "5m":  { resolution: "min1",  barsToFetch: 300  },  // fetch min1, aggregate to 5-min
  "15m": { resolution: "min15", barsToFetch: 200  },
  "1h":  { resolution: "hour1", barsToFetch: 200  },
  "4h":  { resolution: "hour1", barsToFetch: 400  },  // fetch hourly, aggregate to 4h
  "1d":  { resolution: "day1",  barsToFetch: 200  },
};

// Minutes per bar for each timeframe (used for `from` calculation)
const TF_MINUTES: Record<Timeframe, number> = {
  "1m":  1,
  "5m":  5,
  "15m": 15,
  "1h":  60,
  "4h":  240,
  "1d":  1440,
};

// ── Price point → OHLCVBar conversion ────────────────────────────────────────

/** Convert raw DYOR value to float */
function toFloat(pt: DyorPricePoint): number {
  try {
    return Number(BigInt(pt.value.value)) / Math.pow(10, pt.value.decimals);
  } catch {
    return parseFloat(pt.value.value) / Math.pow(10, pt.value.decimals);
  }
}

/**
 * Synthesise OHLCV bars from price points.
 * - open  = previous close (first bar: open = close)
 * - high  = max(open, close)
 * - low   = min(open, close)
 * - volume = 0 (DYOR chart endpoint doesn't provide volume)
 */
function pointsToBars(points: DyorPricePoint[]): OHLCVBar[] {
  if (points.length === 0) return [];
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < points.length; i++) {
    const close = toFloat(points[i]);
    const open  = i === 0 ? close : toFloat(points[i - 1]);
    bars.push({
      timestamp: Math.floor(new Date(points[i].time).getTime() / 1000),
      open,
      high:   Math.max(open, close),
      low:    Math.min(open, close),
      close,
      volume: 0,
    });
  }
  return bars;
}

/**
 * Aggregate fine-grained bars into a coarser timeframe.
 * `groupSize` is how many source bars make one output bar.
 */
function aggregateBars(bars: OHLCVBar[], groupSize: number): OHLCVBar[] {
  if (groupSize <= 1) return bars;
  const result: OHLCVBar[] = [];
  for (let i = 0; i < bars.length; i += groupSize) {
    const chunk = bars.slice(i, i + groupSize);
    if (chunk.length === 0) continue;
    result.push({
      timestamp: chunk[0].timestamp,
      open:      chunk[0].open,
      high:      Math.max(...chunk.map((b) => b.high)),
      low:       Math.min(...chunk.map((b) => b.low)),
      close:     chunk[chunk.length - 1].close,
      volume:    0,
    });
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch OHLCV price bars for a TON jetton from DYOR.io.
 *
 * @param jettonAddress  Jetton master address (EQ.../UQ... or raw)
 * @param timeframe      One of the standard app timeframes
 * @returns              Array of OHLCVBar sorted oldest → newest, or [] on failure
 */
export async function getJettonChart(
  jettonAddress: string,
  timeframe: Timeframe
): Promise<OHLCVBar[]> {
  const { resolution, barsToFetch } = RESOLUTION_MAP[timeframe];
  const tfMinutes = TF_MINUTES[timeframe];

  // Build `from` timestamp so we get enough bars
  const now  = new Date();
  const from = new Date(now.getTime() - barsToFetch * tfMinutes * 60 * 1000);

  const qs = new URLSearchParams({
    resolution,
    from: from.toISOString(),
    to:   now.toISOString(),
    currency: "usd",
  });

  const data = await dyorGet<DyorPriceChartResponse>(
    `/v1/jettons/${encodeURIComponent(jettonAddress)}/price/chart?${qs}`
  );

  if (!data?.points?.length) return [];

  // Sort ascending by time and deduplicate (API returns newest-first)
  const seen = new Set<number>();
  const sorted = [...data.points]
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
    .filter((p) => {
      const t = new Date(p.time).getTime();
      return !seen.has(t) && seen.add(t);
    });

  const bars = pointsToBars(sorted);

  // Aggregate for timeframes that don't have a native DYOR resolution
  if (timeframe === "5m")  return aggregateBars(bars, 5);
  if (timeframe === "4h")  return aggregateBars(bars, 4);

  return bars;
}
