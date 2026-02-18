"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyAddress } from "@/components/shared/copy-address";
import { formatUsd, formatTimeAgo } from "@/lib/utils";
import {
  Rocket,
  Pulse,
  CurrencyDollarSimple,
  Drop,
  Clock,
  ArrowRight,
  CircleNotch,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { PumpFunToken } from "@/types/token";

type Period = "latest" | "1h" | "4h" | "6h" | "24h" | "1w";

const PERIOD_LABELS: Record<Period, string> = {
  latest: "LAUNCHED",
  "1h": "LAUNCHED (1H)",
  "4h": "LAUNCHED (4H)",
  "6h": "LAUNCHED (6H)",
  "24h": "LAUNCHED (24H)",
  "1w": "LAUNCHED (1W)",
};

const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

function formatPrice(price: number): string {
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  // Count zeros after "0." to build $0.0₅1234 notation
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

interface PumpFunPage {
  data: PumpFunToken[];
  nextCursor: string | null;
  hasMore: boolean;
}

const PERIODS: { value: Period; label: string }[] = [
  { value: "latest", label: "Latest" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "1w", label: "1w" },
];

function usePumpFunTokens(period: Period) {
  return useInfiniteQuery<PumpFunPage>({
    queryKey: ["pump-fun", period],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ period });
      if (pageParam) params.set("cursor", pageParam as string);
      const res = await fetch(`/api/pump-fun?${params}`);
      return res.json();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
  });
}

const PAGE_SIZE = 100;

export default function PumpFunPage() {
  const [period, setPeriod] = useState<Period>("latest");
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const {
    data,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = usePumpFunTokens(period);

  // Auto-fetch ALL pages in background for accurate total count
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Reset visible count when period changes
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [period]);

  // Deduplicate tokens across all fetched pages
  const tokens = (() => {
    if (!data?.pages) return [];
    const seen = new Set<string>();
    const result: PumpFunToken[] = [];
    for (const page of data.pages) {
      for (const token of page.data) {
        if (!seen.has(token.address)) {
          seen.add(token.address);
          result.push(token);
        }
      }
    }
    return result;
  })();

  const visibleTokens = tokens.slice(0, displayCount);
  const hasMoreToShow = displayCount < tokens.length;
  const allPagesFetched = !hasNextPage;

  // IntersectionObserver to reveal more rows on scroll
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

  const highestFdv = tokens.length
    ? [...tokens].sort((a, b) => (b.fdv ?? 0) - (a.fdv ?? 0))[0]
    : null;

  const latestLaunch = tokens.length
    ? [...tokens].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )[0]
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-up">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#A855F7]/20 to-[#A855F7]/5 border border-[#A855F7]/10 flex items-center justify-center">
            <Rocket className="h-5 w-5 text-[#A855F7]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Pump.fun Tokens
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <Pulse className="h-3 w-3 text-[#00FF88]" />
              <span className="text-xs font-mono text-[#6B6B80]">
                Scroll to load more
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          {
            label: PERIOD_LABELS[period],
            value: tokens.length
              ? `${tokens.length.toLocaleString()}${allPagesFetched ? "" : "+"}`
              : "--",
            icon: Rocket,
            color: "#A855F7",
          },
          {
            label: "HIGHEST FDV",
            value: highestFdv ? formatUsd(highestFdv.fdv) : "--",
            icon: CurrencyDollarSimple,
            color: "#00F0FF",
          },
          {
            label: "LATEST LAUNCH",
            value: latestLaunch
              ? latestLaunch.symbol
              : "--",
            icon: Clock,
            color: "#00FF88",
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
                ? "bg-[#A855F7]/10 text-[#A855F7] shadow-[0_0_12px_rgba(168,85,247,0.08)]"
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
            <Rocket className="h-4 w-4 text-[#A855F7]/50" />
            <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
              Pump.fun New Tokens
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-[#00FF88] pulse-dot" />
            <span className="text-[10px] font-mono text-[#00FF88]/70">
              LIVE
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.04]">
                {["Token", "Price", "FDV", "Liquidity", "Age", ""].map((h) => (
                  <th
                    key={h}
                    className={`text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80] px-5 py-3 ${
                      ["Price", "FDV", "Liquidity", "Age", ""].includes(h)
                        ? "text-right"
                        : "text-left"
                    }`}
                  >
                    {h}
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
                              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[#A855F7]/15 to-[#FF3B5C]/15 flex items-center justify-center text-[10px] font-bold text-[#A855F7] ring-1 ring-white/[0.06]">
                                {token.symbol.slice(0, 2)}
                              </div>
                            )}
                            <div>
                              <span className="font-semibold text-sm text-[#E8E8ED] group-hover:text-[#A855F7] transition-colors">
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
                            <Drop className="h-3 w-3 text-[#00F0FF]/40" />
                            <span className="text-sm font-mono text-[#6B6B80]">
                              {formatUsd(token.liquidity)}
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
                          <ArrowRight className="h-3.5 w-3.5 text-[#6B6B80]/0 group-hover:text-[#A855F7]/50 transition-all ml-auto" />
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
            <CircleNotch className="h-4 w-4 text-[#A855F7] animate-spin" />
            <span className="text-xs font-mono text-[#6B6B80]">
              Showing {visibleTokens.length} of {tokens.length}{allPagesFetched ? "" : "+"} tokens...
            </span>
          </div>
        )}

        {/* All displayed message */}
        {!isLoading && !hasMoreToShow && allPagesFetched && tokens.length > 0 && (
          <div className="text-center py-4 border-t border-white/[0.04]">
            <span className="text-[10px] font-mono text-[#6B6B80]">
              All {tokens.length.toLocaleString()} tokens loaded
            </span>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && tokens.length === 0 && (
          <div className="text-center py-16 text-[#6B6B80]">
            <Rocket className="h-8 w-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No pump.fun tokens found</p>
            <p className="text-xs mt-1 opacity-60">
              Try a different time period
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
