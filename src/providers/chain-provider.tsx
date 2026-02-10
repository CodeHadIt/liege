"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { ChainId } from "@/types/chain";

interface ChainContextValue {
  activeChain: ChainId | "all";
  setActiveChain: (chain: ChainId | "all") => void;
}

const ChainContext = createContext<ChainContextValue>({
  activeChain: "all",
  setActiveChain: () => {},
});

export function ChainProvider({ children }: { children: ReactNode }) {
  const [activeChain, setActiveChainState] = useState<ChainId | "all">("all");

  const setActiveChain = useCallback((chain: ChainId | "all") => {
    setActiveChainState(chain);
  }, []);

  return (
    <ChainContext.Provider value={{ activeChain, setActiveChain }}>
      {children}
    </ChainContext.Provider>
  );
}

export function useChain() {
  return useContext(ChainContext);
}
