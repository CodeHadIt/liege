"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { MagnifyingGlass, ArrowRight } from "@phosphor-icons/react";
import { CopyAddress } from "@/components/shared/copy-address";
import { detectChainFromAddress, formatUsd, chainLabel } from "@/lib/utils";
import type { TokenSearchResult } from "@/types/token";

export function TokenSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TokenSearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      return;
    }

    const detectedChain = detectChainFromAddress(q);
    if (detectedChain) {
      const chain = detectedChain === "evm" ? "base" : "solana";
      router.push(`/token/${chain}/${q}`);
      setQuery("");
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(
        `/api/token/search?q=${encodeURIComponent(q)}`
      );
      const json = await res.json();
      setResults(json.data || []);
    } catch {
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const timeout = setTimeout(() => search(query), 300);
    return () => clearTimeout(timeout);
  }, [query, search]);

  const handleSelect = (result: TokenSearchResult) => {
    router.push(`/token/${result.chain}/${result.address}`);
    setQuery("");
    setIsOpen(false);
    setResults([]);
  };

  return (
    <div className="relative">
      <div className="relative group">
        <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#6B6B80] group-focus-within:text-[#00F0FF] transition-colors" />
        <input
          placeholder="Search tokens or paste address..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => query.length >= 2 && setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 200)}
          className="w-full h-9 pl-9 pr-4 bg-white/[0.04] border border-white/[0.06] rounded-lg text-sm text-[#E8E8ED] placeholder:text-[#6B6B80]/60 focus:outline-none focus:border-[#00F0FF]/30 focus:bg-white/[0.06] focus:shadow-[0_0_20px_-8px_rgba(0,240,255,0.15)] transition-all duration-200 font-mono"
        />
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden sm:inline text-[10px] font-mono px-1.5 py-0.5 rounded border border-white/[0.08] text-[#6B6B80]/40">
          /
        </kbd>
      </div>

      {isOpen && (results.length > 0 || isLoading) && (
        <div className="absolute top-full mt-2 w-full bg-[#111118] border border-white/[0.06] rounded-xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.6)] z-50 max-h-80 overflow-y-auto">
          {isLoading && results.length === 0 && (
            <div className="px-4 py-3 text-sm text-[#6B6B80] flex items-center gap-2">
              <div className="h-3 w-3 border border-[#00F0FF]/40 border-t-transparent rounded-full animate-spin" />
              Searching...
            </div>
          )}
          {results.map((result, i) => (
            <button
              key={`${result.chain}:${result.address}`}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] text-left transition-all group/item table-row-hover"
              onMouseDown={() => handleSelect(result)}
              style={{ animationDelay: `${i * 30}ms` }}
            >
              {result.logoUrl ? (
                <img
                  src={result.logoUrl}
                  alt={result.symbol}
                  className="h-8 w-8 rounded-full ring-1 ring-white/[0.06]"
                />
              ) : (
                <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 flex items-center justify-center text-xs font-bold text-[#00F0FF]">
                  {result.symbol.slice(0, 2)}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-[#E8E8ED]">
                    {result.symbol}
                  </span>
                  <span className="text-xs text-[#6B6B80] truncate">
                    {result.name}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-[#00F0FF]/60">
                    {chainLabel(result.chain)}
                  </span>
                  <CopyAddress address={result.address} className="opacity-60 hover:opacity-100" />
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-mono font-medium text-[#E8E8ED]">
                  {formatUsd(result.priceUsd)}
                </div>
                {result.volume24h && (
                  <div className="text-[10px] font-mono text-[#6B6B80]">
                    Vol {formatUsd(result.volume24h)}
                  </div>
                )}
              </div>
              <ArrowRight className="h-3.5 w-3.5 text-[#6B6B80]/0 group-hover/item:text-[#00F0FF]/50 transition-all" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
