"use client";

import { use } from "react";
import { useTokenData } from "@/features/token-analyzer/hooks/use-token-data";
import { TokenHeader } from "@/features/token-analyzer/components/token-header";
import { TokenStatsGrid } from "@/features/token-analyzer/components/token-stats-grid";
import { CandlestickChart } from "@/features/token-analyzer/components/candlestick-chart";
import { ContractSafety } from "@/features/token-analyzer/components/contract-safety";
import { LiquidityPools } from "@/features/token-analyzer/components/liquidity-pools";
import { TopHolders } from "@/features/token-analyzer/components/top-holders";
import { RecentTransactions } from "@/features/token-analyzer/components/recent-transactions";
import { DDScoreCard } from "@/features/token-analyzer/components/dd-score-card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle } from "lucide-react";
import type { ChainId } from "@/types/chain";

export default function TokenPage({
  params,
}: {
  params: Promise<{ chain: string; address: string }>;
}) {
  const { chain, address } = use(params);
  const { data: token, isLoading, error } = useTokenData(
    chain as ChainId,
    address
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {/* Header skeleton */}
        <div className="glow-card rounded-xl p-5">
          <div className="flex items-center gap-4">
            <Skeleton className="h-12 w-12 rounded-xl shimmer" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-48 shimmer" />
              <Skeleton className="h-3.5 w-32 shimmer" />
            </div>
          </div>
        </div>
        {/* Stats skeleton */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glow-card stat-card rounded-xl p-4">
              <Skeleton className="h-3 w-16 mb-3 shimmer" />
              <Skeleton className="h-5 w-24 shimmer" />
            </div>
          ))}
        </div>
        {/* Chart skeleton */}
        <Skeleton className="h-[420px] w-full rounded-xl shimmer" />
      </div>
    );
  }

  if (error || !token) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-[#6B6B80]">
        <div className="h-16 w-16 rounded-2xl bg-[#FF3B5C]/10 border border-[#FF3B5C]/20 flex items-center justify-center mb-6">
          <AlertTriangle className="h-7 w-7 text-[#FF3B5C]" />
        </div>
        <h2 className="text-lg font-bold text-[#E8E8ED] mb-2">Token Not Found</h2>
        <p className="text-sm text-center max-w-md">
          Could not find data for{" "}
          <span className="font-mono text-[#00F0FF]">{address.slice(0, 8)}...{address.slice(-6)}</span>{" "}
          on <span className="capitalize text-[#E8E8ED]">{chain}</span>.
        </p>
        <p className="text-xs mt-3 opacity-50">
          Verify the address is correct and the token has trading activity.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TokenHeader token={token} />

      <TokenStatsGrid token={token} />

      {/* Main content: chart + sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart — 2 cols */}
        <div className="lg:col-span-2">
          <CandlestickChart chain={token.chain} address={token.address} marketCap={token.marketCap} priceUsd={token.priceUsd} />
        </div>

        {/* Sidebar panels — 1 col */}
        <div className="space-y-6">
          {token.ddScore && (
            <DDScoreCard score={token.ddScore} />
          )}
          {token.safetySignals && (
            <ContractSafety signals={token.safetySignals} />
          )}
        </div>
      </div>

      {/* Bottom row: holders + liquidity + transactions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <TopHolders chain={token.chain} address={token.address} />
        </div>
        <div className="lg:col-span-1">
          {token.liquidity && (
            <LiquidityPools liquidity={token.liquidity} />
          )}
        </div>
        <div className="lg:col-span-1">
          <RecentTransactions chain={token.chain} address={token.address} />
        </div>
      </div>
    </div>
  );
}
