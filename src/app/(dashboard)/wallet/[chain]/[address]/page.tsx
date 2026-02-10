"use client";

import { use } from "react";
import { useWalletData } from "@/features/wallet-tracker/hooks/use-wallet-data";
import { WalletPortfolio } from "@/features/wallet-tracker/components/wallet-portfolio";
import { TransactionHistory } from "@/features/wallet-tracker/components/transaction-history";
import { DeployedTokensTable } from "@/features/wallet-tracker/components/deployed-tokens-table";
import { DeployerReputation } from "@/features/wallet-tracker/components/deployer-reputation";
import { AddressDisplay } from "@/components/shared/address-display";
import { ChainBadge } from "@/components/shared/chain-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsd } from "@/lib/utils";
import { Wallet, AlertTriangle, Code } from "lucide-react";
import type { ChainId } from "@/types/chain";

export default function WalletPage({
  params,
}: {
  params: Promise<{ chain: string; address: string }>;
}) {
  const { chain, address } = use(params);
  const { data: wallet, isLoading, error } = useWalletData(
    chain as ChainId,
    address
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="glow-card rounded-xl p-5">
          <div className="flex items-center gap-4">
            <Skeleton className="h-12 w-12 rounded-xl shimmer" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-48 shimmer" />
              <Skeleton className="h-3.5 w-32 shimmer" />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="glow-card stat-card rounded-xl p-4">
              <Skeleton className="h-3 w-16 mb-3 shimmer" />
              <Skeleton className="h-5 w-24 shimmer" />
            </div>
          ))}
        </div>
        <Skeleton className="h-[300px] w-full rounded-xl shimmer" />
      </div>
    );
  }

  if (error || !wallet) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-[#6B6B80]">
        <div className="h-16 w-16 rounded-2xl bg-[#FF3B5C]/10 border border-[#FF3B5C]/20 flex items-center justify-center mb-6">
          <AlertTriangle className="h-7 w-7 text-[#FF3B5C]" />
        </div>
        <h2 className="text-lg font-bold text-[#E8E8ED] mb-2">Wallet Not Found</h2>
        <p className="text-sm text-center max-w-md">
          Could not load data for{" "}
          <span className="font-mono text-[#00F0FF]">{address.slice(0, 8)}...{address.slice(-6)}</span>{" "}
          on <span className="capitalize text-[#E8E8ED]">{chain}</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Wallet Header */}
      <div className="glow-card rounded-xl p-5 animate-fade-up">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 flex items-center justify-center ring-1 ring-white/[0.06]">
              <Wallet className="h-6 w-6 text-[#00F0FF]" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-lg font-bold text-[#E8E8ED]">Wallet</h1>
                <ChainBadge chain={chain as ChainId} />
                {wallet.isDeployer && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold text-[#A855F7] px-1.5 py-0.5 rounded bg-[#A855F7]/10 border border-[#A855F7]/20">
                    <Code className="h-3 w-3" />
                    DEPLOYER
                  </span>
                )}
              </div>
              <div className="mt-1">
                <AddressDisplay address={address} chain={chain as ChainId} chars={8} />
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className="text-[10px] font-mono uppercase tracking-wider text-[#6B6B80] mb-1">
              Total Value
            </div>
            <div className="text-3xl font-bold font-mono text-[#E8E8ED]">
              {formatUsd(wallet.totalPortfolioUsd)}
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "TOKENS", value: wallet.tokens.length.toString(), color: "#00F0FF" },
          { label: "PORTFOLIO", value: formatUsd(wallet.totalPortfolioUsd), color: "#00FF88" },
          { label: "DEPLOYED", value: wallet.deployedTokens.length.toString(), color: "#A855F7" },
          {
            label: "DEPLOYER GRADE",
            value: wallet.deployerScore?.grade ?? "--",
            color: wallet.deployerScore ? gradeColor(wallet.deployerScore.grade) : "#6B6B80",
          },
        ].map((stat, i) => (
          <div
            key={stat.label}
            className={`glow-card stat-card rounded-xl p-4 animate-fade-up stagger-${i + 1}`}
          >
            <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6B6B80] mb-2">
              {stat.label}
            </div>
            <div
              className="text-xl font-bold font-mono"
              style={{ color: stat.color }}
            >
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Portfolio — 2 cols */}
        <div className="lg:col-span-2">
          <WalletPortfolio
            tokens={wallet.tokens}
            totalUsd={wallet.totalPortfolioUsd}
            chain={chain as ChainId}
          />
        </div>

        {/* Sidebar — 1 col */}
        <div className="space-y-6">
          {wallet.deployerScore && (
            <DeployerReputation score={wallet.deployerScore} />
          )}
        </div>
      </div>

      {/* Deployed tokens */}
      {wallet.deployedTokens.length > 0 && (
        <DeployedTokensTable
          tokens={wallet.deployedTokens}
          chain={chain as ChainId}
        />
      )}

      {/* Transaction history */}
      <TransactionHistory chain={chain as ChainId} address={address} />
    </div>
  );
}

function gradeColor(grade: string): string {
  switch (grade) {
    case "A": return "#00FF88";
    case "B": return "#00D4AA";
    case "C": return "#FFB800";
    case "D": return "#FF8C42";
    case "F": return "#FF3B5C";
    default: return "#6B6B80";
  }
}
