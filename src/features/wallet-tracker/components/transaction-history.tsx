"use client";

import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  Repeat,
  Activity,
  ExternalLink,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyAddress } from "@/components/shared/copy-address";
import { useWalletTransactions } from "@/features/wallet-tracker/hooks/use-wallet-transactions";
import { shortenAddress, formatTimeAgo } from "@/lib/utils";
import { getExplorerTxUrl, getExplorerAddressUrl } from "@/config/chains";
import { cn } from "@/lib/utils";
import type { ChainId } from "@/types/chain";
import type { Transaction } from "@/types/wallet";

interface TransactionHistoryProps {
  chain: ChainId;
  address: string;
}

const txTypeConfig: Record<
  Transaction["type"],
  { icon: typeof ArrowUpRight; color: string; label: string }
> = {
  swap: { icon: Repeat, color: "#A855F7", label: "SWAP" },
  transfer: { icon: ArrowLeftRight, color: "#00F0FF", label: "TRANSFER" },
  deploy: { icon: Activity, color: "#00FF88", label: "DEPLOY" },
  approve: { icon: ArrowUpRight, color: "#FFB800", label: "APPROVE" },
  other: { icon: ArrowDownLeft, color: "#6B6B80", label: "OTHER" },
};

const typeFilters: { value: Transaction["type"] | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "swap", label: "Swaps" },
  { value: "transfer", label: "Transfers" },
  { value: "deploy", label: "Deploys" },
];

export function TransactionHistory({ chain, address }: TransactionHistoryProps) {
  const [typeFilter, setTypeFilter] = useState<Transaction["type"] | "all">("all");
  const { data: txns, isLoading } = useWalletTransactions(
    chain,
    address,
    typeFilter === "all" ? undefined : typeFilter
  );

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Transaction History
          </span>
        </div>
        {/* Type filter pills */}
        <div className="flex gap-0.5 bg-white/[0.03] rounded-lg p-0.5">
          {typeFilters.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setTypeFilter(filter.value)}
              className={cn(
                "px-2 py-1 text-[10px] font-mono font-semibold rounded-md transition-all",
                typeFilter === filter.value
                  ? "bg-[#00F0FF]/10 text-[#00F0FF]"
                  : "text-[#6B6B80] hover:text-[#E8E8ED]"
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-3">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full shimmer rounded-lg" />
            ))}
          </div>
        ) : !txns || txns.length === 0 ? (
          <div className="text-center py-16 text-[#6B6B80]">
            <Activity className="h-8 w-8 mx-auto mb-3 opacity-20" />
            <p className="text-sm">No transactions found</p>
          </div>
        ) : (
          <div className="space-y-1">
            {txns.map((tx) => {
              const config = txTypeConfig[tx.type];
              const Icon = config.icon;
              return (
                <div
                  key={tx.hash}
                  className="flex items-center gap-3 p-2.5 rounded-lg table-row-hover transition-colors group"
                >
                  {/* Type icon */}
                  <div
                    className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${config.color}10` }}
                  >
                    <Icon className="h-4 w-4" style={{ color: config.color }} />
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
                        style={{
                          color: config.color,
                          backgroundColor: `${config.color}15`,
                          border: `1px solid ${config.color}30`,
                        }}
                      >
                        {config.label}
                      </span>
                      <a
                        href={getExplorerAddressUrl(chain, tx.from)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] font-mono text-[#6B6B80] hover:text-[#00F0FF] transition-colors"
                      >
                        {shortenAddress(tx.from, 4)}
                      </a>
                      <span className="text-[10px] text-[#6B6B80]">→</span>
                      <a
                        href={getExplorerAddressUrl(chain, tx.to)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] font-mono text-[#6B6B80] hover:text-[#00F0FF] transition-colors"
                      >
                        {shortenAddress(tx.to, 4)}
                      </a>
                    </div>
                    {tx.token && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono text-[#6B6B80]/60">
                        <span>{tx.token.symbol || tx.token.name || "Unknown"}</span>
                        <CopyAddress address={tx.token.address} />
                      </span>
                    )}
                  </div>

                  {/* Time + link */}
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] font-mono text-[#6B6B80]">
                      {formatTimeAgo(tx.timestamp)}
                    </span>
                    <a
                      href={getExplorerTxUrl(chain, tx.hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#6B6B80] hover:text-[#00F0FF] transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
