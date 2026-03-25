"use client";

import { ChartBar } from "@phosphor-icons/react";
import type { ChainId } from "@/types/chain";

interface PriceChartProps {
  chain: ChainId;
  address: string;
}

function toGmgnChain(chain: ChainId): string {
  if (chain === "solana") return "sol";
  return chain;
}

export function PriceChart({ chain, address }: PriceChartProps) {
  const gmgnChain = toGmgnChain(chain);
  const src = `https://www.gmgn.cc/kline/${gmgnChain}/${address}`;

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-white/[0.04]">
        <ChartBar className="h-4 w-4 text-[#00F0FF]/50" />
        <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
          Price Chart
        </span>
      </div>

      {/* GMGN iframe */}
      <iframe
        src={src}
        className="w-full border-0"
        style={{ height: 480 }}
        allowFullScreen
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
}
