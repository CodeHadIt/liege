"use client";

import Link from "next/link";
import { Code, ArrowRight, AlertTriangle, CheckCircle, Skull, HelpCircle } from "lucide-react";
import { formatUsd, formatTimeAgo } from "@/lib/utils";
import type { DeployedToken } from "@/types/wallet";
import type { ChainId } from "@/types/chain";

interface DeployedTokensTableProps {
  tokens: DeployedToken[];
  chain: ChainId;
}

const statusConfig: Record<
  DeployedToken["status"],
  { icon: typeof CheckCircle; color: string; label: string }
> = {
  active: { icon: CheckCircle, color: "#00FF88", label: "ACTIVE" },
  rugged: { icon: Skull, color: "#FF3B5C", label: "RUGGED" },
  dead: { icon: AlertTriangle, color: "#FFB800", label: "DEAD" },
  unknown: { icon: HelpCircle, color: "#6B6B80", label: "UNKNOWN" },
};

export function DeployedTokensTable({ tokens, chain }: DeployedTokensTableProps) {
  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Code className="h-4 w-4 text-[#A855F7]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Deployed Tokens
          </span>
        </div>
        <span className="text-[10px] font-mono font-bold text-[#E8E8ED]">
          {tokens.length} tokens
        </span>
      </div>

      {tokens.length === 0 ? (
        <div className="text-center py-16 text-[#6B6B80]">
          <Code className="h-8 w-8 mx-auto mb-3 opacity-20" />
          <p className="text-sm">No deployed tokens found</p>
          <p className="text-xs mt-1 opacity-60">This wallet hasn&apos;t deployed any tokens</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.04]">
                {["Token", "Status", "Price", "Liquidity", "Deployed", ""].map((h) => (
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
              {tokens.map((token) => {
                const status = statusConfig[token.status];
                const StatusIcon = status.icon;
                return (
                  <tr
                    key={token.address}
                    className="border-b border-white/[0.03] table-row-hover group"
                  >
                    <td className="px-5 py-3.5">
                      <Link
                        href={`/token/${chain}/${token.address}`}
                        className="flex items-center gap-3"
                      >
                        <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[#A855F7]/15 to-[#00F0FF]/15 flex items-center justify-center text-[10px] font-bold text-[#A855F7] ring-1 ring-white/[0.06]">
                          {token.symbol.slice(0, 2)}
                        </div>
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
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
                        style={{
                          color: status.color,
                          backgroundColor: `${status.color}10`,
                          border: `1px solid ${status.color}20`,
                        }}
                      >
                        <StatusIcon className="h-3 w-3" />
                        {status.label}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span className="text-sm font-mono text-[#E8E8ED]">
                        {formatUsd(token.currentPriceUsd)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span className="text-sm font-mono text-[#6B6B80]">
                        {formatUsd(token.currentLiquidityUsd)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span className="text-[11px] font-mono text-[#6B6B80]">
                        {formatTimeAgo(token.deployedAt)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <ArrowRight className="h-3.5 w-3.5 text-[#6B6B80]/0 group-hover:text-[#00F0FF]/50 transition-all ml-auto" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
