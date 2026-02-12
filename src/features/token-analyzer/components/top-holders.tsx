"use client";

import { Users, ExternalLink } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { useTokenHolders } from "@/features/token-analyzer/hooks/use-token-holders";
import { useWalletDialog } from "@/providers/wallet-dialog-provider";
import { shortenAddress } from "@/lib/utils";
import { getExplorerAddressUrl } from "@/config/chains";
import type { ChainId } from "@/types/chain";

interface TopHoldersProps {
  chain: ChainId;
  address: string;
  priceUsd?: number | null;
  liquidityUsd?: number | null;
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

type HolderTier = "whale" | "dolphin" | "fish" | "crab" | "shrimp" | "lp";

interface TierInfo {
  label: string;
  emoji: string;
  color: string;
}

const TIER_MAP: Record<HolderTier, TierInfo> = {
  lp:      { label: "Liquidity Pool", emoji: "\uD83D\uDCA7", color: "#0080FF" },
  whale:   { label: "Whale",          emoji: "\uD83D\uDC0B", color: "#00F0FF" },
  dolphin: { label: "Dolphin",        emoji: "\uD83D\uDC2C", color: "#A855F7" },
  fish:    { label: "Fish",           emoji: "\uD83D\uDC1F", color: "#00FF88" },
  crab:    { label: "Crab",           emoji: "\uD83E\uDD80", color: "#FFB800" },
  shrimp:  { label: "Shrimp",         emoji: "\uD83E\uDD90", color: "#FF3B5C" },
};

function getHolderTier(valueUsd: number): HolderTier {
  if (valueUsd >= 10_000) return "whale";
  if (valueUsd >= 5_000) return "dolphin";
  if (valueUsd >= 1_000) return "fish";
  if (valueUsd >= 500) return "crab";
  return "shrimp";
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function isLikelyLP(
  balance: number,
  priceUsd: number | null | undefined,
  liquidityUsd: number | null | undefined
): boolean {
  if (!priceUsd || !liquidityUsd || liquidityUsd <= 0) return false;
  // Liquidity pools typically hold roughly half the total liquidity in the base token
  const holderValueUsd = balance * priceUsd;
  const lpTokenSide = liquidityUsd / 2;
  // Match if holder value is within 20% of the expected LP token-side value
  return (
    lpTokenSide > 0 &&
    Math.abs(holderValueUsd - lpTokenSide) / lpTokenSide < 0.2
  );
}

export function TopHolders({ chain, address, priceUsd, liquidityUsd }: TopHoldersProps) {
  const { data: holders, isLoading } = useTokenHolders(chain, address);
  const { openWalletDialog } = useWalletDialog();

  const allHolders = holders || [];

  // Classify each holder
  const classified = allHolders.map((h) => {
    const isLP = isLikelyLP(h.balance, priceUsd, liquidityUsd);
    const valueUsd = priceUsd ? h.balance * priceUsd : 0;
    const tier: HolderTier = isLP ? "lp" : getHolderTier(valueUsd);
    return { ...h, tier, valueUsd };
  });

  const top10 = classified.slice(0, 10);
  const top10Pct = top10.reduce((sum, h) => sum + h.percentage, 0);
  const otherPct = Math.max(0, 100 - top10Pct);

  // Count holders by tier
  const tierCounts = classified.reduce(
    (acc, h) => {
      acc[h.tier] = (acc[h.tier] || 0) + 1;
      return acc;
    },
    {} as Record<HolderTier, number>
  );

  const pieData = [
    ...top10.map((h, i) => {
      const tierInfo = TIER_MAP[h.tier];
      return {
        name: h.label || shortenAddress(h.address, 4),
        value: parseFloat(h.percentage.toFixed(2)),
        color: PIE_COLORS[i % PIE_COLORS.length],
        tier: `${tierInfo.emoji} ${tierInfo.label}`,
        valueUsd: h.valueUsd,
      };
    }),
    ...(otherPct > 0
      ? [{
          name: "Others",
          value: parseFloat(otherPct.toFixed(2)),
          color: "#2A2A3A",
          tier: "",
          valueUsd: 0,
        }]
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
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const entry = payload[0].payload;
                      return (
                        <div
                          className="rounded-lg px-3 py-2 text-[11px] font-mono"
                          style={{
                            backgroundColor: "#111118",
                            border: "1px solid rgba(255,255,255,0.08)",
                            boxShadow: "0 10px 40px -10px rgba(0,0,0,0.5)",
                            color: "#E8E8ED",
                          }}
                        >
                          <div className="font-semibold mb-1">{entry.name}</div>
                          <div className="text-[#6B6B80]">
                            Share: <span className="text-[#E8E8ED]">{entry.value.toFixed(2)}%</span>
                          </div>
                          {entry.tier && (
                            <div className="text-[#6B6B80]">
                              Type: <span className="text-[#E8E8ED]">{entry.tier}</span>
                            </div>
                          )}
                          {entry.valueUsd > 0 && (
                            <div className="text-[#6B6B80]">
                              Value: <span className="text-[#E8E8ED]">{formatUsd(entry.valueUsd)}</span>
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Tier Distribution */}
            <div className="flex flex-wrap gap-2 mb-4">
              {(Object.keys(TIER_MAP) as HolderTier[]).map((tier) => {
                const count = tierCounts[tier] || 0;
                if (count === 0) return null;
                const info = TIER_MAP[tier];
                return (
                  <div
                    key={tier}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/[0.03] border border-white/[0.06]"
                  >
                    <span className="text-[11px]">{info.emoji}</span>
                    <span
                      className="text-[10px] font-mono font-semibold"
                      style={{ color: info.color }}
                    >
                      {count}
                    </span>
                    <span className="text-[9px] font-mono text-[#6B6B80]">
                      {info.label}{count !== 1 ? "s" : ""}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Holders Table */}
            <div className="space-y-1">
              {/* Table header */}
              <div className="grid grid-cols-[24px_20px_1fr_80px_60px] gap-2 px-2 py-1.5">
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">#</span>
                <span />
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">Address</span>
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">Balance</span>
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">%</span>
              </div>

              <div className="max-h-[600px] overflow-y-auto scrollbar-thin">
                {classified.slice(0, 50).map((holder, i) => {
                  const tierInfo = TIER_MAP[holder.tier];
                  return (
                    <div
                      key={holder.address}
                      className="grid grid-cols-[24px_20px_1fr_80px_60px] gap-2 px-2 py-1.5 rounded-md table-row-hover transition-colors group"
                    >
                      <span className="text-[10px] font-mono text-[#6B6B80]">
                        {i + 1}
                      </span>
                      <span
                        className="text-[11px] leading-none"
                        title={tierInfo.label}
                      >
                        {tierInfo.emoji}
                      </span>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{
                            backgroundColor:
                              i < 10 ? PIE_COLORS[i] : "#2A2A3A",
                          }}
                        />
                        <button
                          onClick={() => openWalletDialog(holder.address, chain)}
                          className="text-[11px] font-mono text-[#E8E8ED] hover:text-[#00F0FF] transition-colors truncate"
                        >
                          {holder.label || shortenAddress(holder.address, 4)}
                        </button>
                        <a
                          href={getExplorerAddressUrl(chain, holder.address)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-[#6B6B80] opacity-0 group-hover:opacity-50 transition-opacity shrink-0"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                      <span className="text-[11px] font-mono text-[#E8E8ED] text-right truncate">
                        {formatBalance(holder.balance)}
                      </span>
                      <span
                        className="text-[11px] font-mono font-bold text-right"
                        style={{ color: tierInfo.color }}
                      >
                        {holder.percentage.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
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
