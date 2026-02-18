"use client";

import { useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretUp,
  Users,
  MagnifyingGlass as SearchIcon,
  CurrencyDollarSimple,
  Coins,
} from "@phosphor-icons/react";
import { shortenAddress, chainLabel } from "@/lib/utils";
import { getExplorerAddressUrl } from "@/config/chains";
import { useWalletDialog } from "@/providers/wallet-dialog-provider";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useTradeHistory,
  type TradeHistoryInput,
} from "@/features/common-traders/hooks/use-trade-history";
import {
  TradeHistoryDetail,
  type DisplayCurrency,
} from "@/features/common-traders/components/trade-history-detail";
import type { CommonTrader, TokenMeta } from "@/types/traders";
import type { ChainId } from "@/types/chain";

interface CommonTradersTableProps {
  traders: CommonTrader[];
  tokensMeta: TokenMeta[];
  isLoading: boolean;
  displayCurrency: DisplayCurrency;
  onToggleCurrency: () => void;
}

function formatUsdCompact(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

function formatBalance(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(1);
}

function getWalletChain(trader: CommonTrader): ChainId {
  return trader.tokens[0]?.chain ?? "solana";
}

function TraderRow({
  trader,
  index,
  tokensMeta,
  isExpanded,
  onToggle,
  displayCurrency,
}: {
  trader: CommonTrader;
  index: number;
  tokensMeta: TokenMeta[];
  isExpanded: boolean;
  onToggle: () => void;
  displayCurrency: DisplayCurrency;
}) {
  const chain = getWalletChain(trader);
  const { openWalletDialog } = useWalletDialog();

  // Build trade history input only when expanded
  const historyInput: TradeHistoryInput | null = isExpanded
    ? {
        walletAddress: trader.walletAddress,
        tokens: trader.tokens.map((t) => {
          const meta = tokensMeta.find(
            (m) => m.address === t.address && m.chain === t.chain
          );
          return {
            chain: t.chain,
            address: t.address,
            symbol: t.symbol,
            currentBalance: t.balance,
            priceUsd: meta?.priceUsd ?? null,
          };
        }),
      }
    : null;

  const {
    data: history,
    isLoading: historyLoading,
    error: historyError,
  } = useTradeHistory(historyInput);

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full grid grid-cols-[40px_1fr_80px_100px_40px] gap-2 px-4 py-2.5 table-row-hover transition-colors group text-left"
      >
        <span className="text-[11px] font-mono text-[#6B6B80]">
          {index + 1}
        </span>
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openWalletDialog(trader.walletAddress, chain);
            }}
            className="text-[11px] font-mono text-[#E8E8ED] hover:text-[#00F0FF] transition-colors truncate"
          >
            {shortenAddress(trader.walletAddress, 6)}
          </button>
          <a
            href={getExplorerAddressUrl(chain, trader.walletAddress)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-[#6B6B80] opacity-0 group-hover:opacity-50 transition-opacity shrink-0"
          >
            <ArrowSquareOut className="h-3 w-3" />
          </a>
        </div>
        <div className="flex items-center justify-center gap-1">
          <span className="text-[11px] font-mono font-bold text-[#00F0FF]">
            {trader.tokenCount}
          </span>
          <span className="text-[10px] font-mono text-[#6B6B80]">
            / {tokensMeta.length}
          </span>
        </div>
        <span className="text-[11px] font-mono font-semibold text-[#E8E8ED] text-right">
          {trader.totalValueUsd > 0
            ? formatUsdCompact(trader.totalValueUsd)
            : "\u2014"}
        </span>
        <div className="flex items-center justify-center">
          {isExpanded ? (
            <CaretUp className="h-3.5 w-3.5 text-[#6B6B80]" />
          ) : (
            <CaretDown className="h-3.5 w-3.5 text-[#6B6B80]" />
          )}
        </div>
      </button>

      {/* Expanded row */}
      {isExpanded && (
        <div className="px-4 pb-3 pl-14">
          <div className="rounded-lg bg-white/[0.02] border border-white/[0.04]">
            {/* Per-token balance summary */}
            <div className="divide-y divide-white/[0.04]">
              {trader.tokens.map((t) => (
                <div
                  key={`${t.chain}:${t.address}`}
                  className="flex items-center justify-between px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono font-semibold text-[#E8E8ED]">
                      {t.symbol}
                    </span>
                    <span className="text-[10px] font-mono uppercase tracking-wider text-[#00F0FF]/60">
                      {chainLabel(t.chain)}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] font-mono text-[#6B6B80]">
                      {formatBalance(t.balance)}
                    </span>
                    <span className="text-[10px] font-mono text-[#A855F7] font-semibold">
                      {t.percentage.toFixed(1)}%
                    </span>
                    <span className="text-[10px] font-mono text-[#E8E8ED] w-16 text-right">
                      {t.balanceUsd > 0
                        ? formatUsdCompact(t.balanceUsd)
                        : "\u2014"}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Trade history detail */}
            <div className="px-3 py-2">
              <TradeHistoryDetail
                tokenHistories={history?.tokenHistories ?? []}
                displayCurrency={displayCurrency}
                isLoading={historyLoading}
                error={historyError ? historyError.message : null}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function CommonTradersTable({
  traders,
  tokensMeta,
  isLoading,
  displayCurrency,
  onToggleCurrency,
}: CommonTradersTableProps) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"tokens" | "value">("tokens");

  if (isLoading) {
    return (
      <div className="glow-card rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-white/[0.04] flex items-center gap-2">
          <Users className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Common Traders
          </span>
        </div>
        <div className="p-4 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full shimmer rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (traders.length === 0) {
    return (
      <div className="glow-card rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-white/[0.04] flex items-center gap-2">
          <Users className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Common Traders
          </span>
        </div>
        <div className="text-center py-14 text-[#6B6B80]">
          <SearchIcon className="h-8 w-8 mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium text-[#E8E8ED]/60">
            No common holders found
          </p>
          <p className="text-xs mt-1 opacity-50">
            These tokens don&apos;t share any top holders
          </p>
        </div>
      </div>
    );
  }

  const sorted = [...traders].sort((a, b) => {
    if (sortBy === "tokens") {
      if (b.tokenCount !== a.tokenCount) return b.tokenCount - a.tokenCount;
      return b.totalValueUsd - a.totalValueUsd;
    }
    return b.totalValueUsd - a.totalValueUsd;
  });

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Common Traders
          </span>
          <span className="text-[10px] font-mono font-bold text-[#E8E8ED] ml-2">
            {traders.length} found
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSortBy("tokens")}
            className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${
              sortBy === "tokens"
                ? "bg-[#00F0FF]/10 text-[#00F0FF]"
                : "text-[#6B6B80] hover:text-[#E8E8ED]"
            }`}
          >
            By Tokens
          </button>
          <button
            onClick={() => setSortBy("value")}
            className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${
              sortBy === "value"
                ? "bg-[#00F0FF]/10 text-[#00F0FF]"
                : "text-[#6B6B80] hover:text-[#E8E8ED]"
            }`}
          >
            By Value
          </button>
          <div className="w-px h-4 bg-white/[0.06] mx-1" />
          <button
            onClick={onToggleCurrency}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono transition-colors ${
              displayCurrency === "usd"
                ? "bg-[#A855F7]/10 text-[#A855F7]"
                : "bg-[#00FF88]/10 text-[#00FF88]"
            }`}
          >
            {displayCurrency === "usd" ? (
              <CurrencyDollarSimple className="h-3 w-3" />
            ) : (
              <Coins className="h-3 w-3" />
            )}
            {displayCurrency === "usd" ? "USD" : "Token"}
          </button>
        </div>
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[40px_1fr_80px_100px_40px] gap-2 px-4 py-2 border-b border-white/[0.04]">
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">
          #
        </span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">
          Wallet
        </span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-center">
          Tokens
        </span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">
          Total Value
        </span>
        <span />
      </div>

      {/* Rows */}
      <div className="max-h-[600px] overflow-y-auto scrollbar-thin">
        {sorted.map((trader, i) => (
          <TraderRow
            key={trader.walletAddress}
            trader={trader}
            index={i}
            tokensMeta={tokensMeta}
            isExpanded={expandedRow === trader.walletAddress}
            onToggle={() =>
              setExpandedRow(
                expandedRow === trader.walletAddress
                  ? null
                  : trader.walletAddress
              )
            }
            displayCurrency={displayCurrency}
          />
        ))}
      </div>
    </div>
  );
}
