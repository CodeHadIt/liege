"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
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
  SortAscending,
  SortDescending,
  TrendUp,
  TrendDown,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { REFETCH_INTERVALS } from "@/config/constants";
import type { DexOrderToken, DexOrderTag } from "@/types/token";

type Period = "30m" | "1h" | "2h" | "4h" | "8h";
type BondedFilter = "all" | "bonded" | "notBonded";
type SortField = "dexPaid" | "created";
type SortOrder = "newest" | "oldest";

const FDV_RANGES = [
  { value: "all", label: "All" },
  { value: "0-5k", label: "≤5K" },
  { value: "5k-10k", label: "5-10K" },
  { value: "10k-20k", label: "10-20K" },
  { value: "20k-50k", label: "20-50K" },
  { value: "50k-100k", label: "50-100K" },
  { value: "100k-500k", label: "100K-500K" },
  { value: "500k-1m", label: "500K-1M" },
  { value: "1m+", label: "1M+" },
] as const;

const AGE_RANGES = [
  { value: "all", label: "All" },
  { value: "0-5m", label: "≤5m" },
  { value: "5m-15m", label: "5-15m" },
  { value: "15m-30m", label: "15-30m" },
  { value: "30m-1h", label: "30m-1h" },
  { value: "1h-2h", label: "1-2h" },
  { value: "2h-6h", label: "2-6h" },
  { value: "6h-24h", label: "6-24h" },
  { value: "24h+", label: "24h+" },
] as const;

type AgeFilter = (typeof AGE_RANGES)[number]["value"];

function matchesAgeRange(createdAt: string, range: AgeFilter): boolean {
  if (range === "all") return true;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const mins = ageMs / 60_000;
  const hrs = mins / 60;
  switch (range) {
    case "0-5m": return mins <= 5;
    case "5m-15m": return mins > 5 && mins <= 15;
    case "15m-30m": return mins > 15 && mins <= 30;
    case "30m-1h": return mins > 30 && hrs <= 1;
    case "1h-2h": return hrs > 1 && hrs <= 2;
    case "2h-6h": return hrs > 2 && hrs <= 6;
    case "6h-24h": return hrs > 6 && hrs <= 24;
    case "24h+": return hrs > 24;
    default: return true;
  }
}

type FdvFilter = (typeof FDV_RANGES)[number]["value"];

function matchesFdvRange(fdv: number | null, range: FdvFilter): boolean {
  if (range === "all") return true;
  if (fdv == null) return false;
  switch (range) {
    case "0-5k": return fdv <= 5_000;
    case "5k-10k": return fdv > 5_000 && fdv <= 10_000;
    case "10k-20k": return fdv > 10_000 && fdv <= 20_000;
    case "20k-50k": return fdv > 20_000 && fdv <= 50_000;
    case "50k-100k": return fdv > 50_000 && fdv <= 100_000;
    case "100k-500k": return fdv > 100_000 && fdv <= 500_000;
    case "500k-1m": return fdv > 500_000 && fdv <= 1_000_000;
    case "1m+": return fdv > 1_000_000;
    default: return true;
  }
}

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
        DP
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

const STORAGE_KEY = "dex-orders-filters";

