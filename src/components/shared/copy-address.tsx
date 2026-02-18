"use client";

import { useState } from "react";
import { Copy, Check } from "@phosphor-icons/react";

interface CopyAddressProps {
  address: string;
  className?: string;
}

export function CopyAddress({ address, className }: CopyAddressProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={`shrink-0 text-[#6B6B80] hover:text-[#00F0FF] transition-colors ${className ?? ""}`}
      title={`Copy: ${address}`}
    >
      {copied ? (
        <Check className="h-3 w-3 text-[#00FF88]" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}
