import { Drop, LockSimple, LockSimpleOpen } from "@phosphor-icons/react";
import { formatUsd } from "@/lib/utils";
import type { LiquidityInfo } from "@/types/token";

interface LiquidityPoolsProps {
  liquidity: LiquidityInfo;
}

export function LiquidityPools({ liquidity }: LiquidityPoolsProps) {
  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Drop className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Liquidity
          </span>
        </div>
        <span className="text-sm font-mono font-bold text-[#E8E8ED]">
          {formatUsd(liquidity.totalUsd)}
        </span>
      </div>

      {/* Pools */}
      <div className="p-3 space-y-2">
        {liquidity.pools.map((pool, i) => (
          <div
            key={i}
            className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:border-white/[0.08] transition-all"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-semibold capitalize text-[#E8E8ED]">
                {pool.dex}
              </span>
              {pool.isLocked === true && (
                <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold text-[#00FF88] px-1.5 py-0.5 rounded bg-[#00FF88]/10 border border-[#00FF88]/20">
                  <LockSimple className="h-3 w-3" />
                  LOCKED
                </span>
              )}
              {pool.isLocked === false && (
                <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold text-[#FFB800] px-1.5 py-0.5 rounded bg-[#FFB800]/10 border border-[#FFB800]/20">
                  <LockSimpleOpen className="h-3 w-3" />
                  UNLOCKED
                </span>
              )}
            </div>
            <span className="text-sm font-mono font-medium text-[#E8E8ED]">
              {formatUsd(pool.liquidityUsd)}
            </span>
          </div>
        ))}
        {liquidity.pools.length === 0 && (
          <div className="text-center py-6 text-[#6B6B80]">
            <Drop className="h-6 w-6 mx-auto mb-2 opacity-20" />
            <span className="text-xs">No liquidity pool data</span>
          </div>
        )}
      </div>
    </div>
  );
}
