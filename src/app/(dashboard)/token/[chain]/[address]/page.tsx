"use client";

import { use } from "react";
import { useTokenData } from "@/features/token-analyzer/hooks/use-token-data";
import { TokenHeader } from "@/features/token-analyzer/components/token-header";
import { TokenStatsGrid } from "@/features/token-analyzer/components/token-stats-grid";
import { PriceChart } from "@/features/token-analyzer/components/price-chart";
import { ContractSafety } from "@/features/token-analyzer/components/contract-safety";
import { LiquidityPools } from "@/features/token-analyzer/components/liquidity-pools";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Scan } from "lucide-react";
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
        <Skeleton className="h-[360px] w-full rounded-xl shimmer" />
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart — 2 cols */}
        <div className="lg:col-span-2">
          <PriceChart chain={token.chain} address={token.address} />
        </div>

        {/* Sidebar panels — 1 col */}
        <div className="space-y-6">
          {token.safetySignals && (
            <ContractSafety signals={token.safetySignals} />
          )}
          {token.liquidity && (
            <LiquidityPools liquidity={token.liquidity} />
          )}
        </div>
      </div>
    </div>
  );
}
