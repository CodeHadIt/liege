"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  Star,
  Wallet,
  SignIn,
  Trash,
  CircleNotch,
  ArrowSquareOut,
  CaretDown,
  CaretUp,
  Copy,
  XLogo,
  TelegramLogo,
  Globe,
  Pencil,
  Check,
  X,
  Smiley,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useFavorites, type Favorite } from "@/hooks/use-favorites";
import { useWalletQuickView } from "@/hooks/use-wallet-quick-view";
import {
  shortenAddress,
  formatNumber,
  chainLabel,
} from "@/lib/utils";
import { useToast } from "@/providers/toast-provider";
import type { FavoriteSummary } from "@/app/api/favorites/insights/route";
import type { ChainId } from "@/types/chain";

const EmojiPicker = dynamic(() => import("@emoji-mart/react").then((mod) => mod.default), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center p-8">
      <CircleNotch className="h-5 w-5 animate-spin text-[#00F0FF]" />
    </div>
  ),
});

function formatUsdCompact(value: number): string {
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatRelativeTime(epochSec: number): string {
  if (!epochSec) return "—";
  const diffSec = Math.floor(Date.now() / 1000) - epochSec;
  if (diffSec < 3600) return `${Math.max(1, Math.floor(diffSec / 60))}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatHoldDuration(epochSec: number): string {
  if (!epochSec) return "—";
  const diffSec = Math.floor(Date.now() / 1000) - epochSec;
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, Math.floor(diffSec / 60))}m`;
}

function useFavoriteInsights(favorites: Favorite[]) {
  return useQuery<Record<string, FavoriteSummary>>({
    queryKey: [
      "favorite-insights",
      favorites.map((f) => `${f.chain}:${f.wallet_address}`).join(","),
    ],
    queryFn: async () => {
      const res = await fetch("/api/favorites/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: favorites.map((f) => ({
            address: f.wallet_address,
            chain: f.chain,
          })),
        }),
      });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: favorites.length > 0,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export default function FavoritesPage() {
  const { ready, authenticated, signIn } = useAuth();
  const { favorites, isLoading } = useFavorites();
  const { data: insights, isLoading: insightsLoading } =
    useFavoriteInsights(favorites);

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
            favorites. You&apos;ll see insights like balance and active
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
          <FavoriteWalletCard
            key={fav.id}
            favorite={fav}
            summary={insights?.[`${fav.chain}:${fav.wallet_address}`] ?? null}
            summaryLoading={insightsLoading}
          />
        ))}
      </div>
    </div>
  );
}

