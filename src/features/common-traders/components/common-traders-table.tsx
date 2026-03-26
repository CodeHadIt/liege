"use client";

import { useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretUp,
  Users,
  MagnifyingGlass as SearchIcon,
  Copy,
} from "@phosphor-icons/react";
import { shortenAddress, chainLabel } from "@/lib/utils";
import { getExplorerAddressUrl } from "@/config/chains";
import { useWalletDialog } from "@/providers/wallet-dialog-provider";
import { useToast } from "@/providers/toast-provider";
import { Skeleton } from "@/components/ui/skeleton";
import type { CommonTrader, TokenMeta } from "@/types/traders";
import type { ChainId } from "@/types/chain";

interface CommonTradersTableProps {
  traders: CommonTrader[];
  tokensMeta: TokenMeta[];
  isLoading: boolean;
}

function formatUsdCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Convert an avg buy/sell price to an implied market cap.
 * Formula: entryMC = avgPrice / currentPrice * currentMC
 * Returns null if any required value is missing.
 */
function priceToMC(
  avgPrice: number,
  currentPrice: number | null,
  currentMC: number | null
): number | null {
  if (!avgPrice || !currentPrice || !currentMC || currentPrice <= 0) return null;
  return (avgPrice / currentPrice) * currentMC;
}

function getWalletChain(trader: CommonTrader): ChainId {
  return trader.tokens[0]?.chain ?? "solana";
}

function pnlColor(value: number): string {
  if (value > 0) return "text-[#00FF88]";
  if (value < 0) return "text-[#FF4444]";
  return "text-[#6B6B80]";
}

function TraderRow({
  trader,
  index,
  tokensMeta,
  isExpanded,
  onToggle,
}: {
  trader: CommonTrader;
  index: number;
  tokensMeta: TokenMeta[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const chain = getWalletChain(trader);
  const { openWalletDialog } = useWalletDialog();
  const showToast = useToast();

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
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(trader.walletAddress);
              showToast("Address copied");
            }}
            className="text-[#6B6B80] opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity shrink-0"
            title="Copy address"
          >
            <Copy className="h-3 w-3" />
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
            / {trader.tokens.length}
          </span>
        </div>
        <span
          className={`text-[11px] font-mono font-semibold text-right ${pnlColor(trader.totalPnlUsd)}`}
        >
          {trader.totalPnlUsd !== 0
            ? `${trader.totalPnlUsd > 0 ? "+" : ""}${formatUsdCompact(trader.totalPnlUsd)}`
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
          <div className="rounded-xl overflow-hidden border border-white/[0.06]">
            {trader.tokens.map((t, idx) => {
              const meta = tokensMeta.find(
                (m) => m.address.toLowerCase() === t.address.toLowerCase() && m.chain === t.chain
              );
              const entryBuyMC = t.avgBuyPrice
                ? priceToMC(t.avgBuyPrice, meta?.priceUsd ?? null, meta?.marketCap ?? null)
                : null;
              const entrySellMC = t.avgSellPrice
                ? priceToMC(t.avgSellPrice, meta?.priceUsd ?? null, meta?.marketCap ?? null)
                : null;

              return (
              <div
                key={`${t.chain}:${t.address}`}
                className={idx > 0 ? "border-t border-white/[0.06]" : ""}
              >
                {/* Token header */}
                <div className="flex items-center justify-between px-3 py-2 bg-white/[0.025]">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono font-bold text-[#E8E8ED]">
                      {t.symbol}
                    </span>
                    <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded bg-[#00F0FF]/10 text-[#00F0FF]/60">
                      {chainLabel(t.chain)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {t.unrealizedPnlUsd != null && t.unrealizedPnlUsd !== 0 && (
                      <span className={`text-[9px] font-mono ${pnlColor(t.unrealizedPnlUsd)}`}>
                        {t.unrealizedPnlUsd > 0 ? "+" : ""}
                        {formatUsdCompact(t.unrealizedPnlUsd)} unrealized
                      </span>
                    )}
                    <span className={`text-[11px] font-mono font-bold ${pnlColor(t.pnlUsd)}`}>
                      {t.pnlUsd !== 0
                        ? `${t.pnlUsd > 0 ? "+" : ""}${formatUsdCompact(t.pnlUsd)}`
                        : "\u2014"}
                    </span>
                  </div>
                </div>

                {/* Buy / Sell split */}
                <div className="grid grid-cols-2">
                  {/* ── Bought (green) ── */}
                  <div className="px-3 py-3 border-r border-white/[0.04] bg-[#00FF88]/[0.025]">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-1.5 rounded-full bg-[#00FF88]" />
                        <span className="text-[9px] font-mono uppercase tracking-widest text-[#00FF88]/70 font-semibold">
                          Bought
                        </span>
                      </div>
                      {t.buyCount != null && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#00FF88]/10 text-[#00FF88]/60">
                          {t.buyCount} txn{t.buyCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div className="text-[15px] font-mono font-bold text-[#00FF88] leading-none">
                      {t.boughtUsd != null ? formatUsdCompact(t.boughtUsd) : "—"}
                    </div>
                    <div className="text-[9px] font-mono text-[#6B6B80] mt-1.5">
                      avg entry MC&nbsp;
                      <span className="text-[#E8E8ED]/60">
                        {entryBuyMC != null ? formatUsdCompact(entryBuyMC) : "—"}
                      </span>
                    </div>
                  </div>

                  {/* ── Sold (red) ── */}
                  <div className="px-3 py-3 bg-[#FF4444]/[0.025]">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-1.5 rounded-full bg-[#FF4444]" />
                        <span className="text-[9px] font-mono uppercase tracking-widest text-[#FF4444]/70 font-semibold">
                          Sold
                        </span>
                      </div>
                      {t.sellCount != null && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#FF4444]/10 text-[#FF4444]/60">
                          {t.sellCount} txn{t.sellCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div className="text-[15px] font-mono font-bold text-[#FF4444] leading-none">
                      {t.soldUsd != null ? formatUsdCompact(t.soldUsd) : "—"}
                    </div>
                    <div className="text-[9px] font-mono text-[#6B6B80] mt-1.5">
                      avg exit MC&nbsp;
                      <span className="text-[#E8E8ED]/60">
                        {entrySellMC != null ? formatUsdCompact(entrySellMC) : "—"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              );
            })}
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
}: CommonTradersTableProps) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"tokens" | "pnl">("pnl");

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
            No common traders found
          </p>
          <p className="text-xs mt-1 opacity-50">
            No wallets found trading multiple selected tokens
          </p>
        </div>
      </div>
    );
  }

  const sorted = [...traders].sort((a, b) => {
    if (sortBy === "tokens") {
      if (b.tokenCount !== a.tokenCount) return b.tokenCount - a.tokenCount;
      return b.totalPnlUsd - a.totalPnlUsd;
    }
    return b.totalPnlUsd - a.totalPnlUsd;
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
            onClick={() => setSortBy("pnl")}
            className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${
              sortBy === "pnl"
                ? "bg-[#00F0FF]/10 text-[#00F0FF]"
                : "text-[#6B6B80] hover:text-[#E8E8ED]"
            }`}
          >
            By PnL
          </button>
        </div>
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[40px_1fr_80px_100px_40px] gap-2 px-4 py-2 border-b border-white/[0.04]">
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">#</span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">Wallet</span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-center">Tokens</span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">Total PnL</span>
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
                expandedRow === trader.walletAddress ? null : trader.walletAddress
              )
            }
          />
        ))}
      </div>
    </div>
  );
}
