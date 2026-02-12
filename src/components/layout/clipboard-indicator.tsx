"use client";

import { Coins, Loader2, Wallet, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useClipboardAddress } from "@/hooks/use-clipboard-address";
import { chainLabel as getChainLabel } from "@/lib/utils";

export function ClipboardIndicator() {
  const { detected, loading, dismiss } = useClipboardAddress();
  const router = useRouter();

  if (!detected && !loading) return null;

  if (loading) {
    return (
      <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-[11px] text-[#6B6B80]">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Detecting...</span>
      </div>
    );
  }

  if (!detected) return null;

  const isToken = detected.type === "token";
  const iconColor = isToken ? "#00F0FF" : "#A855F7";
  const chainRoute = detected.chain === "solana" ? "solana" : "base";
  const href = isToken
    ? `/token/${chainRoute}/${detected.address}`
    : `/wallet/${chainRoute}/${detected.address}`;

  return (
    <div className="hidden sm:flex items-center gap-1.5 max-w-[180px]">
      <button
        onClick={() => router.push(href)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] transition-colors cursor-pointer min-w-0"
      >
        {isToken ? (
          <Coins className="h-3 w-3 shrink-0" style={{ color: iconColor }} />
        ) : (
          <Wallet className="h-3 w-3 shrink-0" style={{ color: iconColor }} />
        )}
        <span className="text-[11px] font-medium text-white/80 truncate">
          {detected.label}
        </span>
        <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-white/[0.06] text-[#6B6B80] shrink-0">
          {getChainLabel(detected.chain)}
        </span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          dismiss();
        }}
        className="p-0.5 rounded hover:bg-white/[0.08] text-[#6B6B80] hover:text-white/60 transition-colors shrink-0"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
