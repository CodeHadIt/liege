"use client";

import { useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { shortenAddress } from "@/lib/utils";
import { getExplorerAddressUrl } from "@/config/chains";
import type { ChainId } from "@/types/chain";

interface AddressDisplayProps {
  address: string;
  chain: ChainId;
  chars?: number;
  showExplorer?: boolean;
}

export function AddressDisplay({
  address,
  chain,
  chars = 4,
  showExplorer = true,
}: AddressDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs text-[#6B6B80]">
        {shortenAddress(address, chars)}
      </span>
      <button
        onClick={handleCopy}
        className="text-[#6B6B80] hover:text-[#00F0FF] transition-colors"
      >
        {copied ? (
          <Check className="h-3 w-3 text-[#00FF88]" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
      {showExplorer && (
        <a
          href={getExplorerAddressUrl(chain, address)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#6B6B80] hover:text-[#00F0FF] transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </span>
  );
}
