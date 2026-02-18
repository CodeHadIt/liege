"use client";

import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { ChainBadge } from "@/components/shared/chain-badge";
import { formatUsd } from "@/lib/utils";
import { CopyAddress } from "@/components/shared/copy-address";
import { MagnifyingGlass, ArrowRight, Scan } from "@phosphor-icons/react";
import type { TokenSearchResult } from "@/types/token";
import type { ChainId } from "@/types/chain";

export default function SearchPage() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") || "";

  const { data: results, isLoading } = useQuery<TokenSearchResult[]>({
    queryKey: ["search", query],
    queryFn: async () => {
      if (!query) return [];
      const res = await fetch(
        `/api/token/search?q=${encodeURIComponent(query)}`
      );
      const json = await res.json();
      return json.data || [];
    },
    enabled: query.length >= 2,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-[#00F0FF]/10 border border-[#00F0FF]/20 flex items-center justify-center">
          <MagnifyingGlass className="h-5 w-5 text-[#00F0FF]" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-[#E8E8ED] tracking-tight">
            Search Results
          </h1>
          {query && (
            <p className="text-xs font-mono text-[#6B6B80]">
              Showing results for &ldquo;<span className="text-[#00F0FF]">{query}</span>&rdquo;
            </p>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glow-card rounded-xl p-4">
              <div className="flex items-center gap-4">
                <Skeleton className="h-10 w-10 rounded-xl shimmer" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32 shimmer" />
                  <Skeleton className="h-3 w-48 shimmer" />
                </div>
                <Skeleton className="h-5 w-20 shimmer" />
              </div>
            </div>
          ))}
        </div>
      ) : !results || results.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-[#6B6B80]">
          <div className="h-16 w-16 rounded-2xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-center mb-6">
            <Scan className="h-7 w-7 opacity-30" />
          </div>
          <h2 className="text-lg font-bold text-[#E8E8ED] mb-2">
            {query ? "No Tokens Found" : "Search for Tokens"}
          </h2>
          <p className="text-xs text-center max-w-md">
            {query
              ? <>No tokens matching &ldquo;<span className="font-mono text-[#00F0FF]">{query}</span>&rdquo;. Try a different symbol, name, or paste a contract address.</>
              : "Enter a token symbol, name, or contract address to search."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {results.map((token, i) => (
            <Link
              key={`${token.chain}:${token.address}`}
              href={`/token/${token.chain}/${token.address}`}
              className={`group block animate-fade-up stagger-${Math.min(i + 1, 6)}`}
            >
              <div className="glow-card rounded-xl p-4 table-row-hover transition-all">
                <div className="flex items-center gap-4">
                  {/* Token avatar */}
                  {token.logoUrl ? (
                    <img
                      src={token.logoUrl}
                      alt={token.symbol}
                      className="h-10 w-10 rounded-xl border border-white/[0.06]"
                    />
                  ) : (
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#00F0FF]/20 to-[#00FF88]/20 border border-white/[0.06] flex items-center justify-center">
                      <span className="text-sm font-bold font-mono text-[#E8E8ED]">
                        {token.symbol.slice(0, 2)}
                      </span>
                    </div>
                  )}

                  {/* Token info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-[#E8E8ED]">
                        {token.symbol}
                      </span>
                      <span className="text-xs text-[#6B6B80] truncate">
                        {token.name}
                      </span>
                      <ChainBadge chain={token.chain as ChainId} />
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-[#6B6B80]">
                      <CopyAddress address={token.address} />
                    </span>
                  </div>

                  {/* Price + volume */}
                  <div className="text-right">
                    <div className="text-sm font-mono font-bold text-[#E8E8ED]">
                      {formatUsd(token.priceUsd)}
                    </div>
                    <div className="text-[11px] font-mono text-[#6B6B80]">
                      Vol {formatUsd(token.volume24h)}
                    </div>
                  </div>

                  {/* Arrow */}
                  <ArrowRight className="h-4 w-4 text-[#6B6B80] opacity-0 group-hover:opacity-100 group-hover:text-[#00F0FF] transition-all -translate-x-1 group-hover:translate-x-0" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
