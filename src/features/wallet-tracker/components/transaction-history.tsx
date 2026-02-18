"use client";

import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowsLeftRight,
  Repeat,
  Pulse,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyAddress } from "@/components/shared/copy-address";
import { useWalletTransactions } from "@/features/wallet-tracker/hooks/use-wallet-transactions";
import { shortenAddress } from "@/lib/utils";
import { getExplorerTxUrl } from "@/config/chains";
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
  transfer: { icon: ArrowsLeftRight, color: "#00F0FF", label: "TRANSFER" },
  deploy: { icon: Pulse, color: "#00FF88", label: "DEPLOY" },
  approve: { icon: ArrowUpRight, color: "#FFB800", label: "APPROVE" },
  other: { icon: ArrowDownLeft, color: "#6B6B80", label: "OTHER" },
};

const typeFilters: { value: Transaction["type"] | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "swap", label: "Swaps" },
  { value: "transfer", label: "Transfers" },
  { value: "deploy", label: "Deploys" },
];

function formatAmount(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(2)}K`;
  if (abs >= 1) return abs.toFixed(2);
  if (abs >= 0.0001) return abs.toFixed(4);
  return abs.toExponential(2);
}

function formatDateTime(timestamp: number): { date: string; time: string } {
  const d = new Date(timestamp * 1000);
  return {
    date: d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    time: d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }),
  };
}

function TxRow({ tx, chain }: { tx: Transaction; chain: ChainId }) {
  const config = txTypeConfig[tx.type];
  const Icon = config.icon;
  const { date, time } = formatDateTime(tx.timestamp);

  // Determine side colors
  const isBuy = tx.side === "buy";
  const isSell = tx.side === "sell";
  const sideColor = isBuy ? "#00FF88" : isSell ? "#FF3B5C" : "#6B6B80";
  const sideLabel = isBuy ? "BUY" : isSell ? "SELL" : null;
  const SideIcon = isBuy ? ArrowDownLeft : ArrowUpRight;

  // Token display info
  const tokenName = tx.token?.symbol || tx.token?.name || null;
  const tokenAmount = tx.token?.amount ?? 0;
  const showCopy =
    tx.token && !tx.token.isNative && !tx.token.isStablecoin;

  return (
    <div className="flex items-center gap-3 px-3 py-3 rounded-lg table-row-hover transition-colors group">
      {/* Token logo or type icon */}
      <div className="relative shrink-0">
        {tx.token?.logoUrl ? (
          <img
            src={tx.token.logoUrl}
            alt={tokenName ?? ""}
            className="h-9 w-9 rounded-full ring-1 ring-white/[0.06]"
          />
        ) : tx.token && tokenName ? (
          <div className="h-9 w-9 rounded-full bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 flex items-center justify-center text-[10px] font-bold text-[#00F0FF] ring-1 ring-white/[0.06]">
            {tokenName.slice(0, 2).toUpperCase()}
          </div>
        ) : (
          <div
            className="h-9 w-9 rounded-full flex items-center justify-center ring-1 ring-white/[0.06]"
            style={{ backgroundColor: `${config.color}15` }}
          >
            <Icon className="h-4 w-4" style={{ color: config.color }} />
          </div>
        )}
        {/* Buy/sell indicator dot */}
        {sideLabel && (
          <div
            className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#0C0C14] flex items-center justify-center"
            style={{ backgroundColor: sideColor }}
          >
            <SideIcon className="h-2 w-2 text-black" />
          </div>
        )}
      </div>

      {/* Main details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {/* Side label */}
          {sideLabel && (
            <span
              className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
              style={{
                color: sideColor,
                backgroundColor: `${sideColor}15`,
                border: `1px solid ${sideColor}30`,
              }}
            >
              {sideLabel}
            </span>
          )}
          {/* Type label (if no side or different from swap) */}
          {(!sideLabel || tx.type !== "swap") && (
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
          )}
          {/* Token name + copy */}
          {tokenName && (
            <span className="inline-flex items-center gap-1 min-w-0">
              <span
                className="text-[12px] font-mono font-semibold truncate"
                style={{ color: sideLabel ? sideColor : "#E8E8ED" }}
              >
                {tokenName}
              </span>
              {showCopy && <CopyAddress address={tx.token!.address} />}
            </span>
          )}
          {/* Source DEX */}
          {tx.source && tx.type === "swap" && (
            <span className="text-[9px] font-mono text-[#6B6B80]/60 hidden sm:inline">
              via {tx.source}
            </span>
          )}
        </div>

        {/* Description / amount row */}
        <div className="flex items-center gap-2 mt-0.5">
          {tokenAmount > 0 && (
            <span
              className="text-[11px] font-mono font-medium"
              style={{ color: sideLabel ? sideColor : "#E8E8ED" }}
            >
              {isSell ? "-" : isBuy ? "+" : ""}
              {formatAmount(tokenAmount)} {tx.token?.symbol || ""}
            </span>
          )}
          {!tokenAmount && tx.description && (
            <span className="text-[10px] font-mono text-[#6B6B80] truncate max-w-[300px]">
              {tx.description}
            </span>
          )}
          {tx.value > 0 && !tx.token?.isNative && (
            <span className="text-[10px] font-mono text-[#6B6B80]">
              ({formatAmount(tx.value / 1e9)} SOL)
            </span>
          )}
        </div>
      </div>

      {/* Date, time + explorer link */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="text-right">
          <div className="text-[10px] font-mono text-[#E8E8ED]/80">{date}</div>
          <div className="text-[9px] font-mono text-[#6B6B80]">{time}</div>
        </div>
        <a
          href={getExplorerTxUrl(chain, tx.hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#6B6B80] hover:text-[#00F0FF] transition-colors opacity-0 group-hover:opacity-100"
        >
          <ArrowSquareOut className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}

export function TransactionHistory({
  chain,
  address,
}: TransactionHistoryProps) {
  const [typeFilter, setTypeFilter] = useState<Transaction["type"] | "all">(
    "all"
  );
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
          <Pulse className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Transaction History
          </span>
          {txns && txns.length > 0 && (
            <span className="text-[10px] font-mono font-bold text-[#E8E8ED]">
              {txns.length}
            </span>
          )}
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

      <div className="p-2">
        {isLoading ? (
          <div className="space-y-2 p-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3">
                <Skeleton className="h-9 w-9 rounded-full shimmer" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40 shimmer" />
                  <Skeleton className="h-3 w-24 shimmer" />
                </div>
                <Skeleton className="h-8 w-16 shimmer" />
              </div>
            ))}
          </div>
        ) : !txns || txns.length === 0 ? (
          <div className="text-center py-16 text-[#6B6B80]">
            <Pulse className="h-8 w-8 mx-auto mb-3 opacity-20" />
            <p className="text-sm">No transactions found</p>
          </div>
        ) : (
          <div className="space-y-0.5 max-h-[600px] overflow-y-auto scrollbar-thin">
            {txns.map((tx) => (
              <TxRow key={tx.hash} tx={tx} chain={chain} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
