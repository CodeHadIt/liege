"use client";

import { useState } from "react";
import {
  TrendUp,
  ArrowSquareOut,
  CaretDown,
  CaretUp,
  CurrencyDollarSimple,
  Coins,
  CircleNotch,
  Users,
} from "@phosphor-icons/react";
import { Skeleton } from "@/components/ui/skeleton";
import { useTopTraders } from "@/features/token-analyzer/hooks/use-top-traders";
import { useWalletDialog } from "@/providers/wallet-dialog-provider";
import { shortenAddress, formatTimeAgo, chainLabel } from "@/lib/utils";
import { getExplorerAddressUrl } from "@/config/chains";
import type { ChainId } from "@/types/chain";
import type { TopTrader, TraderTier } from "@/types/traders";

interface TopTradersProps {
  chain: ChainId;
  address: string;
}

type DisplayMode = "usd" | "native";

const TIER_MAP: Record<TraderTier, { label: string; emoji: string; color: string }> = {
  whale:   { label: "Whale",   emoji: "\uD83D\uDC0B", color: "#00F0FF" },
  dolphin: { label: "Dolphin", emoji: "\uD83D\uDC2C", color: "#A855F7" },
  fish:    { label: "Fish",    emoji: "\uD83D\uDC1F", color: "#00FF88" },
  crab:    { label: "Crab",    emoji: "\uD83E\uDD80", color: "#FFB800" },
  shrimp:  { label: "Shrimp",  emoji: "\uD83E\uDD90", color: "#FF3B5C" },
};

function formatCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}${abs.toFixed(1)}`;
  if (abs >= 0.01) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(4)}`;
}

