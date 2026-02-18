"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Wallet, ArrowRight, MagnifyingGlass } from "@phosphor-icons/react";
import { detectChainFromAddress } from "@/lib/utils";

export default function WalletLandingPage() {
  const [address, setAddress] = useState("");
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return;

    const chain = detectChainFromAddress(address.trim());
    if (chain) {
      router.push(`/wallet/${chain}/${address.trim()}`);
    }
  };

  const detectedChain = address.length > 10 ? detectChainFromAddress(address) : null;

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh]">
      <div className="w-full max-w-lg">
        {/* Icon */}
        <div className="flex justify-center mb-6">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 border border-white/[0.06] flex items-center justify-center">
            <Wallet className="h-8 w-8 text-[#00F0FF]" />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-center text-[#E8E8ED] mb-2">
          Wallet Tracker
        </h1>
        <p className="text-sm text-center text-[#6B6B80] mb-8">
          Analyze any wallet&apos;s portfolio, transaction history, and deployer reputation.
        </p>

        {/* Search form */}
        <form onSubmit={handleSubmit} className="relative">
          <div className="glow-card rounded-xl overflow-hidden">
            <div className="flex items-center gap-3 p-4">
              <MagnifyingGlass className="h-5 w-5 text-[#6B6B80] shrink-0" />
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Enter wallet address (Solana, Base, or BSC)..."
                className="flex-1 bg-transparent outline-none text-sm font-mono text-[#E8E8ED] placeholder:text-[#6B6B80]/50"
              />
              {detectedChain && (
                <span className="text-[10px] font-mono font-bold text-[#00F0FF] px-2 py-0.5 rounded bg-[#00F0FF]/10 border border-[#00F0FF]/20 shrink-0">
                  {detectedChain.toUpperCase()}
                </span>
              )}
              <button
                type="submit"
                disabled={!detectedChain}
                className="h-8 w-8 rounded-lg bg-[#00F0FF]/10 border border-[#00F0FF]/20 flex items-center justify-center text-[#00F0FF] hover:bg-[#00F0FF]/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
              >
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </form>

        {/* Chain indicators */}
        <div className="flex justify-center gap-4 mt-6">
          {[
            { name: "Solana", color: "#9945FF" },
            { name: "Base", color: "#0052FF" },
            { name: "BSC", color: "#F0B90B" },
          ].map((chain) => (
            <div key={chain.name} className="flex items-center gap-1.5">
              <div
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: chain.color }}
              />
              <span className="text-[10px] font-mono text-[#6B6B80]">
                {chain.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
