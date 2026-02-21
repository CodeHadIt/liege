"use client";

import { useState } from "react";
import {
  Wallet,
  Coins,
  TrendUp,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowSquareOut,
  CircleNotch,
  Pulse,
  Trophy,
  ChartBar,
} from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWalletDialog } from "@/providers/wallet-dialog-provider";
import { useWalletQuickView } from "@/hooks/use-wallet-quick-view";
import {
  shortenAddress,
  formatNumber,
  formatTimeAgo,
  chainLabel,
} from "@/lib/utils";
import { getExplorerAddressUrl } from "@/config/chains";
import { FavoriteButton } from "@/components/shared/favorite-button";
import type { ChainId } from "@/types/chain";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type Tab = "positions" | "pnl" | "top-buys" | "activity";

function formatUsdCompact(value: number): string {
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function WalletDialog() {
  const { state, closeWalletDialog } = useWalletDialog();
  const [activeTab, setActiveTab] = useState<Tab>("positions");
  const [showStableBreakdown, setShowStableBreakdown] = useState(false);

  const input =
    state.isOpen && state.walletAddress && state.chain
      ? { walletAddress: state.walletAddress, chain: state.chain }
      : null;

  const { data, isLoading, error } = useWalletQuickView(input);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: "positions",
      label: "Positions",
      icon: <Coins className="h-3 w-3" />,
    },
    {
      id: "pnl",
      label: "PNL History",
      icon: <ChartBar className="h-3 w-3" />,
    },
    {
      id: "top-buys",
      label: "Top Buys",
      icon: <Trophy className="h-3 w-3" />,
    },
    {
      id: "activity",
      label: "Activity",
      icon: <Pulse className="h-3 w-3" />,
    },
  ];

  return (
    <Dialog
      open={state.isOpen}
      onOpenChange={(open) => {
        if (!open) closeWalletDialog();
      }}
    >
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] overflow-y-auto bg-[#0C0C14] border-white/[0.06] p-0"
        showCloseButton
      >
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="flex items-center gap-3 text-[#E8E8ED]">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 border border-[#00F0FF]/10 flex items-center justify-center">
              <Wallet className="h-4 w-4 text-[#00F0FF]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">
                  {state.walletAddress
                    ? shortenAddress(state.walletAddress, 6)
                    : ""}
                </span>
                {state.chain && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#00F0FF]/10 text-[#00F0FF]/70">
                    {chainLabel(state.chain)}
                  </span>
                )}
              </div>
              {state.walletAddress && state.chain && (
                <a
                  href={getExplorerAddressUrl(state.chain, state.walletAddress)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-[#6B6B80] hover:text-[#00F0FF] transition-colors flex items-center gap-1 mt-0.5"
                >
                  View on explorer
                  <ArrowSquareOut className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
            {state.walletAddress && state.chain && (
              <div className="ml-auto">
                <FavoriteButton
                  walletAddress={state.walletAddress}
                  chain={state.chain as ChainId}
                />
              </div>
            )}
          </DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-16 text-[#6B6B80]">
            <CircleNotch className="h-5 w-5 animate-spin text-[#00F0FF] mr-2" />
            <span className="text-sm font-mono">Loading wallet data...</span>
          </div>
        )}

        {error && (
          <div className="text-center py-12 text-[#FF3B5C] text-sm font-mono px-5">
            Failed to load wallet data
          </div>
        )}

        {data && (
          <div className="space-y-0">
            {/* Top stats bar */}
            <div className="grid grid-cols-3 gap-3 px-5 py-4">
              {/* Native balance */}
              <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
                <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                  {data.nativeSymbol} Balance
                </div>
                <div className="text-sm font-bold font-mono text-[#E8E8ED]">
                  {formatNumber(data.nativeBalance)}
                </div>
                <div className="text-[10px] font-mono text-[#6B6B80]">
                  {formatUsdCompact(data.nativeBalanceUsd)}
                </div>
              </div>

              {/* Stablecoin balance */}
              <div
                className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3 cursor-pointer hover:bg-white/[0.05] transition-colors"
                onClick={() => setShowStableBreakdown(!showStableBreakdown)}
              >
                <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                  Stablecoins
                </div>
                <div className="text-sm font-bold font-mono text-[#00FF88]">
                  {formatUsdCompact(data.stablecoinTotal)}
                </div>
                {showStableBreakdown && data.stablecoins.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {data.stablecoins.map((s) => (
                      <div
                        key={s.symbol}
                        className="flex justify-between text-[9px] font-mono"
                      >
                        <span className="text-[#6B6B80]">{s.symbol}</span>
                        <span className="text-[#E8E8ED]">
                          {formatUsdCompact(s.balanceUsd)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {!showStableBreakdown && data.stablecoins.length > 0 && (
                  <div className="text-[9px] font-mono text-[#6B6B80]/60 mt-0.5">
                    Click to expand
                  </div>
                )}
              </div>

              {/* 30d PNL */}
              <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
                <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                  30d PNL
                </div>
                <div
                  className={`text-sm font-bold font-mono ${
                    data.pnl30d >= 0 ? "text-[#00FF88]" : "text-[#FF3B5C]"
                  }`}
                >
                  {data.pnl30d >= 0 ? "+" : ""}
                  {formatUsdCompact(data.pnl30d)}
                </div>
              </div>
            </div>

            {/* PNL Chart */}
            {data.pnlHistory.length > 0 && (
              <div className="px-5 pb-3">
                <div className="h-[100px] rounded-lg bg-white/[0.02] border border-white/[0.04] p-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.pnlHistory}>
                      <defs>
                        <linearGradient
                          id="pnlGradient"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor={
                              data.pnl30d >= 0 ? "#00FF88" : "#FF3B5C"
                            }
                            stopOpacity={0.3}
                          />
                          <stop
                            offset="100%"
                            stopColor={
                              data.pnl30d >= 0 ? "#00FF88" : "#FF3B5C"
                            }
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="date"
                        hide
                      />
                      <YAxis hide domain={["auto", "auto"]} />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const entry = payload[0].payload as {
                            date: string;
                            pnl: number;
                          };
                          return (
                            <div className="rounded-lg px-2.5 py-1.5 text-[10px] font-mono bg-[#111118] border border-white/[0.08] shadow-xl">
                              <div className="text-[#6B6B80]">
                                {entry.date}
                              </div>
                              <div
                                className={
                                  entry.pnl >= 0
                                    ? "text-[#00FF88]"
                                    : "text-[#FF3B5C]"
                                }
                              >
                                {entry.pnl >= 0 ? "+" : ""}
                                {formatUsdCompact(entry.pnl)}
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="pnl"
                        stroke={data.pnl30d >= 0 ? "#00FF88" : "#FF3B5C"}
                        strokeWidth={1.5}
                        fill="url(#pnlGradient)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="flex gap-1 px-5 border-b border-white/[0.04]">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-mono font-semibold transition-colors border-b-2 -mb-px ${
                    activeTab === tab.id
                      ? "border-[#00F0FF] text-[#00F0FF]"
                      : "border-transparent text-[#6B6B80] hover:text-[#E8E8ED]"
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="px-5 py-3 max-h-[300px] overflow-y-auto scrollbar-thin">
              {activeTab === "positions" && (
                <PositionsTab positions={data.activePositions} />
              )}
              {activeTab === "pnl" && (
                <PnlTab entries={data.recentPnls} />
              )}
              {activeTab === "top-buys" && (
                <TopBuysTab entries={data.topBuys} />
              )}
              {activeTab === "activity" && (
                <ActivityTab entries={data.recentActivity} />
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PositionsTab({
  positions,
}: {
  positions: WalletQuickViewDataPositions;
}) {
  if (positions.length === 0) {
    return (
      <div className="text-center py-8 text-[#6B6B80] text-xs font-mono">
        No active positions
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_80px_80px] gap-2 px-2 py-1">
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80]">
          Token
        </span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">
          Balance
        </span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] text-right">
          Value
        </span>
      </div>
      {positions.map((pos) => (
        <div
          key={pos.tokenAddress}
          className="grid grid-cols-[1fr_80px_80px] gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            {pos.logoUrl ? (
              <img
                src={pos.logoUrl}
                alt={pos.symbol}
                className="h-5 w-5 rounded-full ring-1 ring-white/[0.06]"
              />
            ) : (
              <div className="h-5 w-5 rounded-full bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 flex items-center justify-center text-[8px] font-bold text-[#00F0FF]">
                {pos.symbol.slice(0, 2)}
              </div>
            )}
            <span className="text-[11px] font-mono font-semibold text-[#E8E8ED] truncate">
              {pos.symbol}
            </span>
          </div>
          <span className="text-[10px] font-mono text-[#E8E8ED] text-right">
            {formatNumber(pos.balance)}
          </span>
          <span className="text-[10px] font-mono text-[#E8E8ED] text-right">
            {formatUsdCompact(pos.balanceUsd)}
          </span>
        </div>
      ))}
    </div>
  );
}

type WalletQuickViewDataPositions =
  import("@/types/traders").WalletPosition[];

function PnlTab({
  entries,
}: {
  entries: import("@/types/traders").PnlHistoryEntry[];
}) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-[#6B6B80] text-xs font-mono">
        No PNL history available
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map((entry, i) => (
        <div
          key={`${entry.tokenAddress}-${entry.timestamp}-${i}`}
          className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-2">
            <TrendUp
              className={`h-3 w-3 ${
                entry.realizedPnl >= 0
                  ? "text-[#00FF88]"
                  : "text-[#FF3B5C]"
              }`}
            />
            <span className="text-[11px] font-mono font-semibold text-[#E8E8ED]">
              {entry.symbol}
            </span>
            <span className="text-[9px] font-mono text-[#6B6B80]">
              {formatTimeAgo(entry.timestamp)}
            </span>
          </div>
          <span
            className={`text-[11px] font-mono font-bold ${
              entry.realizedPnl >= 0
                ? "text-[#00FF88]"
                : "text-[#FF3B5C]"
            }`}
          >
            {entry.realizedPnl >= 0 ? "+" : ""}
            {formatUsdCompact(entry.realizedPnl)}
          </span>
        </div>
      ))}
    </div>
  );
}

function TopBuysTab({
  entries,
}: {
  entries: import("@/types/traders").PnlHistoryEntry[];
}) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-[#6B6B80] text-xs font-mono">
        No buy history available
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map((entry, i) => (
        <div
          key={`${entry.tokenAddress}-${entry.timestamp}-${i}`}
          className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-2">
            <ArrowDownLeft className="h-3 w-3 text-[#00C48C]" />
            <span className="text-[11px] font-mono font-semibold text-[#E8E8ED]">
              {entry.symbol}
            </span>
            <span className="text-[9px] font-mono text-[#6B6B80]">
              {formatTimeAgo(entry.timestamp)}
            </span>
          </div>
          <span className="text-[11px] font-mono font-bold text-[#00FF88]">
            {formatUsdCompact(entry.realizedPnl)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ActivityTab({
  entries,
}: {
  entries: import("@/types/traders").WalletQuickViewData["recentActivity"];
}) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-[#6B6B80] text-xs font-mono">
        No recent activity
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map((entry, i) => (
        <div
          key={`${entry.txHash}-${i}`}
          className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-2">
            {entry.side === "buy" ? (
              <ArrowDownLeft className="h-3 w-3 text-[#00C48C]" />
            ) : (
              <ArrowUpRight className="h-3 w-3 text-[#FF3B5C]" />
            )}
            <span
              className={`text-[10px] font-mono font-bold uppercase ${
                entry.side === "buy"
                  ? "text-[#00C48C]"
                  : "text-[#FF3B5C]"
              }`}
            >
              {entry.side}
            </span>
            <span className="text-[11px] font-mono font-semibold text-[#E8E8ED]">
              {entry.tokenSymbol}
            </span>
            <span className="text-[9px] font-mono text-[#6B6B80]">
              {formatTimeAgo(entry.timestamp)}
            </span>
          </div>
          <span className="text-[10px] font-mono text-[#E8E8ED]">
            {formatUsdCompact(entry.amountUsd)}
          </span>
        </div>
      ))}
    </div>
  );
}
