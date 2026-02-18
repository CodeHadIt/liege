"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyAddress } from "@/components/shared/copy-address";
import { formatUsd, formatTimeAgo } from "@/lib/utils";
import {
  ShieldCheck,
  Pulse,
  CurrencyDollarSimple,
  ChartBar,
  Clock,
  ArrowRight,
  Tag,
  Globe,
  XLogo,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { REFETCH_INTERVALS } from "@/config/constants";
import type { DexOrderToken, DexOrderTag } from "@/types/token";

type Period = "30m" | "1h" | "2h" | "4h" | "8h";

const SUBSCRIPT_DIGITS = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089";

function formatPrice(price: number): string {
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  const str = price.toFixed(20);
  const afterDot = str.split(".")[1] ?? "";
  let zeros = 0;
  for (const ch of afterDot) {
    if (ch === "0") zeros++;
    else break;
  }
  const significant = afterDot.slice(zeros, zeros + 4);
  const subscript = String(zeros)
    .split("")
    .map((d) => SUBSCRIPT_DIGITS[parseInt(d)])
    .join("");
  return `$0.0${subscript}${significant}`;
}

interface DexOrdersResponse {
  data: DexOrderToken[];
  totalProfiles: number;
  period: string;
  hasMore: boolean;
  totalChecked: number;
  totalTokens: number;
}

const PERIODS: { value: Period; label: string }[] = [
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "2h", label: "2h" },
  { value: "4h", label: "4h" },
  { value: "8h", label: "8h" },
];

