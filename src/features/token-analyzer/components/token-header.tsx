"use client";

import { ExternalLink, Globe, Twitter } from "lucide-react";
import { ChainBadge } from "@/components/shared/chain-badge";
import { AddressDisplay } from "@/components/shared/address-display";
import { PriceChange } from "@/components/shared/price-change";
import { formatUsd } from "@/lib/utils";
import type { UnifiedTokenData } from "@/types/token";

interface TokenHeaderProps {
  token: UnifiedTokenData;
}

export function TokenHeader({ token }: TokenHeaderProps) {
  return (
    <div className="glow-card rounded-xl p-5 animate-fade-up">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Left: identity */}
        <div className="flex items-center gap-4">
          {token.logoUrl ? (
            <div className="relative">
              <img
                src={token.logoUrl}
                alt={token.symbol}
                className="h-12 w-12 rounded-xl ring-1 ring-white/[0.06]"
              />
              <div className="absolute -bottom-1 -right-1">
                <ChainBadge chain={token.chain} />
              </div>
            </div>
          ) : (
            <div className="relative">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 flex items-center justify-center text-lg font-bold text-[#00F0FF] ring-1 ring-white/[0.06]">
                {token.symbol.slice(0, 2)}
              </div>
              <div className="absolute -bottom-1 -right-1">
                <ChainBadge chain={token.chain} />
              </div>
            </div>
          )}
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold text-[#E8E8ED]">{token.name}</h1>
              <span className="text-sm font-mono font-medium text-[#6B6B80]">
                {token.symbol}
              </span>
            </div>
            <div className="mt-1">
              <AddressDisplay address={token.address} chain={token.chain} chars={6} />
            </div>
          </div>
        </div>

        {/* Right: price */}
        <div className="flex flex-col items-start sm:items-end gap-1.5">
          <div className="text-3xl font-bold font-mono text-[#E8E8ED]">
            {formatUsd(token.priceUsd)}
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#6B6B80]">1h</span>
              <PriceChange value={token.priceChange.h1} className="text-sm" />
            </div>
            <div className="h-3 w-px bg-white/[0.06]" />
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#6B6B80]">6h</span>
              <PriceChange value={token.priceChange.h6} className="text-sm" />
            </div>
            <div className="h-3 w-px bg-white/[0.06]" />
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#6B6B80]">24h</span>
              <PriceChange value={token.priceChange.h24} className="text-sm" />
            </div>
          </div>
        </div>
      </div>

      {/* Links row */}
      {(token.website || token.twitter) && (
        <div className="flex items-center gap-3 mt-4 pt-4 border-t border-white/[0.04]">
          {token.website && (
            <a
              href={token.website}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-[#6B6B80] hover:text-[#00F0FF] transition-colors"
            >
              <Globe className="h-3.5 w-3.5" />
              Website
              <ExternalLink className="h-3 w-3 opacity-50" />
            </a>
          )}
          {token.twitter && (
            <a
              href={token.twitter}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-[#6B6B80] hover:text-[#00F0FF] transition-colors"
            >
              <Twitter className="h-3.5 w-3.5" />
              Twitter
              <ExternalLink className="h-3 w-3 opacity-50" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
