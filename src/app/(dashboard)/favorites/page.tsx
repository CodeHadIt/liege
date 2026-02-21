"use client";

import Link from "next/link";
import {
  Star,
  Wallet,
  SignIn,
  Trash,
  CircleNotch,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useAuth } from "@/hooks/use-auth";
import { useFavorites, type Favorite } from "@/hooks/use-favorites";
import { useWalletQuickView } from "@/hooks/use-wallet-quick-view";
import {
  shortenAddress,
  formatNumber,
  chainLabel,
} from "@/lib/utils";
import type { ChainId } from "@/types/chain";

function formatUsdCompact(value: number): string {
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export default function FavoritesPage() {
  const { ready, authenticated, signIn } = useAuth();
  const { favorites, isLoading } = useFavorites();

  if (!ready) {
    return (
      <div className="flex items-center justify-center py-24 text-[#6B6B80]">
        <CircleNotch className="h-5 w-5 animate-spin text-[#00F0FF] mr-2" />
        <span className="text-sm font-mono">Loading...</span>
      </div>
    );
  }

  // Unauthenticated state
  if (!authenticated) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#FFB800]/20 to-[#FF8C42]/20 border border-[#FFB800]/10 flex items-center justify-center">
            <Star className="h-5 w-5 text-[#FFB800]" weight="fill" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#E8E8ED]">Favorites</h1>
            <p className="text-xs text-[#6B6B80] font-mono">
              Track your favorite wallets
            </p>
          </div>
        </div>

        <div className="glow-card rounded-xl p-8 text-center animate-fade-up">
          <div className="h-16 w-16 rounded-2xl bg-[#00F0FF]/10 border border-[#00F0FF]/20 flex items-center justify-center mx-auto mb-5">
            <Wallet className="h-7 w-7 text-[#00F0FF]" />
          </div>
          <h2 className="text-lg font-bold text-[#E8E8ED] mb-2">
            Connect Your Wallet
          </h2>
          <p className="text-sm text-[#6B6B80] max-w-md mx-auto mb-6">
            Sign in with your wallet to save and track your favorite wallets
            across Solana, Base, and BSC.
          </p>
          <button
            onClick={signIn}
            className="inline-flex items-center gap-2 h-10 px-5 rounded-lg bg-[#00F0FF]/10 border border-[#00F0FF]/20 text-[#00F0FF] font-medium text-sm hover:bg-[#00F0FF]/20 transition-all"
          >
            <SignIn className="h-4 w-4" />
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  // Loading
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#FFB800]/20 to-[#FF8C42]/20 border border-[#FFB800]/10 flex items-center justify-center">
            <Star className="h-5 w-5 text-[#FFB800]" weight="fill" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#E8E8ED]">Favorites</h1>
          </div>
        </div>
        <div className="flex items-center justify-center py-16 text-[#6B6B80]">
          <CircleNotch className="h-5 w-5 animate-spin text-[#00F0FF] mr-2" />
          <span className="text-sm font-mono">Loading favorites...</span>
        </div>
      </div>
    );
  }

  // Empty state
  if (favorites.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#FFB800]/20 to-[#FF8C42]/20 border border-[#FFB800]/10 flex items-center justify-center">
            <Star className="h-5 w-5 text-[#FFB800]" weight="fill" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#E8E8ED]">Favorites</h1>
            <p className="text-xs text-[#6B6B80] font-mono">0 wallets</p>
          </div>
        </div>

        <div className="glow-card rounded-xl p-8 text-center animate-fade-up">
          <div className="h-16 w-16 rounded-2xl bg-[#FFB800]/10 border border-[#FFB800]/20 flex items-center justify-center mx-auto mb-5">
            <Star className="h-7 w-7 text-[#FFB800]" />
          </div>
          <h2 className="text-lg font-bold text-[#E8E8ED] mb-2">
            No Favorites Yet
          </h2>
          <p className="text-sm text-[#6B6B80] max-w-md mx-auto">
            Visit any wallet page and click the star icon to add it to your
            favorites. You&apos;ll see insights like balance, P&L, and active
            positions here.
          </p>
        </div>
      </div>
    );
  }

  const solCount = favorites.filter((f) => f.chain === "solana").length;
  const evmCount = favorites.filter((f) => f.chain !== "solana").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#FFB800]/20 to-[#FF8C42]/20 border border-[#FFB800]/10 flex items-center justify-center">
          <Star className="h-5 w-5 text-[#FFB800]" weight="fill" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-[#E8E8ED]">Favorites</h1>
          <p className="text-xs text-[#6B6B80] font-mono">
            {favorites.length} wallet{favorites.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          {
            label: "TOTAL",
            value: favorites.length.toString(),
            color: "#FFB800",
          },
          { label: "SOLANA", value: solCount.toString(), color: "#9945FF" },
          { label: "EVM", value: evmCount.toString(), color: "#0052FF" },
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

      {/* Favorite cards */}
      <div className="space-y-3">
        {favorites.map((fav) => (
          <FavoriteWalletCard key={fav.id} favorite={fav} />
        ))}
      </div>
    </div>
  );
}

