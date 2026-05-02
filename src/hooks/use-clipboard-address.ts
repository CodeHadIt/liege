"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { detectChainFromAddress } from "@/lib/utils";
import type { ChainId } from "@/types/chain";

interface ClipboardAddress {
  address: string;
  chain: ChainId;
  type: "token" | "wallet";
  label: string;
}

interface UseClipboardAddressReturn {
  detected: ClipboardAddress | null;
  loading: boolean;
  dismiss: () => void;
}

export function useClipboardAddress(): UseClipboardAddressReturn {
  const [detected, setDetected] = useState<ClipboardAddress | null>(null);
  const [loading, setLoading] = useState(false);
  const lastClipboard = useRef("");
  const dismissed = useRef<Set<string>>(new Set());
  const pathname = usePathname();

  // Auto-dismiss on route change
  useEffect(() => {
    setDetected(null);
  }, [pathname]);

  const dismiss = useCallback(() => {
    if (detected) {
      dismissed.current.add(detected.address);
    }
    setDetected(null);
  }, [detected]);

  const checkClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();

      if (!trimmed || trimmed === lastClipboard.current) return;
      lastClipboard.current = trimmed;

      if (dismissed.current.has(trimmed)) return;

      const detectedType = detectChainFromAddress(trimmed);
      if (!detectedType) return;

      setLoading(true);

      try {
        const res = await fetch(`/api/token/search?q=${encodeURIComponent(trimmed)}`);
        const json = await res.json();
        const results: { address: string; chain: ChainId; symbol?: string; name?: string }[] = json.data ?? [];
        const match = results.find(
          (r) => r.address.toLowerCase() === trimmed.toLowerCase()
        );

        // For tokens: use the chain from DexScreener result (correctly identifies base vs bsc)
        // For wallets: fall back to solana or base (can't distinguish base/bsc by address alone)
        const resolvedChain: ChainId = match?.chain ?? (detectedType === "solana" ? "solana" : "base");

        if (match) {
          setDetected({
            address: trimmed,
            chain: resolvedChain,
            type: "token",
            label: match.symbol || match.name || trimmed.slice(0, 8),
          });
        } else if (detectedType === "solana") {
          // DexScreener has no data for old/low-liquidity Solana tokens.
          // Try the token API (uses Helius DAS as final fallback) to check if
          // this is actually a token mint rather than a wallet address.
          try {
            const tokenRes = await fetch(`/api/token/solana/${encodeURIComponent(trimmed)}`);
            if (tokenRes.ok) {
              const tokenJson = await tokenRes.json();
              const tokenData = tokenJson.data;
              if (tokenData?.symbol && tokenData.symbol !== "???" && tokenData?.name && tokenData.name !== "Unknown") {
                setDetected({
                  address: trimmed,
                  chain: "solana",
                  type: "token",
                  label: tokenData.symbol,
                });
                return;
              }
            }
          } catch { /* fall through to wallet */ }
          setDetected({
            address: trimmed,
            chain: "solana",
            type: "wallet",
            label: `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`,
          });
        } else {
          setDetected({
            address: trimmed,
            chain: resolvedChain,
            type: "wallet",
            label: `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`,
          });
        }
      } catch {
        const fallbackChain: ChainId = detectedType === "solana" ? "solana" : "base";
        setDetected({
          address: trimmed,
          chain: fallbackChain,
          type: "wallet",
          label: `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`,
        });
      } finally {
        setLoading(false);
      }
    } catch {
      // Clipboard permission denied — silently ignore
    }
  }, []);

  useEffect(() => {
    const onFocus = () => checkClipboard();
    const onVisibility = () => {
      if (document.visibilityState === "visible") checkClipboard();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    // Check once on mount
    checkClipboard();

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [checkClipboard]);

  return { detected, loading, dismiss };
}
