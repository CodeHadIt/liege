"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { detectChainFromAddress } from "@/lib/utils";

interface ClipboardAddress {
  address: string;
  chain: "solana" | "evm";
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

      const chain = detectChainFromAddress(trimmed);
      if (!chain) return;

      setLoading(true);

      try {
        const res = await fetch(`/api/token/search?q=${encodeURIComponent(trimmed)}`);
        const json = await res.json();
        const results = json.data ?? [];
        const match = results.find(
          (r: { address: string }) => r.address.toLowerCase() === trimmed.toLowerCase()
        );

        if (match) {
          setDetected({
            address: trimmed,
            chain,
            type: "token",
            label: match.symbol || match.name,
          });
        } else {
          setDetected({
            address: trimmed,
            chain,
            type: "wallet",
            label: `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`,
          });
        }
      } catch {
        setDetected({
          address: trimmed,
          chain,
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