function loadFilters(): {
  period: Period;
  bondedFilter: BondedFilter;
  fdvFilter: FdvFilter;
  ageFilter: AgeFilter;
  sortField: SortField;
  sortOrder: SortOrder;
} {
  const defaults = { period: "8h" as Period, bondedFilter: "all" as BondedFilter, fdvFilter: "all" as FdvFilter, ageFilter: "all" as AgeFilter, sortField: "dexPaid" as SortField, sortOrder: "newest" as SortOrder };
  if (typeof window === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

export default function DexOrdersPage() {
  const [hydrated, setHydrated] = useState(false);
  const [period, setPeriod] = useState<Period>("8h");
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const [bondedFilter, setBondedFilter] = useState<BondedFilter>("all");
  const [fdvFilter, setFdvFilter] = useState<FdvFilter>("all");
  const [ageFilter, setAgeFilter] = useState<AgeFilter>("all");
  const [sortField, setSortField] = useState<SortField>("dexPaid");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");

  // Hydrate from localStorage on mount
  useEffect(() => {
    const saved = loadFilters();
    setPeriod(saved.period);
    setBondedFilter(saved.bondedFilter);
    setFdvFilter(saved.fdvFilter);
    setAgeFilter(saved.ageFilter);
    setSortField(saved.sortField);
    setSortOrder(saved.sortOrder);
    setHydrated(true);
  }, []);

  // Persist to localStorage on change
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ period, bondedFilter, fdvFilter, ageFilter, sortField, sortOrder }));
  }, [period, bondedFilter, fdvFilter, ageFilter, sortField, sortOrder, hydrated]);

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

  const filteredTokens = useMemo(() => {
    let result = tokens;

    // Bonded filter
    if (bondedFilter === "bonded") {
      result = result.filter((t) => t.liquidity != null && t.liquidity > 0);
    } else if (bondedFilter === "notBonded") {
      result = result.filter((t) => t.liquidity == null || t.liquidity === 0);
    }

    // Current MC filter (uses currentFdv, falls back to fdv if not yet refreshed)
    if (fdvFilter !== "all") {
      result = result.filter((t) => matchesFdvRange(t.currentFdv ?? t.fdv, fdvFilter));
    }

    // Created time filter
    if (ageFilter !== "all") {
      result = result.filter((t) => matchesAgeRange(t.createdAt, ageFilter));
    }

    // Sort by selected field
    result = [...result].sort((a, b) => {
      const aTime = sortField === "dexPaid"
        ? new Date(a.discoveredAt).getTime()
        : new Date(a.createdAt).getTime();
      const bTime = sortField === "dexPaid"
        ? new Date(b.discoveredAt).getTime()
        : new Date(b.createdAt).getTime();
      return sortOrder === "newest" ? bTime - aTime : aTime - bTime;
    });

    return result;
  }, [tokens, bondedFilter, fdvFilter, ageFilter, sortField, sortOrder]);

  const isFiltered = bondedFilter !== "all" || fdvFilter !== "all" || ageFilter !== "all";

  // Reset visible count when period or filters change
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [period, bondedFilter, fdvFilter, ageFilter, sortField, sortOrder]);

  const dexPaidCount = filteredTokens.filter((t) => t.tags.includes("dexPaid")).length;
  const ctoCount = filteredTokens.filter((t) => t.tags.includes("cto")).length;

  const visibleTokens = filteredTokens.slice(0, displayCount);
  const hasMoreToShow = displayCount < filteredTokens.length;

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
    { label: "Created", align: "right" },
    { label: "Dex Paid Time", align: "right" },
    { label: "MC at Dex Pay", align: "right" },
    { label: "Current MC", align: "right" },
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
            value: filteredTokens.length
              ? isFiltered
                ? `${filteredTokens.length.toLocaleString()} / ${tokens.length.toLocaleString()}`
                : filteredTokens.length.toLocaleString()
              : "--",
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
      <div className="space-y-1.5 animate-fade-up stagger-4">
        <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80] px-1">
          Dex Paid Within
        </span>
      <div className="flex gap-1 bg-white/[0.02] rounded-xl p-1 border border-white/[0.04]">
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
      </div>

      {/* Filters */}
      <div className="space-y-2 animate-fade-up">
        {/* Row 1: Bonded + Sort */}
        <div className="flex gap-3 flex-wrap">
          <div className="flex gap-1 bg-white/[0.02] rounded-xl p-1 border border-white/[0.04]">
            {(["all", "bonded", "notBonded"] as const).map((val) => {
              const labels: Record<BondedFilter, string> = {
                all: "All",
                bonded: "Bonded",
                notBonded: "Not Bonded",
              };
              return (
                <button
                  key={val}
                  onClick={() => setBondedFilter(val)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all",
                    bondedFilter === val
                      ? "bg-[#00FF88]/10 text-[#00FF88] shadow-[0_0_12px_rgba(0,255,136,0.08)]"
                      : "text-[#6B6B80] hover:text-[#E8E8ED]"
                  )}
                >
                  {labels[val]}
                </button>
              );
            })}
          </div>

          <div className="flex gap-1 bg-white/[0.02] rounded-xl p-1 border border-white/[0.04] ml-auto">
            {(["dexPaid", "created"] as const).map((val) => (
              <button
                key={val}
                onClick={() => setSortField(val)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all",
                  sortField === val
                    ? "bg-[#00FF88]/10 text-[#00FF88] shadow-[0_0_12px_rgba(0,255,136,0.08)]"
                    : "text-[#6B6B80] hover:text-[#E8E8ED]"
                )}
              >
                {val === "dexPaid" ? "Dex Paid" : "Created"}
              </button>
            ))}
            <div className="w-px bg-white/[0.06] mx-0.5" />
            {(["newest", "oldest"] as const).map((val) => (
              <button
                key={val}
                onClick={() => setSortOrder(val)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5",
                  sortOrder === val
                    ? "bg-[#00FF88]/10 text-[#00FF88] shadow-[0_0_12px_rgba(0,255,136,0.08)]"
                    : "text-[#6B6B80] hover:text-[#E8E8ED]"
                )}
              >
                {val === "newest" ? (
                  <SortDescending className="h-3.5 w-3.5" />
                ) : (
                  <SortAscending className="h-3.5 w-3.5" />
                )}
                {val === "newest" ? "Newest" : "Oldest"}
              </button>
            ))}
          </div>
        </div>

        {/* Row 2: FDV range */}
        <div className="space-y-1.5">
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80] px-1">
            Current MC
          </span>
        <div className="flex gap-1 bg-white/[0.02] rounded-xl p-1 border border-white/[0.04] flex-wrap">
          {FDV_RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setFdvFilter(r.value)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all",
                fdvFilter === r.value
                  ? "bg-[#00FF88]/10 text-[#00FF88] shadow-[0_0_12px_rgba(0,255,136,0.08)]"
                  : "text-[#6B6B80] hover:text-[#E8E8ED]"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        </div>

        {/* Row 3: Created time range */}
        <div className="space-y-1.5">
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80] px-1">
            Token Age
          </span>
        <div className="flex gap-1 bg-white/[0.02] rounded-xl p-1 border border-white/[0.04] flex-wrap">
          {AGE_RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setAgeFilter(r.value)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all",
                ageFilter === r.value
                  ? "bg-[#00FF88]/10 text-[#00FF88] shadow-[0_0_12px_rgba(0,255,136,0.08)]"
                  : "text-[#6B6B80] hover:text-[#E8E8ED]"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        </div>
      </div>

      {/* Token table */}
      <div className="glow-card rounded-xl animate-fade-up">
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
                      {Array.from({ length: 8 }).map((_, j) => (
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
                            <div className="relative group/img shrink-0">
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
                              {token.logoUrl && (
                                <div className="absolute left-0 top-full mt-2 hidden group-hover/img:block z-50 pointer-events-none h-28 w-28 rounded-xl ring-1 ring-white/10 shadow-xl shadow-black/60 overflow-hidden bg-black">
                                  <img
                                    src={token.logoUrl}
                                    alt={token.symbol}
                                    className="h-full w-full object-cover contrast-[1.05] brightness-[1.02]"
                                    style={{ imageRendering: "-webkit-optimize-contrast" }}
                                  />
                                </div>
                              )}
                            </div>
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

                        {/* Created (token creation time) */}
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <Clock className="h-3 w-3 text-[#6B6B80]/50" />
                            <span className="text-[11px] font-mono text-[#6B6B80]">
                              {formatTimeAgo(createdTs)}
                            </span>
                          </div>
                        </td>

                        {/* Dex Paid Time */}
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <ShieldCheck className="h-3 w-3 text-[#00FF88]/50" />
                            <span className="text-[11px] font-mono text-[#00FF88]">
                              {formatTimeAgo(discoveredTs)}
                            </span>
                          </div>
                        </td>

                        {/* MC at Dex Pay */}
                        <td className="px-5 py-3.5 text-right">
                          <span className="text-sm font-mono text-[#6B6B80]">
                            {formatUsd(token.fdv)}
                          </span>
                        </td>

                        {/* Current MC */}
                        <td className="px-5 py-3.5 text-right">
                          {token.currentFdv != null ? (() => {
                            const isUp = token.fdv != null && token.currentFdv > token.fdv;
                            const isDown = token.fdv != null && token.currentFdv < token.fdv;
                            return (
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border transition-all duration-300 mc-badge-enter",
                                  isUp && "bg-[#00FF88]/10 text-[#00FF88] border-[#00FF88]/20 mc-glow-green",
                                  isDown && "bg-[#FF4444]/10 text-[#FF4444] border-[#FF4444]/20 mc-glow-red",
                                  !isUp && !isDown && "bg-white/[0.04] text-[#6B6B80] border-white/[0.06]"
                                )}
                              >
                                {isUp && <TrendUp className="h-3 w-3 mc-arrow-up" />}
                                {isDown && <TrendDown className="h-3 w-3 mc-arrow-down" />}
                                {formatUsd(token.currentFdv)}
                              </span>
                            );
                          })() : (
                            <span className="text-sm font-mono text-[#6B6B80]">{"\u2014"}</span>
                          )}
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
              Showing {visibleTokens.length} of {filteredTokens.length} tokens...
            </span>
          </div>
        )}

        {/* All displayed message */}
        {!isLoading && filteredTokens.length > 0 && !hasMoreToShow && (
          <div className="text-center py-4 border-t border-white/[0.04]">
            <span className="text-[10px] font-mono text-[#6B6B80]">
              {isFiltered
                ? `${filteredTokens.length.toLocaleString()} of ${tokens.length.toLocaleString()} tokens`
                : `${filteredTokens.length.toLocaleString()} token${filteredTokens.length !== 1 ? "s" : ""} with profiles`}
              {" "}&middot; auto-refreshing every 30s
            </span>
          </div>
        )}

        {/* Empty state — no data at all */}
        {!isLoading && tokens.length === 0 && (
          <div className="text-center py-16 text-[#6B6B80]">
            <ShieldCheck className="h-8 w-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No tokens with DexScreener profiles found</p>
            <p className="text-xs mt-1 opacity-60">
              Profiles accumulate over time — try a longer period or wait a few minutes
            </p>
          </div>
        )}

        {/* Empty state — filters exclude everything */}
        {!isLoading && tokens.length > 0 && filteredTokens.length === 0 && (
          <div className="text-center py-16 text-[#6B6B80]">
            <ShieldCheck className="h-8 w-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No tokens match current filters</p>
            <p className="text-xs mt-1 opacity-60">
              Try adjusting bonded status or FDV range
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