function TagBadge({ tag }: { tag: DexOrderTag }) {
  if (tag === "dexPaid") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-[#00FF88]/10 text-[#00FF88] border border-[#00FF88]/20">
        DEX PAID
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-[#FFB800]/10 text-[#FFB800] border border-[#FFB800]/20">
      CTO
    </span>
  );
}

const PAGE_SIZE = 100;

export default function DexOrdersPage() {
  const [period, setPeriod] = useState<Period>("8h");
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);

  const { data: response, isLoading } = useQuery<DexOrdersResponse>({
    queryKey: ["dex-orders", period],
    queryFn: async () => {
      const res = await fetch(`/api/dex-orders?period=${period}`);
      return res.json();
    },
    refetchInterval: REFETCH_INTERVALS.DEX_ORDERS,
  });

  const tokens = response?.data ?? [];
  const totalProfiles = response?.totalProfiles ?? 0;

  // Reset visible count when period changes
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [period]);

  const dexPaidCount = tokens.filter((t) => t.tags.includes("dexPaid")).length;
  const ctoCount = tokens.filter((t) => t.tags.includes("cto")).length;

  const visibleTokens = tokens.slice(0, displayCount);
  const hasMoreToShow = displayCount < tokens.length;

  // IntersectionObserver for progressive rendering
  const sentinelRef = useRef<HTMLDivElement>(null);

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting && hasMoreToShow) {
        setDisplayCount((prev) => prev + PAGE_SIZE);
      }
    },
    [hasMoreToShow]
  );

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(handleIntersect, {
      rootMargin: "200px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleIntersect]);

  const TABLE_HEADERS = [
    { label: "Token", align: "left" },
    { label: "Price", align: "right" },
    { label: "FDV", align: "right" },
    { label: "Created", align: "right" },
    { label: "Discovered", align: "right" },
    { label: "Links", align: "right" },
    { label: "Tags", align: "right" },
    { label: "", align: "right" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-up">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#00FF88]/20 to-[#00FF88]/5 border border-[#00FF88]/10 flex items-center justify-center">
            <ShieldCheck className="h-5 w-5 text-[#00FF88]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Dex Orders
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00FF88] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00FF88]" />
              </span>
              <span className="text-xs font-mono text-[#6B6B80]">
                Live &middot; {totalProfiles} profiles tracked
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          {
            label: "WITH PROFILES",
            value: tokens.length ? tokens.length.toLocaleString() : "--",
            icon: ShieldCheck,
            color: "#00FF88",
          },
          {
            label: "DEX PAID",
            value: dexPaidCount ? dexPaidCount.toLocaleString() : "--",
            icon: CurrencyDollarSimple,
            color: "#00FF88",
          },
          {
            label: "CTO",
            value: ctoCount ? ctoCount.toLocaleString() : "--",
            icon: Tag,
            color: "#FFB800",
          },
        ].map((stat, i) => (
          <div
            key={stat.label}
            className={`glow-card stat-card rounded-xl p-4 animate-fade-up stagger-${i + 1}`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
                {stat.label}
              </span>
              <stat.icon
                className="h-4 w-4"
                style={{ color: stat.color, opacity: 0.5 }}
              />
            </div>
            <div className="text-2xl font-bold font-mono">{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Period selector */}
      <div className="flex gap-1 bg-white/[0.02] rounded-xl p-1 border border-white/[0.04] animate-fade-up stagger-4">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={cn(
              "px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-all flex-1 text-center",
              period === p.value
                ? "bg-[#00FF88]/10 text-[#00FF88] shadow-[0_0_12px_rgba(0,255,136,0.08)]"
                : "text-[#6B6B80] hover:text-[#E8E8ED]"
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Token table */}
      <div className="glow-card rounded-xl overflow-hidden animate-fade-up">
        <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[#00FF88]/50" />
            <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
              Tokens with DexScreener Profiles
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00FF88] opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#00FF88]" />
            </span>
            <span className="text-[10px] font-mono text-[#00FF88]/70">
              LIVE
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.04]">
                {TABLE_HEADERS.map((h) => (
                  <th
                    key={h.label}
                    className={`text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80] px-5 py-3 text-${h.align}`}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-white/[0.03]">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-8 w-8 rounded-full shimmer" />
                          <div className="space-y-1.5">
                            <Skeleton className="h-3.5 w-24 shimmer" />
                            <Skeleton className="h-2.5 w-20 shimmer" />
                          </div>
                        </div>
                      </td>
                      {Array.from({ length: 7 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5">
                          <Skeleton className="h-4 w-16 ml-auto shimmer" />
                        </td>
                      ))}
                    </tr>
                  ))
                : visibleTokens.map((token) => {
                    const createdTs = Math.floor(
                      new Date(token.createdAt).getTime() / 1000
                    );
                    const discoveredTs = Math.floor(
                      new Date(token.discoveredAt).getTime() / 1000
                    );
                    return (
                      <tr
                        key={token.address}
                        className="border-b border-white/[0.03] table-row-hover group"
                      >
                        {/* Token */}
                        <td className="px-5 py-3.5">
                          <Link
                            href={`/token/solana/${token.address}`}
                            className="flex items-center gap-3"
                          >
                            {token.logoUrl ? (
                              <img
                                src={token.logoUrl}
                                alt={token.symbol}
                                className="h-8 w-8 rounded-full ring-1 ring-white/[0.06]"
                              />
                            ) : (
                              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[#00FF88]/15 to-[#00F0FF]/15 flex items-center justify-center text-[10px] font-bold text-[#00FF88] ring-1 ring-white/[0.06]">
                                {token.symbol.slice(0, 2)}
                              </div>
                            )}
                            <div>
                              <span className="font-semibold text-sm text-[#E8E8ED] group-hover:text-[#00FF88] transition-colors">
                                {token.symbol}
                              </span>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-[10px] text-[#6B6B80] truncate max-w-[120px]">
                                  {token.name}
                                </span>
                                <CopyAddress
                                  address={token.address}
                                  className="opacity-50 hover:opacity-100"
                                />
                              </div>
                            </div>
                          </Link>
                        </td>

                        {/* Price */}
                        <td className="px-5 py-3.5 text-right">
                          <span className="text-sm font-mono font-medium text-[#E8E8ED]">
                            {token.priceUsd != null
                              ? formatPrice(token.priceUsd)
                              : "\u2014"}
                          </span>
                        </td>

                        {/* FDV */}
                        <td className="px-5 py-3.5 text-right">
                          <span className="text-sm font-mono text-[#6B6B80]">
                            {formatUsd(token.fdv)}
                          </span>
                        </td>

                        {/* Created (token creation time) */}
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <Clock className="h-3 w-3 text-[#6B6B80]/50" />
                            <span className="text-[11px] font-mono text-[#6B6B80]">
                              {formatTimeAgo(createdTs)}
                            </span>
                          </div>
                        </td>

                        {/* Discovered (dex order time) */}
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <ShieldCheck className="h-3 w-3 text-[#00FF88]/50" />
                            <span className="text-[11px] font-mono text-[#00FF88]">
                              {formatTimeAgo(discoveredTs)}
                            </span>
                          </div>
                        </td>

                        {/* Links */}
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center gap-2 justify-end">
                            {token.url && (
                              <a
                                href={token.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[#6B6B80] hover:text-[#00F0FF] transition-colors"
                                title="Website"
                              >
                                <Globe className="h-3.5 w-3.5" />
                              </a>
                            )}
                            {token.twitter && (
                              <a
                                href={token.twitter}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[#6B6B80] hover:text-[#1DA1F2] transition-colors"
                                title="Twitter"
                              >
                                <XLogo className="h-3.5 w-3.5" />
                              </a>
                            )}
                            {!token.url && !token.twitter && (
                              <span className="text-[#6B6B80]/30">
                                <ArrowSquareOut className="h-3.5 w-3.5" />
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Tags */}
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            {token.tags.map((tag) => (
                              <TagBadge key={tag} tag={tag} />
                            ))}
                          </div>
                        </td>

                        {/* Arrow */}
                        <td className="px-5 py-3.5 text-right">
                          <ArrowRight className="h-3.5 w-3.5 text-[#6B6B80]/0 group-hover:text-[#00FF88]/50 transition-all ml-auto" />
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>

        {/* Sentinel for IntersectionObserver */}
        <div ref={sentinelRef} />

        {/* Loading more rows */}
        {hasMoreToShow && (
          <div className="flex items-center justify-center gap-2 py-6">
            <Pulse className="h-4 w-4 text-[#00FF88] animate-pulse" />
            <span className="text-xs font-mono text-[#6B6B80]">
              Showing {visibleTokens.length} of {tokens.length} tokens...
            </span>
          </div>
        )}

        {/* All displayed message */}
        {!isLoading && tokens.length > 0 && !hasMoreToShow && (
          <div className="text-center py-4 border-t border-white/[0.04]">
            <span className="text-[10px] font-mono text-[#6B6B80]">
              {tokens.length.toLocaleString()} token{tokens.length !== 1 ? "s" : ""} with profiles &middot; auto-refreshing every 30s
            </span>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && tokens.length === 0 && (
          <div className="text-center py-16 text-[#6B6B80]">
            <ShieldCheck className="h-8 w-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No tokens with DexScreener profiles found</p>
            <p className="text-xs mt-1 opacity-60">
              Profiles accumulate over time — try a longer period or wait a few minutes
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
