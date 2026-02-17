"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyAddress } from "@/components/shared/copy-address";
import { formatUsd, formatTimeAgo } from "@/lib/utils";
import {
  ShieldCheck,
  Activity,
  DollarSign,
  BarChart3,
  Clock,
  ArrowRight,
  Loader2,
  Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";
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

interface DexOrdersPage {
  data: DexOrderToken[];
  hasMore: boolean;
  nextOffset: number | null;
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

function useDexOrders(period: Period) {
  return useInfiniteQuery<DexOrdersPage>({
    queryKey: ["dex-orders", period],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        period,
        offset: String(pageParam ?? 0),
      });
      const res = await fetch(`/api/dex-orders?${params}`);
      return res.json();
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextOffset ?? undefined) : undefined,
  });
}

const PAGE_SIZE = 100;

export default function DexOrdersPage() {
  const [period, setPeriod] = useState<Period>("8h");
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const {
    data,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useDexOrders(period);

  // Auto-fetch all batches
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Reset visible count when period changes
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [period]);

  // Deduplicate tokens across all pages
  const tokens = useMemo(() => {
    if (!data?.pages) return [];
    const seen = new Set<string>();
    const result: DexOrderToken[] = [];
    for (const page of data.pages) {
      for (const token of page.data) {
        if (!seen.has(token.address)) {
          seen.add(token.address);
          result.push(token);
        }
      }
    }
    return result;
  }, [data]);

  // Progress tracking
  const lastPage = data?.pages?.[data.pages.length - 1];
  const totalChecked = lastPage?.totalChecked ?? 0;
  const totalTokens = lastPage?.totalTokens ?? 0;
  const scanComplete = !hasNextPage && !isFetchingNextPage && !isLoading;

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
              <Activity className="h-3 w-3 text-[#00FF88]" />
              <span className="text-xs font-mono text-[#6B6B80]">
                Pump.fun tokens with DexScreener profiles
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {!scanComplete && totalTokens > 0 && (
        <div className="glow-card rounded-xl p-4 animate-fade-up">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 text-[#00F0FF] animate-spin" />
              <span className="text-xs font-mono text-[#6B6B80]">
                Checking tokens for DexScreener orders...
              </span>
            </div>
            <span className="text-xs font-mono text-[#E8E8ED]">
              {totalChecked} / {totalTokens}
            </span>
          </div>
          <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[#00F0FF] to-[#00FF88] rounded-full transition-all duration-500"
              style={{
                width: `${totalTokens > 0 ? (totalChecked / totalTokens) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          {
            label: "WITH ORDERS",
            value: tokens.length ? tokens.length.toLocaleString() : "--",
            icon: ShieldCheck,
            color: "#00FF88",
          },
          {
            label: "DEX PAID",
            value: dexPaidCount ? dexPaidCount.toLocaleString() : "--",
            icon: DollarSign,
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
              Tokens with DexScreener Orders
            </span>
          </div>
          {scanComplete && (
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-[#00FF88]" />
              <span className="text-[10px] font-mono text-[#00FF88]/70">
                COMPLETE
              </span>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.04]">
                {["Token", "Price", "FDV", "Trades", "Age", "Tags", ""].map(
                  (h) => (
                    <th
                      key={h}
                      className={`text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80] px-5 py-3 ${
                        ["Price", "FDV", "Trades", "Age", "Tags", ""].includes(h)
                          ? "text-right"
                          : "text-left"
                      }`}
                    >
                      {h}
                    </th>
                  )
                )}
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
                      <td className="px-5 py-3.5">
                        <Skeleton className="h-4 w-16 ml-auto shimmer" />
                      </td>
                      <td className="px-5 py-3.5">
                        <Skeleton className="h-4 w-16 ml-auto shimmer" />
                      </td>
                      <td className="px-5 py-3.5">
                        <Skeleton className="h-4 w-16 ml-auto shimmer" />
                      </td>
                      <td className="px-5 py-3.5">
                        <Skeleton className="h-4 w-12 ml-auto shimmer" />
                      </td>
                      <td className="px-5 py-3.5">
                        <Skeleton className="h-4 w-16 ml-auto shimmer" />
                      </td>
                      <td className="px-5 py-3.5">
                        <Skeleton className="h-4 w-4 ml-auto shimmer" />
                      </td>
                    </tr>
                  ))
                : visibleTokens.map((token) => {
                    const createdTs = Math.floor(
                      new Date(token.createdAt).getTime() / 1000
                    );
                    return (
                      <tr
                        key={token.address}
                        className="border-b border-white/[0.03] table-row-hover group"
                      >
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
                        <td className="px-5 py-3.5 text-right">
                          <span className="text-sm font-mono font-medium text-[#E8E8ED]">
                            {token.priceUsd != null
                              ? formatPrice(token.priceUsd)
                              : "\u2014"}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <span className="text-sm font-mono text-[#6B6B80]">
                            {formatUsd(token.fdv)}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <BarChart3 className="h-3 w-3 text-[#00F0FF]/40" />
                            <span className="text-sm font-mono text-[#6B6B80]">
                              {token.tradeCount?.toLocaleString() ?? "—"}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <Clock className="h-3 w-3 text-[#FFB800]/50" />
                            <span className="text-[11px] font-mono text-[#FFB800]">
                              {formatTimeAgo(createdTs)}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            {token.tags.map((tag) => (
                              <TagBadge key={tag} tag={tag} />
                            ))}
                          </div>
                        </td>
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

        {/* Loading more rows spinner */}
        {hasMoreToShow && (
          <div className="flex items-center justify-center gap-2 py-6">
            <Loader2 className="h-4 w-4 text-[#00FF88] animate-spin" />
            <span className="text-xs font-mono text-[#6B6B80]">
              Showing {visibleTokens.length} of {tokens.length} tokens...
            </span>
          </div>
        )}

        {/* Scanning in progress */}
        {!scanComplete && !isLoading && tokens.length === 0 && (
          <div className="text-center py-16 text-[#6B6B80]">
            <Loader2 className="h-8 w-8 mx-auto mb-3 animate-spin opacity-30" />
            <p className="text-sm">Scanning tokens...</p>
            <p className="text-xs mt-1 opacity-60">
              Checking DexScreener orders for pump.fun tokens
            </p>
          </div>
        )}

        {/* All displayed message */}
        {scanComplete && tokens.length > 0 && !hasMoreToShow && (
          <div className="text-center py-4 border-t border-white/[0.04]">
            <span className="text-[10px] font-mono text-[#6B6B80]">
              {tokens.length.toLocaleString()} token{tokens.length !== 1 ? "s" : ""} with orders found out of {totalTokens.toLocaleString()} checked
            </span>
          </div>
        )}

        {/* Empty state */}
        {scanComplete && tokens.length === 0 && (
          <div className="text-center py-16 text-[#6B6B80]">
            <ShieldCheck className="h-8 w-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No tokens with DexScreener orders found</p>
            <p className="text-xs mt-1 opacity-60">
              Try a longer time period
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
