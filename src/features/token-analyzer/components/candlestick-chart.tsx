"use client";

import { ChartBar } from "@phosphor-icons/react";
import type { ChainId } from "@/types/chain";

interface CandlestickChartProps {
  chain: ChainId;
  address: string;
  marketCap?: number | null;
  priceUsd?: number | null;
}

function toGmgnChain(chain: ChainId): string {
  if (chain === "solana") return "sol";
  return chain; // "base" and "bsc" match GMGN directly
}

export function CandlestickChart({ chain, address }: CandlestickChartProps) {
  const src = `https://www.gmgn.cc/kline/${toGmgnChain(chain)}/${address}`;

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-white/[0.04]">
        <ChartBar className="h-4 w-4 text-[#00F0FF]/50" />
        <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
          Price Chart
        </span>
      </div>
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
