"use client";

import { useQuery } from "@tanstack/react-query";
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
import { shortenAddress, formatTimeAgo } from "@/lib/utils";
import { getExplorerTxUrl } from "@/config/chains";
import type { ChainId } from "@/types/chain";
import type { Transaction } from "@/types/wallet";

interface RecentTransactionsProps {
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

export function RecentTransactions({
  chain,
  address,
}: RecentTransactionsProps) {
  const { data: txns, isLoading } = useQuery<Transaction[]>({
    queryKey: ["token-txns", chain, address],
    queryFn: async () => {
      const res = await fetch(
        `/api/token/${chain}/${address}/transactions`
      );
      if (!res.ok) return [];
      const json = await res.json();
      return json.data ?? [];
    },
    enabled: !!chain && !!address,
    staleTime: 30_000,
  });

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Recent Transactions
          </span>
        </div>
        {txns && txns.length > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="pulse-dot" />
            <span className="text-[10px] font-mono text-[#00FF88]">LIVE</span>
          </div>
        )}
      </div>

      <div className="p-3">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full shimmer rounded-lg" />
            ))}
          </div>
        ) : !txns || txns.length === 0 ? (
          <div className="text-center py-10 text-[#6B6B80]">
            <Activity className="h-6 w-6 mx-auto mb-2 opacity-20" />
            <span className="text-xs">No recent transactions</span>
          </div>
        ) : (
          <div className="space-y-1">
            {txns.slice(0, 20).map((tx) => {
              const config = txTypeConfig[tx.type];
              const Icon = config.icon;
              return (
                <div
                  key={tx.hash}
                  className="flex items-center gap-3 p-2.5 rounded-lg table-row-hover transition-colors group"
                >
                  {/* Type icon */}
                  <div
                    className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${config.color}10` }}
                  >
                    <Icon
                      className="h-3.5 w-3.5"
                      style={{ color: config.color }}
                    />
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
                      {tx.token && (
                        <span className="inline-flex items-center gap-1">
                          <span className="text-[11px] font-mono font-semibold text-[#E8E8ED] truncate">
                            {tx.token.symbol || tx.token.name || "Unknown"}
                          </span>
                          <CopyAddress address={tx.token.address} />
                        </span>
                      )}
                      <span className="text-[10px] font-mono text-[#6B6B80] truncate">
                        {shortenAddress(tx.from, 4)}
                      </span>
                    </div>
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
