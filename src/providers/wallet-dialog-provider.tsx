"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { ChainId } from "@/types/chain";

interface WalletDialogState {
  isOpen: boolean;
  walletAddress: string | null;
  chain: ChainId | null;
}

interface WalletDialogContextValue {
  state: WalletDialogState;
  openWalletDialog: (walletAddress: string, chain: ChainId) => void;
  closeWalletDialog: () => void;
}

const WalletDialogContext = createContext<WalletDialogContextValue | null>(null);

export function WalletDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletDialogState>({
    isOpen: false,
    walletAddress: null,
    chain: null,
  });

  const openWalletDialog = useCallback(
    (walletAddress: string, chain: ChainId) => {
      setState({ isOpen: true, walletAddress, chain });
    },
    []
  );

  const closeWalletDialog = useCallback(() => {
    setState({ isOpen: false, walletAddress: null, chain: null });
  }, []);

  return (
    <WalletDialogContext.Provider
      value={{ state, openWalletDialog, closeWalletDialog }}
    >
      {children}
    </WalletDialogContext.Provider>
  );
}

export function useWalletDialog() {
  const ctx = useContext(WalletDialogContext);
  if (!ctx) {
    throw new Error(
      "useWalletDialog must be used within WalletDialogProvider"
    );
  }
  return ctx;
}
