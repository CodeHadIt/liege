"use client";

import Link from "next/link";
import { Wallet, ArrowRight } from "@phosphor-icons/react";
import { PriceChange } from "@/components/shared/price-change";
import { formatUsd, shortenAddress } from "@/lib/utils";
import type { WalletTokenHolding } from "@/types/wallet";
import type { ChainId } from "@/types/chain";

interface WalletPortfolioProps {
  tokens: WalletTokenHolding[];
  totalUsd: number;
  chain: ChainId;
}

export function WalletPortfolio({ tokens, totalUsd, chain }: WalletPortfolioProps) {
  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Portfolio
          </span>
        </div>
        <span className="text-sm font-mono font-bold text-[#E8E8ED]">
          {formatUsd(totalUsd)}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/[0.04]">
              {["Token", "Balance", "Price", "24h", "Value", ""].map((h) => (
                <th
                  key={h}
                  className={`text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80] px-5 py-3 ${
                    h !== "Token" ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr
                key={token.tokenAddress}
                className="border-b border-white/[0.03] table-row-hover group"
              >
                <td className="px-5 py-3.5">
                  <Link
                    href={`/token/${chain}/${token.tokenAddress}`}
                    className="flex items-center gap-3"
                  >
                    {token.logoUrl ? (
                      <img
                        src={token.logoUrl}
                        alt={token.symbol}
                        className="h-8 w-8 rounded-full ring-1 ring-white/[0.06]"
                      />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[#00F0FF]/15 to-[#A855F7]/15 flex items-center justify-center text-[10px] font-bold text-[#00F0FF] ring-1 ring-white/[0.06]">
                        {token.symbol.slice(0, 2)}
                      </div>
                    )}
                    <div>
                      <span className="font-semibold text-sm text-[#E8E8ED] group-hover:text-[#00F0FF] transition-colors">
                        {token.symbol}
                      </span>
                      <div className="text-[10px] text-[#6B6B80] truncate max-w-[120px]">
                        {token.name}
                      </div>
                    </div>
                  </Link>
                </td>
                <td className="px-5 py-3.5 text-right">
                  <span className="text-sm font-mono text-[#E8E8ED]">
                    {formatBalance(token.balance)}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-right">
                  <span className="text-sm font-mono text-[#6B6B80]">
                    {formatUsd(token.priceUsd)}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-right">
                  <PriceChange value={token.priceChange24h} className="text-sm" />
                </td>
                <td className="px-5 py-3.5 text-right">
                  <span className="text-sm font-mono font-medium text-[#E8E8ED]">
                    {formatUsd(token.balanceUsd)}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-right">
                  <ArrowRight className="h-3.5 w-3.5 text-[#6B6B80]/0 group-hover:text-[#00F0FF]/50 transition-all ml-auto" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {tokens.length === 0 && (
        <div className="text-center py-16 text-[#6B6B80]">
          <Wallet className="h-8 w-8 mx-auto mb-3 opacity-20" />
          <p className="text-sm">No token holdings found</p>
        </div>
      )}
    </div>
  );
}

function formatBalance(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return value.toFixed(2);
  return value.toPrecision(4);
}
