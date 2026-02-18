"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  AreaSeries,
  LineSeries,
} from "lightweight-charts";
import type { IChartApi, Time } from "lightweight-charts";
import { Skeleton } from "@/components/ui/skeleton";
import { useTokenChart } from "@/features/token-analyzer/hooks/use-token-chart";
import { cn } from "@/lib/utils";
import { ChartBar, ChartLine } from "@phosphor-icons/react";
import type { ChainId } from "@/types/chain";
import type { Timeframe } from "@/types/token";

interface CandlestickChartProps {
  chain: ChainId;
  address: string;
  marketCap?: number | null;
  priceUsd?: number | null;
}

type ChartMode = "candle" | "line";

const timeframes: { value: Timeframe; label: string }[] = [
  { value: "1m", label: "1M" },
  { value: "5m", label: "5M" },
  { value: "15m", label: "15M" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
];

function formatMcap(num: number): string {
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

export function CandlestickChart({ chain, address, marketCap, priceUsd }: CandlestickChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [chartMode, setChartMode] = useState<ChartMode>("candle");
  const { data: bars, isLoading } = useTokenChart(chain, address, timeframe);

  const hasData = bars && bars.length > 0;

  const buildChart = useCallback(() => {
    const container = chartContainerRef.current;
    if (!container || !hasData) return;

    // Clean up previous chart
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    // Derive supply from marketCap / currentPrice for the mcap axis
    const supply =
      marketCap && priceUsd && priceUsd > 0 ? marketCap / priceUsd : null;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 360,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#6B6B80",
        fontFamily: "var(--font-jetbrains), monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.02)" },
        horzLines: { color: "rgba(255,255,255,0.02)" },
      },
      crosshair: {
        vertLine: {
          color: "rgba(0,240,255,0.3)",
          width: 1,
          style: 2,
          labelBackgroundColor: "#111118",
        },
        horzLine: {
          color: "rgba(0,240,255,0.3)",
          width: 1,
          style: 2,
          labelBackgroundColor: "#111118",
        },
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.04)",
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.04)",
      },
      leftPriceScale: {
        visible: !!supply,
        borderColor: "rgba(255,255,255,0.04)",
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });

    chartRef.current = chart;

    // Sort bars ascending by timestamp
    const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);

    // Volume series (shared between both modes)
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });

    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    const volumeData = sorted.map((bar) => ({
      time: bar.timestamp as Time,
      value: bar.volume,
      color:
        bar.close >= bar.open
          ? "rgba(0, 255, 136, 0.15)"
          : "rgba(255, 59, 92, 0.15)",
    }));

    volumeSeries.setData(volumeData);

    if (chartMode === "candle") {
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#00FF88",
        downColor: "#FF3B5C",
        borderUpColor: "#00FF88",
        borderDownColor: "#FF3B5C",
        wickUpColor: "#00FF88",
        wickDownColor: "#FF3B5C",
      });

      candleSeries.setData(
        sorted.map((bar) => ({
          time: bar.timestamp as Time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        }))
      );
    } else {
      const isPositive = sorted[sorted.length - 1].close >= sorted[0].close;
      const color = isPositive ? "#00FF88" : "#FF3B5C";

      const areaSeries = chart.addSeries(AreaSeries, {
        lineColor: color,
        topColor: isPositive
          ? "rgba(0, 255, 136, 0.15)"
          : "rgba(255, 59, 92, 0.15)",
        bottomColor: "transparent",
        lineWidth: 2,
      });

      areaSeries.setData(
        sorted.map((bar) => ({
          time: bar.timestamp as Time,
          value: bar.close,
        }))
      );
    }

    // Market cap axis (left side) — invisible line series that drives the scale
    if (supply) {
      const mcapSeries = chart.addSeries(LineSeries, {
        priceScaleId: "left",
        color: "transparent",
        lineWidth: 1,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: {
          type: "custom",
          formatter: (val: number) => formatMcap(val),
        },
      });

      mcapSeries.setData(
        sorted.map((bar) => ({
          time: bar.timestamp as Time,
          value: bar.close * supply,
        }))
      );
    }

    chart.timeScale().fitContent();

    // Resize observer
    const handleResize = () => {
      if (container) {
        chart.applyOptions({ width: container.clientWidth });
      }
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, hasData, chartMode, marketCap, priceUsd]);

  useEffect(() => {
    const cleanup = buildChart();
    return () => cleanup?.();
  }, [buildChart]);

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <ChartBar className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Price Chart
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Chart mode toggle */}
          <div className="flex gap-0.5 bg-white/[0.03] rounded-lg p-0.5">
            <button
              className={cn(
                "p-1.5 rounded-md transition-all",
                chartMode === "candle"
                  ? "bg-[#00F0FF]/10 text-[#00F0FF] shadow-[0_0_10px_rgba(0,240,255,0.1)]"
                  : "text-[#6B6B80] hover:text-[#E8E8ED]"
              )}
              onClick={() => setChartMode("candle")}
              title="Candlestick"
            >
              <ChartBar className="h-3.5 w-3.5" />
            </button>
            <button
              className={cn(
                "p-1.5 rounded-md transition-all",
                chartMode === "line"
                  ? "bg-[#00F0FF]/10 text-[#00F0FF] shadow-[0_0_10px_rgba(0,240,255,0.1)]"
                  : "text-[#6B6B80] hover:text-[#E8E8ED]"
              )}
              onClick={() => setChartMode("line")}
              title="Line"
            >
              <ChartLine className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Timeframe selector */}
          <div className="flex gap-0.5 bg-white/[0.03] rounded-lg p-0.5">
            {timeframes.map((tf) => (
              <button
                key={tf.value}
                className={cn(
                  "px-2.5 py-1 text-[10px] font-mono font-semibold rounded-md transition-all",
                  timeframe === tf.value
                    ? "bg-[#00F0FF]/10 text-[#00F0FF] shadow-[0_0_10px_rgba(0,240,255,0.1)]"
                    : "text-[#6B6B80] hover:text-[#E8E8ED]"
                )}
                onClick={() => setTimeframe(tf.value)}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="p-4">
        {isLoading ? (
          <Skeleton className="h-[360px] w-full shimmer rounded-lg" />
        ) : !hasData ? (
          <div className="h-[360px] flex flex-col items-center justify-center text-[#6B6B80]">
            <ChartBar className="h-8 w-8 mb-3 opacity-20" />
            <span className="text-sm">No chart data available</span>
          </div>
        ) : (
          <div ref={chartContainerRef} className="h-[360px] w-full" />
        )}
      </div>
    </div>
  );
}