function formatUsdCompact(value: number): string {
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function TraderRow({
  trader,
  index,
  chain,
  displayMode,
  nativeSymbol,
  tokenSymbol,
  tokenPriceUsd,
}: {
  trader: TopTrader;
  index: number;
  chain: ChainId;
  displayMode: DisplayMode;
  nativeSymbol: string;
  tokenSymbol: string;
  tokenPriceUsd: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showStables, setShowStables] = useState(false);
  const { openWalletDialog } = useWalletDialog();
  const tierInfo = TIER_MAP[trader.tier];

  const avgBuyDisplay =
    displayMode === "usd"
      ? formatUsdCompact(trader.avgBuyAmountUsd)
      : `${formatCompact(trader.avgBuyAmount)} ${tokenSymbol}`;

  const pnlDisplay =
    displayMode === "usd"
      ? formatUsdCompact(trader.realizedPnlUsd)
      : `${formatCompact(trader.realizedPnl)} ${tokenSymbol}`;

  const remainingDisplay =
    displayMode === "usd"
      ? formatUsdCompact(trader.remainingTokensUsd)
      : `${formatCompact(trader.remainingTokens)} ${tokenSymbol}`;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full grid grid-cols-[32px_1fr_70px_70px_70px_80px_70px_50px_28px] gap-1.5 px-3 py-2 table-row-hover transition-colors group text-left items-center"
      >
        <span className="text-[10px] font-mono text-[#6B6B80]">
          {index + 1}
        </span>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[10px]" title={tierInfo.label}>
            {tierInfo.emoji}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openWalletDialog(trader.walletAddress, chain);
            }}
            className="text-[10px] font-mono text-[#E8E8ED] hover:text-[#00F0FF] transition-colors truncate"
          >
            {shortenAddress(trader.walletAddress, 4)}
          </button>
          <ArrowSquareOut className="h-2.5 w-2.5 text-[#6B6B80] opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
        </div>
        <span className="text-[10px] font-mono text-[#E8E8ED] text-right">
          {formatCompact(trader.nativeBalance)} {nativeSymbol}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowStables(!showStables);
          }}
          className="text-[10px] font-mono text-[#00FF88] text-right hover:underline"
        >
          {formatUsdCompact(trader.stablecoinTotal)}
        </button>
        <span className="text-[10px] font-mono text-[#E8E8ED] text-right">
          {avgBuyDisplay}
        </span>
        <span
          className={`text-[10px] font-mono font-bold text-right ${
            trader.realizedPnlUsd >= 0
              ? "text-[#00FF88]"
              : "text-[#FF3B5C]"
          }`}
        >
          {trader.realizedPnlUsd >= 0 ? "+" : ""}
          {pnlDisplay}
        </span>
        <span className="text-[10px] font-mono text-[#E8E8ED] text-right">
          {remainingDisplay}
        </span>
        <span className="text-[9px] font-mono text-[#6B6B80] text-right">
          {trader.lastTradeTimestamp
            ? formatTimeAgo(trader.lastTradeTimestamp)
            : "—"}
        </span>
        <div className="flex items-center justify-center">
          {expanded ? (
            <CaretUp className="h-3 w-3 text-[#6B6B80]" />
          ) : (
            <CaretDown className="h-3 w-3 text-[#6B6B80]" />
          )}
        </div>
      </button>

      {/* Stablecoin breakdown popup */}
      {showStables && trader.stablecoins.length > 0 && (
        <div className="px-3 pb-2 pl-12">
          <div className="inline-flex flex-wrap gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
            {trader.stablecoins.map((s) => (
              <span
                key={s.symbol}
                className="text-[10px] font-mono text-[#E8E8ED]"
              >
                <span className="text-[#6B6B80]">{s.symbol}:</span>{" "}
                {formatUsdCompact(s.balanceUsd)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-2 pl-12">
          <div className="grid grid-cols-3 gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
            <div>
              <span className="text-[9px] font-mono text-[#6B6B80] block mb-0.5">
                Avg Buy MCAP
              </span>
              <span className="text-[10px] font-mono text-[#E8E8ED]">
                {trader.avgBuyMarketCap
                  ? formatUsdCompact(trader.avgBuyMarketCap)
                  : "—"}
              </span>
            </div>
            <div>
              <span className="text-[9px] font-mono text-[#6B6B80] block mb-0.5">
                Avg Sell MCAP
              </span>
              <span className="text-[10px] font-mono text-[#E8E8ED]">
                {trader.avgSellMarketCap
                  ? formatUsdCompact(trader.avgSellMarketCap)
                  : "—"}
              </span>
            </div>
            <div>
              <span className="text-[9px] font-mono text-[#6B6B80] block mb-0.5">
                Avg Sell Price
              </span>
              <span className="text-[10px] font-mono text-[#E8E8ED]">
                {trader.avgSellPrice
                  ? formatUsdCompact(trader.avgSellPrice)
                  : "—"}
              </span>
            </div>
            <div>
              <span className="text-[9px] font-mono text-[#6B6B80] block mb-0.5">
                Total Trades
              </span>
              <span className="text-[10px] font-mono text-[#00F0FF]">
                {trader.tradeCount}
              </span>
            </div>
            <div>
              <span className="text-[9px] font-mono text-[#6B6B80] block mb-0.5">
                Tier
              </span>
              <span
                className="text-[10px] font-mono font-semibold"
                style={{ color: tierInfo.color }}
              >
                {tierInfo.emoji} {tierInfo.label}
              </span>
            </div>
            <div>
              <span className="text-[9px] font-mono text-[#6B6B80] block mb-0.5">
                Last Active
              </span>
              <span className="text-[10px] font-mono text-[#E8E8ED]">
                {trader.lastTradeTimestamp
                  ? formatTimeAgo(trader.lastTradeTimestamp)
                  : "—"}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function TopTraders({ chain, address }: TopTradersProps) {
  const { data, isLoading, error } = useTopTraders(chain, address);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("usd");

  if (isLoading) {
    return (
      <div className="glow-card rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-white/[0.04] flex items-center gap-2">
          <TrendUp className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Top Traders
          </span>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 py-4 justify-center text-[#6B6B80]">
            <CircleNotch className="h-4 w-4 animate-spin text-[#00F0FF]" />
            <span className="text-xs font-mono">Loading top traders...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="glow-card rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-white/[0.04] flex items-center gap-2">
          <TrendUp className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Top Traders
          </span>
        </div>
        <div className="text-center py-10 text-[#6B6B80]">
          <Users className="h-6 w-6 mx-auto mb-2 opacity-20" />
          <span className="text-xs font-mono">
            {error ? "Failed to load traders" : "No trader data"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendUp className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Top Traders
          </span>
          <span className="text-[10px] font-mono font-bold text-[#E8E8ED] ml-1">
            {data.traders.length}
          </span>
        </div>
        <button
          onClick={() =>
            setDisplayMode((prev) => (prev === "usd" ? "native" : "usd"))
          }
          className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono transition-colors ${
            displayMode === "usd"
              ? "bg-[#A855F7]/10 text-[#A855F7]"
              : "bg-[#00FF88]/10 text-[#00FF88]"
          }`}
        >
          {displayMode === "usd" ? (
            <CurrencyDollarSimple className="h-3 w-3" />
          ) : (
            <Coins className="h-3 w-3" />
          )}
          {displayMode === "usd" ? "USD" : data.nativeSymbol}
        </button>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[32px_1fr_70px_70px_70px_80px_70px_50px_28px] gap-1.5 px-3 py-2 border-b border-white/[0.04]">
        <span className="text-[8px] font-mono uppercase tracking-widest text-[#6B6B80]">
          #
        </span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-[#6B6B80]">
          Wallet
        </span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">
          {data.nativeSymbol}
        </span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">
          Stables
        </span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">
          Avg Buy
        </span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">
          PNL
        </span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">
          Remain
        </span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">
          Last
        </span>
        <span />
      </div>

      {/* Rows */}
      <div className="max-h-[600px] overflow-y-auto scrollbar-thin">
        {data.traders.map((trader, i) => (
          <TraderRow
            key={trader.walletAddress}
            trader={trader}
            index={i}
            chain={chain}
            displayMode={displayMode}
            nativeSymbol={data.nativeSymbol}
            tokenSymbol={data.tokenSymbol}
            tokenPriceUsd={data.tokenPriceUsd}
          />
        ))}
      </div>
    </div>
  );
}