function FavoriteWalletCard({
  favorite,
  summary,
  summaryLoading,
}: {
  favorite: Favorite;
  summary: FavoriteSummary | null;
  summaryLoading: boolean;
}) {
  const { removeFavorite, isRemoving, updateFavorite, isUpdating } = useFavorites();
  const showToast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const emojiPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!emojiPickerOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setEmojiPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [emojiPickerOpen]);

  const { data: quickView, isLoading: quickViewLoading } = useWalletQuickView(
    { walletAddress: favorite.wallet_address, chain: favorite.chain as ChainId },
    { enabled: expanded }
  );

  const isSolana = favorite.chain === "solana";

  return (
    <div className={`glow-card rounded-xl animate-fade-up ${emojiPickerOpen ? "overflow-visible z-50 relative" : "overflow-hidden"}`}>
      {/* Card header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.04]">
        <div className="flex items-center gap-3">
          <div className="relative" ref={emojiPickerRef}>
            <button
              onClick={() => setEmojiPickerOpen((v) => !v)}
              className="h-8 w-8 rounded-lg bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 border border-[#00F0FF]/10 flex items-center justify-center hover:border-[#00F0FF]/30 transition-all group"
              title={favorite.emoji ? "Change emoji" : "Set emoji"}
            >
              {favorite.emoji ? (
                <span className="text-lg leading-none">{favorite.emoji}</span>
              ) : (
                <>
                  <Wallet className="h-4 w-4 text-[#00F0FF]" />
                  <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-[#1A1A2E] border border-[#00F0FF]/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <Smiley className="h-2.5 w-2.5 text-[#00F0FF]" />
                  </span>
                </>
              )}
            </button>
            {emojiPickerOpen && (
              <div className="absolute top-10 left-0 z-[9999]">
                <EmojiPicker
                  data={async () => (await import("@emoji-mart/data")).default}
                  theme="dark"
                  onEmojiSelect={(emoji: { native: string }) => {
                    updateFavorite({ id: favorite.id, emoji: emoji.native });
                    setEmojiPickerOpen(false);
                  }}
                  previewPosition="none"
                  skinTonePosition="search"
                  maxFrequentRows={1}
                />
                {favorite.emoji && (
                  <button
                    onClick={() => {
                      updateFavorite({ id: favorite.id, emoji: null });
                      setEmojiPickerOpen(false);
                    }}
                    className="w-full py-2 text-xs font-mono text-[#FF3B5C] bg-[#1A1A2E] border border-white/[0.06] border-t-0 rounded-b-lg hover:bg-[#FF3B5C]/10 transition-colors"
                  >
                    Remove emoji
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="min-w-0">
            {editing ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const trimmed = editLabel.trim();
                      updateFavorite({ id: favorite.id, label: trimmed || null });
                      setEditing(false);
                    }
                    if (e.key === "Escape") {
                      setEditing(false);
                    }
                  }}
                  placeholder="Name this wallet"
                  className="h-7 px-2 rounded-md bg-white/[0.06] border border-[#00F0FF]/20 text-sm font-mono text-[#E8E8ED] placeholder:text-[#6B6B80]/50 outline-none focus:border-[#00F0FF]/40 w-40"
                />
                <button
                  onClick={() => {
                    const trimmed = editLabel.trim();
                    updateFavorite({ id: favorite.id, label: trimmed || null });
                    setEditing(false);
                  }}
                  className="h-7 w-7 rounded-md border border-[#00FF88]/20 bg-[#00FF88]/[0.06] text-[#00FF88] hover:bg-[#00FF88]/[0.12] transition-all flex items-center justify-center"
                  title="Save"
                >
                  <Check className="h-3.5 w-3.5" weight="bold" />
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="h-7 w-7 rounded-md border border-white/[0.06] bg-white/[0.03] text-[#6B6B80] hover:text-[#FF3B5C] hover:border-[#FF3B5C]/20 transition-all flex items-center justify-center"
                  title="Cancel"
                >
                  <X className="h-3.5 w-3.5" weight="bold" />
                </button>
              </div>
            ) : favorite.label ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-[#E8E8ED] truncate">
                    {favorite.label}
                  </span>
                  <button
                    onClick={() => {
                      setEditLabel(favorite.label || "");
                      setEditing(true);
                    }}
                    className="text-[#6B6B80] hover:text-[#00F0FF] transition-colors shrink-0"
                    title="Edit name"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/wallet/${favorite.chain}/${favorite.wallet_address}`}
                    className="font-mono text-[11px] text-[#6B6B80] hover:text-[#00F0FF] transition-colors"
                  >
                    {shortenAddress(favorite.wallet_address, 6)}
                  </Link>
                  <button
                    onClick={() => { navigator.clipboard.writeText(favorite.wallet_address); showToast("Copied wallet address successfully"); }}
                    className="text-[#6B6B80] hover:text-[#E8E8ED] transition-colors shrink-0"
                    title="Copy address"
                  >
                    <Copy size={11} />
                  </button>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#00F0FF]/10 text-[#00F0FF]/70">
                    {chainLabel(favorite.chain)}
                  </span>
                </div>
              </>
            ) : (
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
                <button
                  onClick={() => {
                    setEditLabel("");
                    setEditing(true);
                  }}
                  className="text-[#6B6B80] hover:text-[#00F0FF] transition-colors shrink-0"
                  title="Name this wallet"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="h-8 w-8 rounded-lg border border-white/[0.06] bg-white/[0.03] text-[#6B6B80] hover:text-[#00F0FF] hover:border-[#00F0FF]/20 hover:bg-[#00F0FF]/[0.06] transition-all flex items-center justify-center"
            title={expanded ? "Collapse" : "Expand details"}
          >
            {expanded ? (
              <CaretUp className="h-3.5 w-3.5" />
            ) : (
              <CaretDown className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            onClick={() => removeFavorite(favorite.id)}
            disabled={isRemoving}
            className="h-8 w-8 rounded-lg border border-white/[0.06] bg-white/[0.03] text-[#6B6B80] hover:text-[#FF3B5C] hover:border-[#FF3B5C]/20 hover:bg-[#FF3B5C]/[0.06] transition-all flex items-center justify-center"
            title="Remove from favorites"
          >
            <Trash className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Collapsed body — always visible */}
      <div className="px-5 py-4">
        {summaryLoading && !summary && (
          <div className="flex items-center justify-center py-6 text-[#6B6B80]">
            <CircleNotch className="h-4 w-4 animate-spin text-[#00F0FF] mr-2" />
            <span className="text-xs font-mono">Loading insights...</span>
          </div>
        )}

        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
              <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                {summary.nativeSymbol}
              </div>
              <div className="text-sm font-bold font-mono text-[#E8E8ED]">
                {formatNumber(summary.nativeBalance)}
              </div>
              <div className="text-[10px] font-mono text-[#6B6B80]">
                {formatUsdCompact(summary.nativeBalanceUsd)}
              </div>
            </div>
            <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
              <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                Stablecoins
              </div>
              <div className="text-sm font-bold font-mono text-[#00FF88]">
                {formatUsdCompact(summary.stablecoinTotal)}
              </div>
            </div>
            <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
              <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                Portfolio
              </div>
              <div className="text-sm font-bold font-mono text-[#A855F7]">
                {formatUsdCompact(summary.totalPortfolioUsd)}
              </div>
            </div>
            <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
              <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                Positions
              </div>
              <div className="text-sm font-bold font-mono text-[#E8E8ED]">
                {summary.activePositions.length}
              </div>
            </div>
          </div>
        )}

        {!summaryLoading && !summary && (
          <div className="text-center py-4 text-[#6B6B80] text-xs font-mono">
            Failed to load wallet data
          </div>
        )}
      </div>

      {/* Expanded body — lazy-loaded */}
      {expanded && (
        <div className="px-5 pb-5 border-t border-white/[0.04] pt-4 space-y-4">
          {quickViewLoading && !quickView && (
            <div className="flex items-center justify-center py-8 text-[#6B6B80]">
              <CircleNotch className="h-4 w-4 animate-spin text-[#00F0FF] mr-2" />
              <span className="text-xs font-mono">Loading detailed data...</span>
            </div>
          )}

          {quickView && (
            <>
              {/* PnL stats — Solana only */}
              {isSolana ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
                      <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                        30d PnL
                      </div>
                      <div className={`text-sm font-bold font-mono ${quickView.pnl30d >= 0 ? "text-[#00FF88]" : "text-[#FF3B5C]"}`}>
                        {quickView.pnl30d >= 0 ? "+" : ""}{formatUsdCompact(quickView.pnl30d)}
                      </div>
                    </div>
                    <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
                      <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                        7d PnL
                      </div>
                      <div className={`text-sm font-bold font-mono ${quickView.pnl7d >= 0 ? "text-[#00FF88]" : "text-[#FF3B5C]"}`}>
                        {quickView.pnl7d >= 0 ? "+" : ""}{formatUsdCompact(quickView.pnl7d)}
                      </div>
                    </div>
                    {quickView.bestTrade30d && (
                      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
                        <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                          Best 30d
                        </div>
                        <div className="text-sm font-bold font-mono text-[#00FF88]">
                          {quickView.bestTrade30d.symbol}
                        </div>
                        <div className="text-[10px] font-mono text-[#6B6B80]">
                          +{formatUsdCompact(quickView.bestTrade30d.pnl)}
                        </div>
                      </div>
                    )}
                    {quickView.bestTrade7d && (
                      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
                        <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1">
                          Best 7d
                        </div>
                        <div className="text-sm font-bold font-mono text-[#00FF88]">
                          {quickView.bestTrade7d.symbol}
                        </div>
                        <div className="text-[10px] font-mono text-[#6B6B80]">
                          +{formatUsdCompact(quickView.bestTrade7d.pnl)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-[10px] font-mono text-[#6B6B80] bg-white/[0.02] border border-white/[0.04] rounded-lg px-3 py-2">
                  PnL data available for Solana wallets only
                </div>
              )}

              {/* Active positions table */}
              {quickView.activePositions.length > 0 && (
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-2">
                    Active Positions
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {quickView.activePositions.map((pos) => (
                      <Link
                        key={pos.tokenAddress}
                        href={`/token/${pos.chain}/${pos.tokenAddress}`}
                        target="_blank"
                        className="rounded-lg bg-white/[0.03] border border-white/[0.04] px-3 py-2.5 hover:bg-white/[0.06] hover:border-white/[0.08] transition-colors block"
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          {pos.logoUrl ? (
                            <img
                              src={pos.logoUrl}
                              alt={pos.symbol}
                              className="h-5 w-5 rounded-full shrink-0"
                              onError={(e) => { e.currentTarget.style.display = "none"; }}
                            />
                          ) : (
                            <div className="h-5 w-5 rounded-full bg-white/[0.06] shrink-0" />
                          )}
                          <span className="text-[11px] font-mono font-semibold text-[#E8E8ED] truncate">
                            {pos.symbol}
                          </span>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigator.clipboard.writeText(pos.tokenAddress);
                              showToast("Copied token address successfully");
                            }}
                            className="text-[#6B6B80] hover:text-[#E8E8ED] transition-colors shrink-0"
                            title="Copy token address"
                          >
                            <Copy size={12} />
                          </button>
                          <span className="text-[10px] font-mono text-[#6B6B80] whitespace-nowrap ml-auto">
                            {formatUsdCompact(pos.balanceUsd)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[9px] font-mono">
                          <span className="text-[#6B6B80]">
                            🛒 Bought <span className="text-[#00C48C]">{formatUsdCompact(pos.totalBoughtUsd)}</span>
                          </span>
                          <span className="text-[#6B6B80]">
                            💰 Sold <span className="text-[#FF3B5C]">{formatUsdCompact(pos.totalSoldUsd)}</span>
                          </span>
                          <span className={`ml-auto font-semibold ${pos.unrealizedPnl >= 0 ? "text-[#00C48C]" : "text-[#FF3B5C]"}`}>
                            📊 {pos.unrealizedPnl >= 0 ? "+" : ""}{formatUsdCompact(pos.unrealizedPnl)}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* Fresh buys 7d — Solana only */}
              {isSolana && quickView.freshBuys7d.length > 0 && (
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-2">
                    Fresh Buys (7d, no sells)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {quickView.freshBuys7d.map((fb) => (
                      <Link
                        key={fb.tokenAddress}
                        href={`/token/solana/${fb.tokenAddress}`}
                        target="_blank"
                        className="rounded-lg bg-[#00FF88]/[0.04] border border-[#00FF88]/[0.08] px-3 py-2.5 hover:bg-[#00FF88]/[0.08] transition-colors block"
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          {fb.logoUrl ? (
                            <img
                              src={fb.logoUrl}
                              alt={fb.symbol}
                              className="h-5 w-5 rounded-full shrink-0"
                              onError={(e) => { e.currentTarget.style.display = "none"; }}
                            />
                          ) : (
                            <div className="h-5 w-5 rounded-full bg-[#00FF88]/[0.12] flex items-center justify-center text-[8px] font-bold text-[#00FF88] shrink-0">
                              {fb.symbol.slice(0, 2)}
                            </div>
                          )}
                          <span className="text-[11px] font-mono font-semibold text-[#E8E8ED] truncate">
                            {fb.symbol}
                          </span>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigator.clipboard.writeText(fb.tokenAddress);
                              showToast("Copied token address successfully");
                            }}
                            className="text-[#6B6B80] hover:text-[#E8E8ED] transition-colors shrink-0"
                            title="Copy token address"
                          >
                            <Copy size={12} />
                          </button>
                          <div className="flex items-center gap-1 ml-auto shrink-0">
                            {fb.twitter && (
                              <a
                                href={fb.twitter}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[#6B6B80] hover:text-[#1DA1F2] transition-colors"
                                title="Twitter / X"
                              >
                                <XLogo size={12} />
                              </a>
                            )}
                            {fb.telegram && (
                              <a
                                href={fb.telegram}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[#6B6B80] hover:text-[#26A5E4] transition-colors"
                                title="Telegram"
                              >
                                <TelegramLogo size={12} />
                              </a>
                            )}
                            {fb.website && (
                              <a
                                href={fb.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[#6B6B80] hover:text-[#E8E8ED] transition-colors"
                                title="Website"
                              >
                                <Globe size={12} />
                              </a>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 flex-wrap text-[9px] font-mono">
                          <span className="text-[#6B6B80]">
                            🛒 Bought <span className="text-[#00FF88]">{formatUsdCompact(fb.boughtUsd)}</span>
                          </span>
                          {fb.marketCap != null && (
                            <span className="text-[#6B6B80]">
                              📊 MC <span className="text-[#A855F7]">{formatUsdCompact(fb.marketCap)}</span>
                            </span>
                          )}
                          <span className="text-[#6B6B80]">
                            🕐 {formatRelativeTime(fb.buyTimestamp)}
                          </span>
                          <span className="text-[#6B6B80]">
                            ⏳ Held {formatHoldDuration(fb.buyTimestamp)}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* Fresh buys 30d — Solana only */}
              {isSolana && quickView.freshBuys30d.length > 0 && (
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-[#6B6B80] mb-2">
                    Fresh Buys (30d, no sells)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {quickView.freshBuys30d.map((fb) => (
                      <Link
                        key={fb.tokenAddress}
                        href={`/token/solana/${fb.tokenAddress}`}
                        target="_blank"
                        className="rounded-lg bg-[#00F0FF]/[0.04] border border-[#00F0FF]/[0.08] px-3 py-2.5 hover:bg-[#00F0FF]/[0.08] transition-colors block"
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          {fb.logoUrl ? (
                            <img
                              src={fb.logoUrl}
                              alt={fb.symbol}
                              className="h-5 w-5 rounded-full shrink-0"
                              onError={(e) => { e.currentTarget.style.display = "none"; }}
                            />
                          ) : (
                            <div className="h-5 w-5 rounded-full bg-[#00F0FF]/[0.12] flex items-center justify-center text-[8px] font-bold text-[#00F0FF] shrink-0">
                              {fb.symbol.slice(0, 2)}
                            </div>
                          )}
                          <span className="text-[11px] font-mono font-semibold text-[#E8E8ED] truncate">
                            {fb.symbol}
                          </span>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigator.clipboard.writeText(fb.tokenAddress);
                              showToast("Copied token address successfully");
                            }}
                            className="text-[#6B6B80] hover:text-[#E8E8ED] transition-colors shrink-0"
                            title="Copy token address"
                          >
                            <Copy size={12} />
                          </button>
                          <div className="flex items-center gap-1 ml-auto shrink-0">
                            {fb.twitter && (
                              <a
                                href={fb.twitter}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[#6B6B80] hover:text-[#1DA1F2] transition-colors"
                                title="Twitter / X"
                              >
                                <XLogo size={12} />
                              </a>
                            )}
                            {fb.telegram && (
                              <a
                                href={fb.telegram}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[#6B6B80] hover:text-[#26A5E4] transition-colors"
                                title="Telegram"
                              >
                                <TelegramLogo size={12} />
                              </a>
                            )}
                            {fb.website && (
                              <a
                                href={fb.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[#6B6B80] hover:text-[#E8E8ED] transition-colors"
                                title="Website"
                              >
                                <Globe size={12} />
                              </a>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 flex-wrap text-[9px] font-mono">
                          <span className="text-[#6B6B80]">
                            🛒 Bought <span className="text-[#00F0FF]">{formatUsdCompact(fb.boughtUsd)}</span>
                          </span>
                          {fb.marketCap != null && (
                            <span className="text-[#6B6B80]">
                              📊 MC <span className="text-[#A855F7]">{formatUsdCompact(fb.marketCap)}</span>
                            </span>
                          )}
                          <span className="text-[#6B6B80]">
                            🕐 {formatRelativeTime(fb.buyTimestamp)}
                          </span>
                          <span className="text-[#6B6B80]">
                            ⏳ Held {formatHoldDuration(fb.buyTimestamp)}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {!quickViewLoading && !quickView && (
            <div className="text-center py-4 text-[#6B6B80] text-xs font-mono">
              Failed to load detailed data
            </div>
          )}
        </div>
      )}
    </div>
  );
}
