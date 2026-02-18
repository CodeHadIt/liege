"use client";

import { useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { useTokenChart } from "@/features/token-analyzer/hooks/use-token-chart";
import { cn } from "@/lib/utils";
import { ChartBar } from "@phosphor-icons/react";
import type { ChainId } from "@/types/chain";
import type { Timeframe } from "@/types/token";

interface PriceChartProps {
  chain: ChainId;
  address: string;
}

const timeframes: { value: Timeframe; label: string }[] = [
  { value: "1m", label: "1M" },
  { value: "5m", label: "5M" },
  { value: "15m", label: "15M" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
];

export function PriceChart({ chain, address }: PriceChartProps) {
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const { data: bars, isLoading } = useTokenChart(chain, address, timeframe);

  const chartData = (bars || []).map((bar) => ({
    time: bar.timestamp,
    price: bar.close,
    volume: bar.volume,
  }));

  const isPositive =
    chartData.length >= 2 &&
    chartData[chartData.length - 1].price >= chartData[0].price;

  const lineColor = isPositive ? "#00FF88" : "#FF3B5C";

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
          <Skeleton className="h-[300px] w-full shimmer rounded-lg" />
        ) : chartData.length === 0 ? (
          <div className="h-[300px] flex flex-col items-center justify-center text-[#6B6B80]">
            <ChartBar className="h-8 w-8 mb-3 opacity-20" />
            <span className="text-sm">No chart data available</span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={lineColor} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                tickFormatter={(val) => {
                  const d = new Date(val * 1000);
                  return `${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
                }}
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "#6B6B80", fontFamily: "var(--font-jetbrains)" }}
                minTickGap={50}
              />
              <YAxis
                domain={["auto", "auto"]}
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "#6B6B80", fontFamily: "var(--font-jetbrains)" }}
                tickFormatter={(val) => {
                  if (val >= 1) return `$${val.toFixed(2)}`;
                  return `$${val.toPrecision(3)}`;
                }}
                width={65}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#111118",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: "10px",
                  fontSize: 11,
                  fontFamily: "var(--font-jetbrains)",
                  boxShadow: "0 10px 40px -10px rgba(0,0,0,0.5)",
                }}
                labelStyle={{ color: "#6B6B80" }}
                itemStyle={{ color: "#E8E8ED" }}
                labelFormatter={(val) =>
                  new Date(val * 1000).toLocaleString()
                }
                formatter={(val: number | undefined) => [
                  val != null ? `$${val < 1 ? val.toPrecision(4) : val.toFixed(4)}` : "—",
                  "Price",
                ]}
              />
              <Area
                type="monotone"
                dataKey="price"
                stroke={lineColor}
                fill="url(#priceGrad)"
                strokeWidth={1.5}
                dot={false}
                activeDot={{
                  r: 4,
                  fill: lineColor,
                  stroke: "#0A0A0F",
                  strokeWidth: 2,
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
