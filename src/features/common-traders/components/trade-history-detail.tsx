"use client";

import { useState } from "react";
import {
  CaretDown,
  CaretUp,
  ArrowDownLeft,
  ArrowUpRight,
  CircleNotch,
} from "@phosphor-icons/react";
import { chainLabel } from "@/lib/utils";
import type { TokenTradeHistory } from "@/types/traders";

export type DisplayCurrency = "token" | "usd";

interface TradeHistoryDetailProps {
  tokenHistories: TokenTradeHistory[];
  displayCurrency: DisplayCurrency;
  isLoading: boolean;
  error: string | null;
}

function formatAmount(
  amount: number,
  currency: DisplayCurrency,
  priceUsd: number | null,
  symbol: string
): string {
  if (currency === "usd" && priceUsd) {
    const usd = amount * priceUsd;
    if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
    if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
    if (usd >= 1) return `$${usd.toFixed(0)}`;
    if (usd >= 0.01) return `$${usd.toFixed(2)}`;
    return `$${usd.toFixed(4)}`;
  }
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1)}B ${symbol}`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M ${symbol}`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K ${symbol}`;
  if (amount >= 1) return `${amount.toFixed(1)} ${symbol}`;
  return `${amount.toFixed(4)} ${symbol}`;
}

function formatProfit(
  pnl: number,
  currency: DisplayCurrency,
  priceUsd: number | null,
  symbol: string
): string {
  const sign = pnl >= 0 ? "+" : "-";
  const abs = Math.abs(pnl);
  if (currency === "usd" && priceUsd) {
    const usd = abs * priceUsd;
    if (usd >= 1_000_000) return `${sign}$${(usd / 1_000_000).toFixed(1)}M`;
    if (usd >= 1_000) return `${sign}$${(usd / 1_000).toFixed(1)}K`;
    if (usd >= 1) return `${sign}$${usd.toFixed(0)}`;
    return `${sign}$${usd.toFixed(2)}`;
  }
  return `${sign}${formatAmount(abs, "token", null, symbol)}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateShort(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

function TokenTradeSection({
  history,
  displayCurrency,
}: {
  history: TokenTradeHistory;
  displayCurrency: DisplayCurrency;
}) {
  const [showTranches, setShowTranches] = useState(false);
  const { totalBought, totalSold, currentBalance, priceUsd, symbol, tranches } =
    history;

  const pnl = totalSold - totalBought + currentBalance;
  const pnlPositive = pnl >= 0;

  const buys = tranches.filter((t) => t.side === "buy");
  const sells = tranches.filter((t) => t.side === "sell");

  // Date ranges
  const firstBuyDate = buys.length > 0 ? buys[0].timestamp : null;
  const lastBuyDate = buys.length > 0 ? buys[buys.length - 1].timestamp : null;
  const firstSellDate = sells.length > 0 ? sells[0].timestamp : null;
  const lastSellDate = sells.length > 0 ? sells[sells.length - 1].timestamp : null;

  return (
    <div className="space-y-2">
      {/* Summary row */}
      <div className="grid grid-cols-4 gap-3 text-[10px] font-mono">
        <div>
          <span className="text-[#6B6B80] block mb-0.5">Bought</span>
          <span className="text-[#00C48C] font-semibold">
            {formatAmount(totalBought, displayCurrency, priceUsd, symbol)}
          </span>
          {firstBuyDate && (
            <span className="text-[#6B6B80]/60 block text-[9px] mt-0.5">
              {firstBuyDate === lastBuyDate
                ? formatDateShort(firstBuyDate)
                : `${formatDateShort(firstBuyDate)} - ${formatDateShort(lastBuyDate!)}`}
            </span>
          )}
        </div>
        <div>
          <span className="text-[#6B6B80] block mb-0.5">Sold</span>
          <span className="text-[#FF3B5C] font-semibold">
            {formatAmount(totalSold, displayCurrency, priceUsd, symbol)}
          </span>
          {firstSellDate && (
            <span className="text-[#6B6B80]/60 block text-[9px] mt-0.5">
              {firstSellDate === lastSellDate
                ? formatDateShort(firstSellDate)
                : `${formatDateShort(firstSellDate)} - ${formatDateShort(lastSellDate!)}`}
            </span>
          )}
        </div>
        <div>
          <span className="text-[#6B6B80] block mb-0.5">Balance</span>
          <span className="text-[#E8E8ED] font-semibold">
            {formatAmount(currentBalance, displayCurrency, priceUsd, symbol)}
          </span>
        </div>
        <div>
          <span className="text-[#6B6B80] block mb-0.5">Profit</span>
          <span
            className={`font-semibold ${pnlPositive ? "text-[#00C48C]" : "text-[#FF3B5C]"}`}
          >
            {formatProfit(pnl, displayCurrency, priceUsd, symbol)}
          </span>
        </div>
      </div>

      {/* Tranche toggle */}
      {tranches.length > 0 && (
        <button
          onClick={() => setShowTranches(!showTranches)}
          className="flex items-center gap-1 text-[9px] font-mono text-[#6B6B80] hover:text-[#00F0FF] transition-colors"
        >
          {showTranches ? (
            <CaretUp className="h-3 w-3" />
          ) : (
            <CaretDown className="h-3 w-3" />
          )}
          {tranches.length} trade{tranches.length !== 1 ? "s" : ""} ({buys.length}{" "}
          buy{buys.length !== 1 ? "s" : ""}, {sells.length} sell
          {sells.length !== 1 ? "s" : ""})
        </button>
      )}

      {tranches.length === 0 && (
        <span className="text-[9px] font-mono text-[#6B6B80]/50">
          No recent trades found
        </span>
      )}

      {/* Individual tranches */}
      {showTranches && (
        <div className="space-y-0.5 ml-2 border-l border-white/[0.04] pl-3">
          {tranches.map((tranche, i) => (
            <div
              key={`${tranche.txHash}-${i}`}
              className="flex items-center gap-3 text-[10px] font-mono py-0.5"
            >
              {tranche.side === "buy" ? (
                <ArrowDownLeft className="h-3 w-3 text-[#00C48C] shrink-0" />
              ) : (
                <ArrowUpRight className="h-3 w-3 text-[#FF3B5C] shrink-0" />
              )}
              <span className="text-[#6B6B80] w-32 shrink-0">
                {formatDate(tranche.timestamp)}
              </span>
              <span
                className={
                  tranche.side === "buy" ? "text-[#00C48C]" : "text-[#FF3B5C]"
                }
              >
                {formatAmount(
                  tranche.amount,
                  displayCurrency,
                  history.priceUsd,
                  symbol
                )}
              </span>
              {tranche.source && (
                <span className="text-[#6B6B80]/50 text-[9px]">
                  {tranche.source}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TradeHistoryDetail({
  tokenHistories,
  displayCurrency,
  isLoading,
  error,
}: TradeHistoryDetailProps) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-[10px] font-mono text-[#6B6B80]">
        <CircleNotch className="h-3 w-3 animate-spin text-[#00F0FF]" />
        Loading trade history...
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-2 text-[10px] font-mono text-[#FF3B5C]">
        Failed to load trade history
      </div>
    );
  }

  if (tokenHistories.length === 0) return null;

  return (
    <div className="space-y-4 pt-3 border-t border-white/[0.04]">
      <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">
        Trade History
      </span>
      {tokenHistories.map((history) => (
        <div key={`${history.chain}:${history.tokenAddress}`}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[11px] font-mono font-semibold text-[#E8E8ED]">
              {history.symbol}
            </span>
            <span className="text-[9px] font-mono uppercase text-[#00F0FF]/60">
              {chainLabel(history.chain)}
            </span>
          </div>
          <TokenTradeSection
            history={history}
            displayCurrency={displayCurrency}
          />
        </div>
      ))}
    </div>
  );
}
