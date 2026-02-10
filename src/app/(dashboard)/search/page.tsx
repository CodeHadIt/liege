"use client";

import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChainBadge } from "@/components/shared/chain-badge";
import { PriceChange } from "@/components/shared/price-change";
import { formatUsd, shortenAddress } from "@/lib/utils";
import { Search } from "lucide-react";
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
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Search className="h-6 w-6 text-primary" />
          Search Results
        </h1>
        {query && (
          <p className="text-muted-foreground mt-1">
            Results for &ldquo;{query}&rdquo;
          </p>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-5 w-20" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !results || results.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          {query ? "No tokens found matching your search." : "Enter a search term to find tokens."}
        </div>
      ) : (
        <div className="space-y-2">
          {results.map((token) => (
            <Link
              key={`${token.chain}:${token.address}`}
              href={`/token/${token.chain}/${token.address}`}
            >
              <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    {token.logoUrl ? (
                      <img
                        src={token.logoUrl}
                        alt={token.symbol}
                        className="h-10 w-10 rounded-full"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-sm font-bold">
                        {token.symbol.slice(0, 2)}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{token.symbol}</span>
                        <span className="text-sm text-muted-foreground truncate">
                          {token.name}
                        </span>
                        <ChainBadge chain={token.chain as ChainId} />
                      </div>
                      <span className="text-xs text-muted-foreground font-mono">
                        {shortenAddress(token.address)}
                      </span>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">
                        {formatUsd(token.priceUsd)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Vol {formatUsd(token.volume24h)}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
