"use client";

import { Users, ExternalLink } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { useTokenHolders } from "@/features/token-analyzer/hooks/use-token-holders";
import { shortenAddress } from "@/lib/utils";
import { getExplorerAddressUrl } from "@/config/chains";
import type { ChainId } from "@/types/chain";

interface TopHoldersProps {
  chain: ChainId;
  address: string;
}

const PIE_COLORS = [
  "#00F0FF",
  "#A855F7",
  "#00FF88",
  "#FFB800",
  "#FF3B5C",
  "#0080FF",
  "#FF6EE6",
  "#00D4AA",
  "#FF8C42",
  "#6366F1",
];

export function TopHolders({ chain, address }: TopHoldersProps) {
  const { data: holders, isLoading } = useTokenHolders(chain, address);

  const top10 = (holders || []).slice(0, 10);
  const top10Pct = top10.reduce((sum, h) => sum + h.percentage, 0);
  const otherPct = Math.max(0, 100 - top10Pct);

  const pieData = [
    ...top10.map((h, i) => ({
      name: h.label || shortenAddress(h.address, 4),
      value: parseFloat(h.percentage.toFixed(2)),
      color: PIE_COLORS[i % PIE_COLORS.length],
    })),
    ...(otherPct > 0
      ? [{ name: "Others", value: parseFloat(otherPct.toFixed(2)), color: "#2A2A3A" }]
      : []),
  ];

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Top Holders
          </span>
        </div>
        <span className="text-[10px] font-mono font-bold text-[#E8E8ED]">
          Top 10: {top10Pct.toFixed(1)}%
        </span>
      </div>

      <div className="p-4">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-[180px] w-full shimmer rounded-lg" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full shimmer rounded" />
            ))}
          </div>
        ) : !holders || holders.length === 0 ? (
          <div className="text-center py-10 text-[#6B6B80]">
            <Users className="h-6 w-6 mx-auto mb-2 opacity-20" />
            <span className="text-xs">No holder data available</span>
          </div>
        ) : (
          <>
            {/* Pie Chart */}
            <div className="h-[180px] mb-4">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    strokeWidth={0}
                  >
                    {pieData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#111118",
                      border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: "10px",
                      fontSize: 11,
                      fontFamily: "var(--font-jetbrains)",
                      boxShadow: "0 10px 40px -10px rgba(0,0,0,0.5)",
                    }}
                    formatter={(val: number | undefined) => [val != null ? `${val.toFixed(2)}%` : "—", "Share"]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Holders Table */}
            <div className="space-y-1">
              {/* Table header */}
              <div className="grid grid-cols-[24px_1fr_80px_60px] gap-2 px-2 py-1.5">
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">#</span>
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">Address</span>
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">Balance</span>
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">%</span>
              </div>

              {holders.slice(0, 20).map((holder, i) => (
                <div
                  key={holder.address}
                  className="grid grid-cols-[24px_1fr_80px_60px] gap-2 px-2 py-1.5 rounded-md table-row-hover transition-colors group"
                >
                  <span className="text-[10px] font-mono text-[#6B6B80]">
                    {i + 1}
                  </span>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{
                        backgroundColor:
                          i < 10 ? PIE_COLORS[i] : "#2A2A3A",
                      }}
                    />
                    <a
                      href={getExplorerAddressUrl(chain, holder.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-mono text-[#E8E8ED] hover:text-[#00F0FF] transition-colors truncate"
                    >
                      {holder.label || shortenAddress(holder.address, 4)}
                    </a>
                    <ExternalLink className="h-3 w-3 text-[#6B6B80] opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
                  </div>
                  <span className="text-[11px] font-mono text-[#E8E8ED] text-right truncate">
                    {formatBalance(holder.balance)}
                  </span>
                  <span
                    className="text-[11px] font-mono font-bold text-right"
                    style={{
                      color:
                        holder.percentage >= 10
                          ? "#FF3B5C"
                          : holder.percentage >= 5
                          ? "#FFB800"
                          : "#6B6B80",
                    }}
                  >
                    {holder.percentage.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatBalance(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(1);
}
