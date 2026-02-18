"use client";

import { useChain } from "@/providers/chain-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CaretDown } from "@phosphor-icons/react";
import type { ChainId } from "@/types/chain";

const chains: { id: ChainId | "all"; label: string; color: string }[] = [
  { id: "all", label: "All Chains", color: "#00F0FF" },
  { id: "solana", label: "Solana", color: "#9945FF" },
  { id: "base", label: "Base", color: "#0052FF" },
  { id: "bsc", label: "BNB Chain", color: "#F0B90B" },
];

export function ChainSelector() {
  const { activeChain, setActiveChain } = useChain();
  const current = chains.find((c) => c.id === activeChain) || chains[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 h-9 px-3 rounded-lg border border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06] transition-all text-sm">
          <div
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: current.color, boxShadow: `0 0 8px ${current.color}40` }}
          />
          <span className="hidden sm:inline text-[#E8E8ED] font-medium">
            {current.label}
          </span>
          <CaretDown className="h-3.5 w-3.5 text-[#6B6B80]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-[#111118] border-white/[0.06]">
        {chains.map((chain) => (
          <DropdownMenuItem
            key={chain.id}
            onClick={() => setActiveChain(chain.id)}
            className={`flex items-center gap-2.5 cursor-pointer ${
              activeChain === chain.id ? "bg-white/[0.04]" : ""
            }`}
          >
            <div
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: chain.color, boxShadow: `0 0 6px ${chain.color}30` }}
            />
            <span>{chain.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
