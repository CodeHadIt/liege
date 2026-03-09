"use client";

import { useState, useCallback } from "react";
import type { DisplayCurrency } from "@/features/common-traders/components/trade-history-detail";
import { GitDiff, Lightning } from "@phosphor-icons/react";
import {
  TokenMultiInput,
  type SelectedToken,
} from "@/features/common-traders/components/token-multi-input";
import { CommonTradersTable } from "@/features/common-traders/components/common-traders-table";
import { useCommonTraders } from "@/features/common-traders/hooks/use-common-traders";
import { CHAIN_CONFIGS, SUPPORTED_CHAINS } from "@/config/chains";
import type { ChainId } from "@/types/chain";

export default function TradersPage() {
  const [selectedChain, setSelectedChain] = useState<ChainId | null>(null);
  const [tokens, setTokens] = useState<SelectedToken[]>([]);
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>("usd");
  const { mutate, data, isPending } = useCommonTraders();

  const handleChainChange = useCallback((chain: ChainId | null) => {
    setSelectedChain(chain);
    setTokens([]);
  }, []);

  const handleAdd = useCallback((token: SelectedToken) => {
    setTokens((prev) => [...prev, token]);
  }, []);

  const handleRemove = useCallback((index: number) => {
    setTokens((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSearch = () => {
    if (tokens.length < 2) return;
    mutate(
      tokens.map((t) => ({ chain: t.chain, address: t.address, symbol: t.symbol }))
    );
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 border border-[#00F0FF]/10 flex items-center justify-center">
            <GitDiff className="h-5 w-5 text-[#00F0FF]" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#E8E8ED]">
              Common Top Traders
            </h1>
            <p className="text-xs text-[#6B6B80] font-mono">
              Find wallets that hold positions across multiple tokens
            </p>
          </div>
        </div>
      </div>

      {/* Input card */}
      <div className="glow-card rounded-xl overflow-visible">
        <div className="px-5 py-3 border-b border-white/[0.04] rounded-t-xl flex items-center justify-between">
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Select Tokens
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => handleChainChange(null)}
              className={`px-2.5 py-1 rounded-md text-[10px] font-mono font-semibold uppercase tracking-wider transition-all ${
                selectedChain === null
                  ? "bg-white/[0.08] text-[#E8E8ED] border border-white/[0.1]"
                  : "text-[#6B6B80] hover:text-[#E8E8ED] hover:bg-white/[0.04] border border-transparent"
              }`}
            >
              All
            </button>
            {SUPPORTED_CHAINS.map((chainId) => {
              const config = CHAIN_CONFIGS[chainId];
              return (
                <button
                  key={chainId}
                  onClick={() => handleChainChange(chainId)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono font-semibold uppercase tracking-wider transition-all ${
                    selectedChain === chainId
                      ? "bg-[#00F0FF]/10 text-[#00F0FF] border border-[#00F0FF]/20"
                      : "text-[#6B6B80] hover:text-[#E8E8ED] hover:bg-white/[0.04] border border-transparent"
                  }`}
                >
                  <img
                    src={config.logo}
                    alt={config.name}
                    className="h-3.5 w-3.5 rounded-full"
                  />
                  {config.shortName}
                </button>
              );
            })}
          </div>
        </div>
        <div className="p-5 space-y-4 relative">
          <TokenMultiInput
            tokens={tokens}
            onAdd={handleAdd}
            onRemove={handleRemove}
            maxTokens={10}
            chainFilter={selectedChain}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-[#6B6B80]">
              {tokens.length < 2
                ? `Add ${2 - tokens.length} more token${2 - tokens.length > 1 ? "s" : ""} to compare`
                : `${tokens.length} tokens selected`}
            </span>
            <button
              onClick={handleSearch}
              disabled={tokens.length < 2 || isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-[#00F0FF]/20 to-[#0080FF]/20 border border-[#00F0FF]/20 text-sm font-mono font-semibold text-[#00F0FF] hover:from-[#00F0FF]/30 hover:to-[#0080FF]/30 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isPending ? (
                <>
                  <div className="h-3.5 w-3.5 border border-[#00F0FF]/40 border-t-transparent rounded-full animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Lightning className="h-3.5 w-3.5" />
                  Find Common Traders
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Results */}
      {(data || isPending) && (
        <CommonTradersTable
          traders={data?.traders ?? []}
          tokensMeta={data?.tokensMeta ?? []}
          isLoading={isPending}
          displayCurrency={displayCurrency}
          onToggleCurrency={() =>
            setDisplayCurrency((prev) => (prev === "usd" ? "token" : "usd"))
          }
        />
      )}
    </div>
  );
}
