"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { UsersThree, MagnifyingGlass, ArrowSquareOut, Lightning, Copy, Check, Warning } from "@phosphor-icons/react";
import type { SharedHoldChain, SharedHoldersResponse, SharedHolder } from "@/types/shared-holders";

// ── Constants ─────────────────────────────────────────────────────────────────

const CHAINS: { id: SharedHoldChain; label: string; logo: string }[] = [
  { id: "solana", label: "Solana", logo: "/chains/solana.svg" },
  { id: "eth",    label: "ETH",    logo: "/chains/eth.svg"    },
  { id: "base",   label: "Base",   logo: "/chains/base.svg"   },
  { id: "bsc",    label: "BSC",    logo: "/chains/bsc.svg"    },
];

const LS_KEY = "shared-hold:state";

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmt(n: number | null, prefix = "$"): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${prefix}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${prefix}${abs.toFixed(2)}`;
}

function fmtTokens(bal: string): string {
  const n = parseFloat(bal);
  if (isNaN(n)) return bal;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function pnlColor(pnl: number | null): string {
  if (pnl == null) return "text-[#6B6B80]";
  if (pnl > 0) return "text-[#00FF88]";
  if (pnl < 0) return "text-red-400";
  return "text-[#6B6B80]";
}

function scanUrl(chain: SharedHoldChain, address: string): string {
  const bases: Record<SharedHoldChain, string> = {
    eth:    "https://etherscan.io/address",
    base:   "https://basescan.org/address",
    bsc:    "https://bscscan.com/address",
    solana: "https://solscan.io/account",
  };
  return `${bases[chain]}/${address}`;
}

function isValidAddress(chain: SharedHoldChain, addr: string): boolean {
  if (chain === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

/** Returns "solana" | "evm" | null based purely on address format. */
function detectAddressType(addr: string): "solana" | "evm" | null {
  if (/^0x[a-fA-F0-9]{40}$/.test(addr)) return "evm";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return "solana";
  return null;
}

const DEX_CHAIN: Record<SharedHoldChain, string> = {
  eth: "ethereum", base: "base", bsc: "bsc", solana: "solana",
};

type AddrStatus = "idle" | "checking" | "token" | "not-token";

async function checkIsToken(chain: SharedHoldChain, address: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/${DEX_CHAIN[chain]}/${address}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return true; // can't verify — don't warn
    const pairs: unknown[] = await res.json();
    return Array.isArray(pairs) && pairs.length > 0;
  } catch {
    return true; // network fail — don't warn
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AddrStatusIcon({ status }: { status: AddrStatus }) {
  if (status === "idle") return null;
  if (status === "checking") return (
    <div className="absolute right-3 top-1/2 -translate-y-1/2 h-3 w-3 border border-[#6B6B80]/40 border-t-transparent rounded-full animate-spin" />
  );
  if (status === "token") return (
    <Check className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#00FF88]" />
  );
  return (
    <Warning className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-amber-400" weight="fill" />
  );
}

function TokenCell({
  data,
  symbol,
}: {
  data: SharedHolder["tokenA"];
  symbol: string;
}) {
  return (
    <div className="space-y-1 min-w-[180px]">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-[#E8E8ED]">
          {fmtTokens(data.balance)}
        </span>
        <span className="text-[10px] font-mono text-[#6B6B80] uppercase">{symbol}</span>
      </div>
      {data.percentage > 0 && (
        <div className="text-[11px] font-mono text-[#6B6B80]">
          {data.percentage.toFixed(3)}% supply
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
        <span className="text-[#6B6B80]">Holding</span>
        <span className="text-[#9B9BAA] text-right">{fmt(data.balanceUsd)}</span>
        <span className="text-[#6B6B80]">Bought</span>
        <span className="text-[#9B9BAA] text-right">{fmt(data.investedUsd)}</span>
        <span className="text-[#6B6B80]">Sold</span>
        <span className="text-[#9B9BAA] text-right">{fmt(data.soldUsd)}</span>
        <span className="text-[#6B6B80]">Buy MC</span>
        <span className="text-[#9B9BAA] text-right">{fmt(data.buyMarketCap)}</span>
        <span className="text-[#6B6B80]">PnL</span>
        <span className={`text-right font-semibold ${pnlColor(data.totalPnl)}`}>
          {data.totalPnl != null
            ? `${data.totalPnl >= 0 ? "+" : ""}${fmt(data.totalPnl)}`
            : "—"}
        </span>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button
      onClick={copy}
      className="text-[#6B6B80] hover:text-[#E8E8ED] transition-colors"
      title="Copy address"
    >
      {copied
        ? <Check className="h-3 w-3 text-[#00FF88]" />
        : <Copy className="h-3 w-3" />}
    </button>
  );
}

function HolderRow({
  holder,
  chain,
  symbolA,
  symbolB,
}: {
  holder: SharedHolder;
  chain: SharedHoldChain;
  symbolA: string;
  symbolB: string;
}) {
  return (
    <div className="glow-card rounded-xl p-4 space-y-3">
      {/* Address + combined PnL */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <a
            href={scanUrl(chain, holder.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 font-mono text-xs text-[#00F0FF] hover:text-white transition-colors"
          >
            <span>{truncAddr(holder.address)}</span>
            <ArrowSquareOut className="h-3 w-3 opacity-60" />
          </a>
          <CopyButton text={holder.address} />
        </div>
        <div className={`text-sm font-bold font-mono ${pnlColor(holder.combinedPnl)}`}>
          {holder.combinedPnl != null
            ? `${holder.combinedPnl >= 0 ? "+" : ""}${fmt(holder.combinedPnl)} combined`
            : "—"}
        </div>
      </div>

      {/* Token columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1 border-t border-white/[0.04]">
        <div>
          <div className="text-[9px] font-mono font-semibold uppercase tracking-widest text-[#6B6B80] mb-2">
            {symbolA}
          </div>
          <TokenCell data={holder.tokenA} symbol={symbolA} />
        </div>
        <div className="sm:border-l sm:border-white/[0.04] sm:pl-4">
          <div className="text-[9px] font-mono font-semibold uppercase tracking-widest text-[#6B6B80] mb-2">
            {symbolB}
          </div>
          <TokenCell data={holder.tokenB} symbol={symbolB} />
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SharedHoldPage() {
  const [chain, setChain] = useState<SharedHoldChain>("eth");
  const [addressA, setAddressA] = useState("");
  const [addressB, setAddressB] = useState("");
  const [result, setResult] = useState<SharedHoldersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusA, setStatusA] = useState<AddrStatus>("idle");
  const [statusB, setStatusB] = useState<AddrStatus>("idle");
  const timerA = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerB = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const { chain: c, addressA: a, addressB: b, result: r } = JSON.parse(saved);
        if (c) setChain(c);
        if (a) setAddressA(a);
        if (b) setAddressB(b);
        if (r) setResult(r);
      }
    } catch { /* ignore */ }
  }, []);

  const trimA = addressA.trim();
  const trimB = addressB.trim();
  const isSolana = chain === "solana";
  const isValid =
    isValidAddress(chain, trimA) &&
    isValidAddress(chain, trimB) &&
    (isSolana ? trimA !== trimB : trimA.toLowerCase() !== trimB.toLowerCase());

  // ── Auto-detect chain from address formats ────────────────────────────────
  useEffect(() => {
    const typeA = detectAddressType(trimA);
    const typeB = detectAddressType(trimB);
    // Both addresses present and agree on type
    if (typeA && typeB && typeA === typeB) {
      if (typeA === "solana" && chain !== "solana") {
        setChain("solana");
      } else if (typeA === "evm" && chain === "solana") {
        setChain("eth");
      }
    } else if (!trimB && typeA) {
      // Only addressA filled — pre-switch immediately
      if (typeA === "solana" && chain !== "solana") setChain("solana");
      else if (typeA === "evm" && chain === "solana") setChain("eth");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimA, trimB]);

  // ── Token validation (debounced DexScreener check) ────────────────────────
  function scheduleCheck(
    addr: string,
    currentChain: SharedHoldChain,
    setStatus: (s: AddrStatus) => void,
    timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  ) {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!isValidAddress(currentChain, addr)) { setStatus("idle"); return; }
    setStatus("checking");
    timerRef.current = setTimeout(async () => {
      const isToken = await checkIsToken(currentChain, addr);
      setStatus(isToken ? "token" : "not-token");
    }, 600);
  }

  // Re-run checks when chain changes (same addresses, new chain context)
  useEffect(() => {
    scheduleCheck(trimA, chain, setStatusA, timerA);
    scheduleCheck(trimB, chain, setStatusB, timerB);
    return () => {
      if (timerA.current) clearTimeout(timerA.current);
      if (timerB.current) clearTimeout(timerB.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain]);

  async function handleSearch() {
    if (!isValid || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/shared-holders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain, addressA: trimA, addressB: trimB }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to fetch data.");
        return;
      }
      setResult(data as SharedHoldersResponse);
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({ chain, addressA: trimA, addressB: trimB, result: data })
        );
      } catch { /* ignore */ }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const chainCfg = CHAINS.find((c) => c.id === chain)!;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 border border-[#00F0FF]/10 flex items-center justify-center">
          <UsersThree className="h-5 w-5 text-[#00F0FF]" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-[#E8E8ED]">Shared Holders</h1>
          <p className="text-xs text-[#6B6B80] font-mono">
            Find wallets that currently hold two tokens at the same time
          </p>
        </div>
      </div>

      {/* Input card */}
      <div className="glow-card rounded-xl overflow-hidden">
        {/* Chain selector */}
        <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Chain
          </span>
          <div className="flex items-center gap-1.5">
            {CHAINS.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setChain(c.id);
                  setResult(null);
                  setError(null);
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono font-semibold uppercase tracking-wider transition-all ${
                  chain === c.id
                    ? "bg-[#00F0FF]/10 text-[#00F0FF] border border-[#00F0FF]/20"
                    : "text-[#6B6B80] hover:text-[#E8E8ED] hover:bg-white/[0.04] border border-transparent"
                }`}
              >
                <img
                  src={c.logo}
                  alt={c.label}
                  className="h-3.5 w-3.5 rounded-full"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Address inputs */}
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Token A */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono font-semibold uppercase tracking-widest text-[#6B6B80]">
                Token A
              </label>
              <div className="relative">
                <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#6B6B80]" />
                <input
                  type="text"
                  placeholder={isSolana ? "Token mint address" : "0x contract address"}
                  value={addressA}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAddressA(v);
                    setResult(null);
                    setError(null);
                    scheduleCheck(v.trim(), chain, setStatusA, timerA);
                  }}
                  className={`w-full pl-8 pr-8 py-2.5 rounded-lg bg-white/[0.04] border text-xs font-mono text-[#E8E8ED] placeholder:text-[#6B6B80] focus:outline-none focus:bg-white/[0.06] transition-all ${
                    statusA === "not-token"
                      ? "border-amber-500/50 focus:border-amber-500/70"
                      : "border-white/[0.08] focus:border-[#00F0FF]/40"
                  }`}
                />
                <AddrStatusIcon status={statusA} />
              </div>
              {statusA === "not-token" && (
                <p className="text-[10px] font-mono text-amber-400">
                  Not recognized as a token contract — double-check the address
                </p>
              )}
            </div>

            {/* Token B */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono font-semibold uppercase tracking-widest text-[#6B6B80]">
                Token B
              </label>
              <div className="relative">
                <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#6B6B80]" />
                <input
                  type="text"
                  placeholder={isSolana ? "Token mint address" : "0x contract address"}
                  value={addressB}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAddressB(v);
                    setResult(null);
                    setError(null);
                    scheduleCheck(v.trim(), chain, setStatusB, timerB);
                  }}
                  className={`w-full pl-8 pr-8 py-2.5 rounded-lg bg-white/[0.04] border text-xs font-mono text-[#E8E8ED] placeholder:text-[#6B6B80] focus:outline-none focus:bg-white/[0.06] transition-all ${
                    statusB === "not-token"
                      ? "border-amber-500/50 focus:border-amber-500/70"
                      : "border-white/[0.08] focus:border-[#00F0FF]/40"
                  }`}
                />
                <AddrStatusIcon status={statusB} />
              </div>
              {statusB === "not-token" && (
                <p className="text-[10px] font-mono text-amber-400">
                  Not recognized as a token contract — double-check the address
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-[#6B6B80]">
              Searches top 500 holders per token · min $1 held
            </span>
            <button
              onClick={handleSearch}
              disabled={!isValid || loading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-[#00F0FF]/20 to-[#0080FF]/20 border border-[#00F0FF]/20 text-sm font-mono font-semibold text-[#00F0FF] hover:from-[#00F0FF]/30 hover:to-[#0080FF]/30 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <div className="h-3.5 w-3.5 border border-[#00F0FF]/40 border-t-transparent rounded-full animate-spin" />
                  Searching…
                </>
              ) : (
                <>
                  <Lightning className="h-3.5 w-3.5" />
                  Find Shared Holders
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="glow-card rounded-xl px-5 py-4 border border-red-500/20 bg-red-500/[0.04]">
          <p className="text-sm font-mono text-red-400">{error}</p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          <div className="text-xs font-mono text-[#6B6B80] animate-pulse">
            Fetching holders across both tokens… this may take ~30 seconds
          </div>
          {[...Array(3)].map((_, i) => (
            <div key={i} className="glow-card rounded-xl p-4 h-32 animate-pulse bg-white/[0.02]" />
          ))}
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-[#E8E8ED]">
                {result.holders.length} shared holder{result.holders.length !== 1 ? "s" : ""}
              </span>
              <span className="text-[10px] font-mono text-[#6B6B80]">
                holding both{" "}
                <span className="text-[#00F0FF]">{result.tokenA.symbol}</span>
                {" & "}
                <span className="text-[#00F0FF]">{result.tokenB.symbol}</span>
                {" on "}
                <span className="text-[#E8E8ED]">{chainCfg.label}</span>
              </span>
            </div>
            {chain !== "bsc" && (
              <span className="text-[10px] font-mono text-[#6B6B80]">
                PnL data included · sorted by combined PnL
              </span>
            )}
            {chain === "bsc" && (
              <span className="text-[10px] font-mono text-amber-500/70">
                PnL data not available for BSC
              </span>
            )}
          </div>

          {/* Token info pills */}
          <div className="flex items-center gap-3 flex-wrap">
            {[result.tokenA, result.tokenB].map((t) => (
              <div
                key={t.address}
                className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-xs font-mono"
              >
                {t.imageUrl ? (
                  <img
                    src={t.imageUrl}
                    alt={t.symbol}
                    className="h-8 w-8 rounded-full object-cover flex-shrink-0 ring-1 ring-white/10"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 border border-white/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-[9px] font-bold text-[#00F0FF]">{t.symbol.slice(0, 2)}</span>
                  </div>
                )}
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-[#E8E8ED]">{t.symbol}</span>
                    <span className="text-[#6B6B80] text-[10px]">{t.name}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[#6B6B80] text-[10px]">
                    <span>{t.address.slice(0, 8)}…{t.address.slice(-4)}</span>
                    {t.totalSupply != null && (
                      <span>· supply: {fmtTokens(String(t.totalSupply))}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {result.holders.length === 0 ? (
            <div className="glow-card rounded-xl px-5 py-8 text-center">
              <p className="text-sm font-mono text-[#6B6B80]">
                No shared holders found in the top 500 holders of each token.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {result.holders.map((holder) => (
                <HolderRow
                  key={holder.address}
                  holder={holder}
                  chain={result.chain}
                  symbolA={result.tokenA.symbol}
                  symbolB={result.tokenB.symbol}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
