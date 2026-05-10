"use client";

// lightweight-charts is browser-only; safe to import statically because this
// file is already a Client Component ('use client') and Next.js will never
// include it in the SSR bundle.
import { createChart, CandlestickSeries } from "lightweight-charts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChartBar } from "@phosphor-icons/react";
import type { ChainId } from "@/types/chain";
import type { Timeframe } from "@/types/token";
import { useTokenChart } from "@/features/token-analyzer/hooks/use-token-chart";

interface CandlestickChartProps {
  chain:      ChainId;
  address:    string;
  marketCap?: number | null;
  priceUsd?:  number | null;
}

// ── GMGN iframe (Solana / EVM) ────────────────────────────────────────────────

function toGmgnChain(chain: ChainId): string {
  if (chain === "solana") return "sol";
  return chain;
}

function GmgnChart({ chain, address }: { chain: ChainId; address: string }) {
  return (
    <iframe
      src={`https://www.gmgn.cc/kline/${toGmgnChain(chain)}/${address}`}
      className="w-full border-0"
      style={{ height: 480 }}
      allowFullScreen
      referrerPolicy="no-referrer-when-downgrade"
    />
  );
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatMcap(value: number): string {
  if (!isFinite(value) || value <= 0) return "$0";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000)     return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000)         return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatPrice(value: number): string {
  if (!isFinite(value) || value <= 0) return "$0";
  if (value >= 1)      return `$${value.toFixed(4)}`;
  if (value >= 0.0001) return `$${value.toFixed(6)}`;
  return `$${value.toExponential(3)}`;
}

// ── TON chart ─────────────────────────────────────────────────────────────────

const TIMEFRAMES: { label: string; value: Timeframe }[] = [
  { label: "1m",  value: "1m"  },
  { label: "15m", value: "15m" },
  { label: "1h",  value: "1h"  },
  { label: "4h",  value: "4h"  },
  { label: "1D",  value: "1d"  },
];

interface TonChartProps {
  address:    string;
  marketCap?: number | null;
  priceUsd?:  number | null;
}

function TonChart({ address, marketCap, priceUsd }: TonChartProps) {
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef     = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef    = useRef<any>(null);

  const { data: bars, isLoading } = useTokenChart("ton", address, timeframe);

  const totalSupply = marketCap && priceUsd && priceUsd > 0 ? marketCap / priceUsd : null;
  const useMcap     = !!totalSupply && totalSupply > 0;

  // Always-current refs so effects don't close over stale values
  const useMcapRef     = useRef(useMcap);
  const totalSupplyRef = useRef(totalSupply);
  useMcapRef.current     = useMcap;
  totalSupplyRef.current = totalSupply;

  // ── 1. Create chart synchronously after first paint ───────────────────────
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "transparent" },
        textColor:  "#6B6B80",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: {
        borderColor:    "rgba(255,255,255,0.08)",
        timeVisible:    true,
        secondsVisible: false,
      },
      width:  el.clientWidth  || 600,
      height: el.clientHeight || 460,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor:         "#00c896",
      downColor:       "#ff4560",
      borderUpColor:   "#00c896",
      borderDownColor: "#ff4560",
      wickUpColor:     "#00c896",
      wickDownColor:   "#ff4560",
    });

    chartRef.current  = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current  = null;
      seriesRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. Clear series when timeframe changes ────────────────────────────────
  useEffect(() => {
    seriesRef.current?.setData([]);
  }, [timeframe]);

  // ── 3. Push data whenever bars arrive ────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    const chart  = chartRef.current;
    if (!series || !bars?.length) return;

    const supply = totalSupplyRef.current;
    const mcap   = useMcapRef.current;

    const seen = new Set<number>();
    const data = bars
      .map((b) => ({
        time:  b.timestamp as number,
        open:  mcap ? b.open  * supply! : b.open,
        high:  mcap ? b.high  * supply! : b.high,
        low:   mcap ? b.low   * supply! : b.low,
        close: mcap ? b.close * supply! : b.close,
      }))
      .sort((a, b) => a.time - b.time)
      .filter((b) => !seen.has(b.time) && seen.add(b.time));

    if (!data.length) return;

    series.setData(data);
    chart?.timeScale().fitContent();

    // Keep Y-axis formatter in sync with current mcap state
    chart?.applyOptions({
      localization: { priceFormatter: mcap ? formatMcap : formatPrice },
    });
  }, [bars, totalSupply]); // eslint-disable-line react-hooks/exhaustive-deps

  // Info strip values
  const lastBar   = bars?.[bars.length - 1];
  const firstBar  = bars?.[0];
  const supply    = totalSupply ?? 1;
  const pctChange = lastBar && firstBar && firstBar.close > 0
    ? ((lastBar.close - firstBar.close) / firstBar.close) * 100
    : null;
  const isUp      = pctChange !== null && pctChange >= 0;
  const currentVal = lastBar
    ? useMcap ? formatMcap(lastBar.close * supply) : formatPrice(lastBar.close)
    : null;

  return (
    <div className="relative select-none">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.04]">
        <div className="flex items-center gap-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              onClick={() => setTimeframe(tf.value)}
              className={`px-2.5 py-1 rounded text-[10px] font-mono font-semibold transition-all ${
                timeframe === tf.value
                  ? "bg-white/[0.08] text-[#E8E8ED]"
                  : "text-[#555566] hover:text-[#9999aa]"
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {currentVal && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-[#E8E8ED]">{currentVal}</span>
            {pctChange !== null && (
              <span className={`text-[10px] font-mono font-semibold ${isUp ? "text-[#00c896]" : "text-[#ff4560]"}`}>
                {isUp ? "+" : ""}{pctChange.toFixed(2)}%
              </span>
            )}
          </div>
        )}
      </div>

      {/* Chart canvas */}
      <div style={{ height: 460 }}>
        <div ref={containerRef} className="w-full h-full" />
      </div>

      {/* Overlays */}
      {isLoading && (
        <div className="absolute inset-0 top-[42px] flex items-center justify-center pointer-events-none">
          <span className="text-[11px] font-mono text-[#6B6B80] animate-pulse">Loading…</span>
        </div>
      )}
      {!isLoading && (!bars || bars.length === 0) && (
        <div className="absolute inset-0 top-[42px] flex items-center justify-center pointer-events-none">
          <span className="text-[11px] font-mono text-[#6B6B80]">No chart data</span>
        </div>
      )}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export function CandlestickChart({ chain, address, marketCap, priceUsd }: CandlestickChartProps) {
  return (
    <div className="glow-card rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-white/[0.04]">
        <ChartBar className="h-4 w-4 text-[#00F0FF]/50" />
        <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
          Price Chart
        </span>
        {chain === "ton" && (
          <span className="ml-auto text-[9px] font-mono text-[#555566] uppercase tracking-wider">
            mcap
          </span>
        )}
      </div>

      {chain === "ton" ? (
        // key={address} forces a full remount when the token changes, guaranteeing
        // the chart instance, refs, and query state are all fresh.
        <TonChart key={address} address={address} marketCap={marketCap} priceUsd={priceUsd} />
      ) : (
        <GmgnChart chain={chain} address={address} />
      )}
    </div>
  );
}