function FavoriteWalletCard({ favorite }: { favorite: Favorite }) {
  const { removeFavorite, isRemoving } = useFavorites();
  const { data, isLoading } = useWalletQuickView({
    walletAddress: favorite.wallet_address,
    chain: favorite.chain,
  });

  return (
    <div className="glow-card rounded-xl overflow-hidden animate-fade-up">
      {/* Card header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.04]">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 border border-[#00F0FF]/10 flex items-center justify-center">
            <Wallet className="h-4 w-4 text-[#00F0FF]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Link
                href={`/wallet/${favorite.chain}/${favorite.wallet_address}`}
                className="font-mono text-sm text-[#E8E8ED] hover:text-[#00F0FF] transition-colors"
                style={{ cursor: "pointer" }}
              >
                {shortenAddress(favorite.wallet_address, 6)}
                <ArrowSquareOut className="inline h-3 w-3 ml-1 opacity-50" />
              </Link>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#00F0FF]/10 text-[#00F0FF]/70">
                {chainLabel(favorite.chain)}
              </span>
            </div>
            {favorite.label && (
              <span className="text-[10px] text-[#6B6B80] font-mono">
                {favorite.label}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => removeFavorite(favorite.id)}
          disabled={isRemoving}
          className="h-8 w-8 rounded-lg border border-white/[0.06] bg-white/[0.03] text-[#6B6B80] hover:text-[#FF3B5C] hover:border-[#FF3B5C]/20 hover:bg-[#FF3B5C]/[0.06] transition-all flex items-center justify-center"
          title="Remove from favorites"
        >
          <Trash className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Card body */}
      <div className="px-5 py-4">
        {isLoading && (
          <div className="flex items-center justify-center py-6 text-[#6B6B80]">
            <CircleNotch className="h-4 w-4 animate-spin text-[#00F0FF] mr-2" />
            <span className="text-xs font-mono">Loading insights...</span>
          </div>
        )}

        {data && (
          <div className="space-y-3">
            {/* Stats */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
                <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                  {data.nativeSymbol}
                </div>
                <div className="text-sm font-bold font-mono text-[#E8E8ED]">
                  {formatNumber(data.nativeBalance)}
                </div>
                <div className="text-[10px] font-mono text-[#6B6B80]">
                  {formatUsdCompact(data.nativeBalanceUsd)}
                </div>
              </div>
              <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
                <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                  Stablecoins
                </div>
                <div className="text-sm font-bold font-mono text-[#00FF88]">
                  {formatUsdCompact(data.stablecoinTotal)}
                </div>
              </div>
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

            {/* Mini PNL chart */}
            {data.pnlHistory.length > 0 && (
              <div className="h-[80px] rounded-lg bg-white/[0.02] border border-white/[0.04] p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.pnlHistory}>
                    <defs>
                      <linearGradient
                        id={`pnlGrad-${favorite.id}`}
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
                    <XAxis dataKey="date" hide />
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
                            <div className="text-[#6B6B80]">{entry.date}</div>
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
                      fill={`url(#pnlGrad-${favorite.id})`}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Active positions preview */}
            {data.activePositions.length > 0 && (
              <div>
                <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-2">
                  Active Positions
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {data.activePositions.slice(0, 8).map((pos) => (
                    <span
                      key={pos.tokenAddress}
                      className="text-[10px] font-mono font-semibold px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.06] text-[#E8E8ED]"
                    >
                      {pos.symbol}
                    </span>
                  ))}
                  {data.activePositions.length > 8 && (
                    <span className="text-[10px] font-mono px-2 py-1 rounded-md bg-white/[0.02] text-[#6B6B80]">
                      +{data.activePositions.length - 8} more
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {!isLoading && !data && (
          <div className="text-center py-4 text-[#6B6B80] text-xs font-mono">
            Failed to load wallet data
          </div>
        )}
      </div>
    </div>
  );
}
