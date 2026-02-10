"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { PriceChange } from "@/components/shared/price-change";
import { ChainBadge } from "@/components/shared/chain-badge";
import { useChain } from "@/providers/chain-provider";
import { formatUsd, shortenAddress } from "@/lib/utils";
import { TrendingUp, Zap, BarChart3, ArrowRight, Activity } from "lucide-react";
import type { TrendingToken } from "@/types/token";
import type { ChainId } from "@/types/chain";

function useTrending() {
  const { activeChain } = useChain();
  return useQuery<TrendingToken[]>({
    queryKey: ["trending", activeChain],
    queryFn: async () => {
      const res = await fetch(`/api/trending?chain=${activeChain}`);
      const json = await res.json();
      return json.data || [];
    },
    refetchInterval: 60_000,
  });
}

export default function TrendingPage() {
  const { data: tokens, isLoading } = useTrending();

  const topGainer = tokens?.length
    ? [...tokens].sort((a, b) => (b.priceChange24h ?? 0) - (a.priceChange24h ?? 0))[0]
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-up">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#00F0FF]/20 to-[#00F0FF]/5 border border-[#00F0FF]/10 flex items-center justify-center">
            <TrendingUp className="h-5 w-5 text-[#00F0FF]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Trending Tokens
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <Activity className="h-3 w-3 text-[#00FF88]" />
              <span className="text-xs font-mono text-[#6B6B80]">
                Updated every 60s
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          {
            label: "TRENDING",
            value: tokens?.length ?? "—",
            icon: TrendingUp,
            color: "#00F0FF",
          },
          {
            label: "TOP VOLUME",
            value: tokens?.[0] ? formatUsd(tokens[0].volume24h) : "—",
            icon: BarChart3,
            color: "#A855F7",
          },
          {
            label: "TOP GAINER",
            value: topGainer ? (
              <PriceChange value={topGainer.priceChange24h} className="text-xl" />
            ) : "—",
            icon: Zap,
            color: "#00FF88",
          },
        ].map((stat, i) => (
          <div
            key={stat.label}
            className={`glow-card stat-card rounded-xl p-4 animate-fade-up stagger-${i + 1}`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
                {stat.label}
              </span>
              <stat.icon
                className="h-4 w-4"
                style={{ color: stat.color, opacity: 0.5 }}
              />
            </div>
            <div className="text-2xl font-bold font-mono">{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="glow-card rounded-xl overflow-hidden animate-fade-up stagger-4">
        {/* Table header */}
        <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Hot Tokens
          </span>
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-[#00FF88] pulse-dot" />
            <span className="text-[10px] font-mono text-[#00FF88]/70">LIVE</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.04]">
                {["#", "Token", "Chain", "Price", "24h", "Volume", "Liquidity", ""].map(
                  (h) => (
                    <th
                      key={h}
                      className={`text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80] px-5 py-3 ${
                        ["Price", "24h", "Volume", "Liquidity", ""].includes(h)
                          ? "text-right"
                          : "text-left"
                      }`}
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-white/[0.03]">
                      <td className="px-5 py-3.5">
                        <Skeleton className="h-4 w-5 shimmer" />
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-8 w-8 rounded-full shimmer" />
                          <div className="space-y-1.5">
                            <Skeleton className="h-3.5 w-20 shimmer" />
                            <Skeleton className="h-2.5 w-28 shimmer" />
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5"><Skeleton className="h-5 w-14 shimmer" /></td>
                      <td className="px-5 py-3.5"><Skeleton className="h-4 w-16 ml-auto shimmer" /></td>
                      <td className="px-5 py-3.5"><Skeleton className="h-4 w-14 ml-auto shimmer" /></td>
                      <td className="px-5 py-3.5"><Skeleton className="h-4 w-16 ml-auto shimmer" /></td>
                      <td className="px-5 py-3.5"><Skeleton className="h-4 w-16 ml-auto shimmer" /></td>
                      <td className="px-5 py-3.5"><Skeleton className="h-4 w-4 ml-auto shimmer" /></td>
                    </tr>
                  ))
                : tokens?.map((token, i) => (
                    <tr
                      key={`${token.chain}:${token.address}`}
                      className="border-b border-white/[0.03] table-row-hover group"
                    >
                      <td className="px-5 py-3.5">
                        <span className="text-xs font-mono text-[#6B6B80]">
                          {token.rank}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <Link
                          href={`/token/${token.chain}/${token.address}`}
                          className="flex items-center gap-3"
                        >
                          {token.logoUrl ? (
                            <img
                              src={token.logoUrl}
                              alt={token.symbol}
                              className="h-8 w-8 rounded-full ring-1 ring-white/[0.06]"
                            />
                          ) : (
                            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[#00F0FF]/15 to-[#A855F7]/15 flex items-center justify-center text-[10px] font-bold text-[#00F0FF] ring-1 ring-white/[0.06]">
                              {token.symbol.slice(0, 2)}
                            </div>
                          )}
                          <div>
                            <span className="font-semibold text-sm text-[#E8E8ED] group-hover:text-[#00F0FF] transition-colors">
                              {token.symbol}
                            </span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] text-[#6B6B80] truncate max-w-[120px]">
                                {token.name}
                              </span>
                              <span className="text-[10px] font-mono text-[#6B6B80]/50">
                                {shortenAddress(token.address)}
                              </span>
                            </div>
                          </div>
                        </Link>
                      </td>
                      <td className="px-5 py-3.5">
                        <ChainBadge chain={token.chain as ChainId} />
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <span className="text-sm font-mono font-medium text-[#E8E8ED]">
                          {formatUsd(token.priceUsd)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <PriceChange value={token.priceChange24h} className="text-sm" />
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <span className="text-sm font-mono text-[#6B6B80]">
                          {formatUsd(token.volume24h)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <span className="text-sm font-mono text-[#6B6B80]">
                          {formatUsd(token.liquidity)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <ArrowRight className="h-3.5 w-3.5 text-[#6B6B80]/0 group-hover:text-[#00F0FF]/50 transition-all ml-auto" />
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        {!isLoading && (!tokens || tokens.length === 0) && (
          <div className="text-center py-16 text-[#6B6B80]">
            <TrendingUp className="h-8 w-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No trending tokens found</p>
            <p className="text-xs mt-1 opacity-60">Data refreshes every 60 seconds</p>
          </div>
        )}
      </div>
    </div>
  );
}
