"use client";

import { useRef, useEffect, useState } from "react";
import { createChart, ColorType } from "lightweight-charts";
import type { IChartApi, ISeriesApi, CandlestickData, Time } from "lightweight-charts";
import { Skeleton } from "@/components/ui/skeleton";
import { useTokenChart } from "@/features/token-analyzer/hooks/use-token-chart";
import { cn } from "@/lib/utils";
import { BarChart3, CandlestickChart as CandleIcon } from "lucide-react";
import type { ChainId } from "@/types/chain";
import type { Timeframe } from "@/types/token";

interface CandlestickChartProps {
  chain: ChainId;
  address: string;
}

const timeframes: { value: Timeframe; label: string }[] = [
  { value: "5m", label: "5M" },
  { value: "15m", label: "15M" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
];

export function CandlestickChart({ chain, address }: CandlestickChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const { data: bars, isLoading } = useTokenChart(chain, address, timeframe);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
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
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#00FF88",
      downColor: "#FF3B5C",
      borderUpColor: "#00FF88",
      borderDownColor: "#FF3B5C",
      wickUpColor: "#00FF88",
      wickDownColor: "#FF3B5C",
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });

    chart.priceScale("volume").applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    seriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(chartContainerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !volumeSeriesRef.current || !bars) return;

    const candleData: CandlestickData<Time>[] = bars.map((bar) => ({
      time: bar.timestamp as Time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));

    const volumeData = bars.map((bar) => ({
      time: bar.timestamp as Time,
      value: bar.volume,
      color:
        bar.close >= bar.open
          ? "rgba(0, 255, 136, 0.15)"
          : "rgba(255, 59, 92, 0.15)",
    }));

    seriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volumeData);

    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [bars]);

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <CandleIcon className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Price Chart
          </span>
        </div>
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

      {/* Chart */}
      <div className="p-4">
        {isLoading ? (
          <Skeleton className="h-[360px] w-full shimmer rounded-lg" />
        ) : !bars || bars.length === 0 ? (
          <div className="h-[360px] flex flex-col items-center justify-center text-[#6B6B80]">
            <BarChart3 className="h-8 w-8 mb-3 opacity-20" />
            <span className="text-sm">No chart data available</span>
          </div>
        ) : (
          <div ref={chartContainerRef} className="h-[360px] w-full" />
        )}
      </div>
    </div>
  );
}
