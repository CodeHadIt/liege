"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Search, X, Plus, Loader2 } from "lucide-react";
import { detectChainFromAddress, shortenAddress, formatUsd } from "@/lib/utils";
import type { TokenSearchResult } from "@/types/token";
import type { ChainId } from "@/types/chain";

export interface SelectedToken {
  address: string;
  chain: ChainId;
  symbol: string;
  name: string;
  logoUrl: string | null;
}

interface TokenMultiInputProps {
  tokens: SelectedToken[];
  onAdd: (token: SelectedToken) => void;
  onRemove: (index: number) => void;
  maxTokens?: number;
}

export function TokenMultiInput({
  tokens,
  onAdd,
  onRemove,
  maxTokens = 10,
}: TokenMultiInputProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TokenSearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const search = useCallback(
    async (q: string) => {
      if (q.length < 2) {
        setResults([]);
        return;
      }

      // Check if it's a pasted address
      const trimmed = q.trim();
      const chainType = detectChainFromAddress(trimmed);
      if (chainType) {
        // It's an address — try to resolve via search
        setIsLoading(true);
        try {
          const res = await fetch(
            `/api/token/search?q=${encodeURIComponent(trimmed)}`
          );
          const json = await res.json();
          const data = (json.data || []) as TokenSearchResult[];
          // Find exact address match
          const exactMatch = data.find(
            (r) => r.address.toLowerCase() === trimmed.toLowerCase()
          );
          if (exactMatch) {
            const alreadyAdded = tokens.some(
              (t) =>
                t.address.toLowerCase() === exactMatch.address.toLowerCase() &&
                t.chain === exactMatch.chain
            );
            if (!alreadyAdded && tokens.length < maxTokens) {
              onAdd({
                address: exactMatch.address,
                chain: exactMatch.chain,
                symbol: exactMatch.symbol,
                name: exactMatch.name,
                logoUrl: exactMatch.logoUrl,
              });
              setQuery("");
              setResults([]);
              setIsOpen(false);
            }
          } else {
            // No exact match — add as unknown token with detected chain
            const chain: ChainId =
              chainType === "solana" ? "solana" : "base";
            const alreadyAdded = tokens.some(
              (t) =>
                t.address.toLowerCase() === trimmed.toLowerCase() &&
                t.chain === chain
            );
            if (!alreadyAdded && tokens.length < maxTokens) {
              onAdd({
                address: trimmed,
                chain,
                symbol: shortenAddress(trimmed, 4),
                name: "Unknown Token",
                logoUrl: null,
              });
              setQuery("");
              setResults([]);
              setIsOpen(false);
            }
          }
        } catch {
          // Silently fail
        } finally {
          setIsLoading(false);
        }
        return;
      }

      // Regular text search
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
    },
    [tokens, maxTokens, onAdd]
  );

  useEffect(() => {
    const timeout = setTimeout(() => search(query), 300);
    return () => clearTimeout(timeout);
  }, [query, search]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSelect = (result: TokenSearchResult) => {
    const alreadyAdded = tokens.some(
      (t) =>
        t.address.toLowerCase() === result.address.toLowerCase() &&
        t.chain === result.chain
    );
    if (alreadyAdded || tokens.length >= maxTokens) return;

    onAdd({
      address: result.address,
      chain: result.chain,
      symbol: result.symbol,
      name: result.name,
      logoUrl: result.logoUrl,
    });
    setQuery("");
    setResults([]);
    setIsOpen(false);
  };

  return (
    <div className="space-y-3">
      {/* Selected tokens as chips */}
      {tokens.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tokens.map((token, i) => (
            <div
              key={`${token.chain}:${token.address}`}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] group"
            >
              {token.logoUrl ? (
                <img
                  src={token.logoUrl}
                  alt={token.symbol}
                  className="h-4 w-4 rounded-full"
                />
              ) : (
                <div className="h-4 w-4 rounded-full bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 flex items-center justify-center text-[8px] font-bold text-[#00F0FF]">
                  {token.symbol.slice(0, 2)}
                </div>
              )}
              <span className="text-xs font-mono font-semibold text-[#E8E8ED]">
                {token.symbol}
              </span>
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#00F0FF]/60">
                {token.chain}
              </span>
              <button
                onClick={() => onRemove(i)}
                className="ml-1 text-[#6B6B80] hover:text-[#FF3B5C] transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Search input */}
      {tokens.length < maxTokens && (
        <div className="relative">
          <div className="relative group">
            {isLoading ? (
              <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#00F0FF] animate-spin" />
            ) : (
              <Plus className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#6B6B80] group-focus-within:text-[#00F0FF] transition-colors" />
            )}
            <input
              ref={inputRef}
              placeholder={
                tokens.length === 0
                  ? "Search token or paste address..."
                  : "Add another token..."
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setIsOpen(true);
              }}
              onFocus={() => query.length >= 2 && setIsOpen(true)}
              className="w-full h-10 pl-10 pr-4 bg-white/[0.04] border border-white/[0.06] rounded-lg text-sm text-[#E8E8ED] placeholder:text-[#6B6B80]/60 focus:outline-none focus:border-[#00F0FF]/30 focus:bg-white/[0.06] focus:shadow-[0_0_20px_-8px_rgba(0,240,255,0.15)] transition-all duration-200 font-mono"
            />
          </div>

          {isOpen && (results.length > 0 || isLoading) && (
            <div
              ref={dropdownRef}
              className="absolute top-full mt-2 w-full bg-[#111118] border border-white/[0.06] rounded-xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.6)] z-50 max-h-64 overflow-y-auto"
            >
              {isLoading && results.length === 0 && (
                <div className="px-4 py-3 text-sm text-[#6B6B80] flex items-center gap-2">
                  <div className="h-3 w-3 border border-[#00F0FF]/40 border-t-transparent rounded-full animate-spin" />
                  Searching...
                </div>
              )}
              {results.map((result) => {
                const alreadyAdded = tokens.some(
                  (t) =>
                    t.address.toLowerCase() ===
                      result.address.toLowerCase() &&
                    t.chain === result.chain
                );
                return (
                  <button
                    key={`${result.chain}:${result.address}`}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.03] text-left transition-all disabled:opacity-30"
                    onMouseDown={() => handleSelect(result)}
                    disabled={alreadyAdded}
                  >
                    {result.logoUrl ? (
                      <img
                        src={result.logoUrl}
                        alt={result.symbol}
                        className="h-7 w-7 rounded-full ring-1 ring-white/[0.06]"
                      />
                    ) : (
                      <div className="h-7 w-7 rounded-full bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 flex items-center justify-center text-[10px] font-bold text-[#00F0FF]">
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
                          {result.chain}
                        </span>
                        <span className="text-[10px] font-mono text-[#6B6B80]/60">
                          {shortenAddress(result.address)}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-mono text-[#E8E8ED]">
                        {formatUsd(result.priceUsd)}
                      </div>
                    </div>
                    {alreadyAdded && (
                      <span className="text-[10px] text-[#6B6B80]">Added</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
