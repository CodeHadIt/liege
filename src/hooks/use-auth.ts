"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAuthContext } from "@/providers/auth-context";
import type { ChainId } from "@/types/chain";

interface AuthUser {
  id: string;
  wallet_address: string;
  chain: string;
  privy_did: string;
  created_at: string;
}

interface ConnectedWalletInfo {
  address: string;
  chain: ChainId;
}

function evmChainIdToChain(chainIdStr: string): ChainId {
  const num = parseInt(chainIdStr.replace("eip155:", ""), 10);
  switch (num) {
    case 8453:
      return "base";
    case 56:
      return "bsc";
    default:
      return "base";
  }
}

export function useAuth() {
  const {
    ready,
    authenticated,
    privyUser,
    wallets,
    signIn,
    signOut,
    getAccessToken,
  } = useAuthContext();

  const connectedWallet = useMemo<ConnectedWalletInfo | null>(() => {
    if (!authenticated) return null;

    // Check the Privy user object for wallet info (includes Solana)
    if (privyUser?.wallet) {
      const w = privyUser.wallet;
      if (w.chainType === "solana") {
        return { address: w.address, chain: "solana" };
      }
    }

    // Fall back to connected EVM wallets
    if (wallets.length > 0) {
      const wallet = wallets[0];
      return {
        address: wallet.address,
        chain: evmChainIdToChain(wallet.chainId),
      };
    }

    // If we have a user wallet but couldn't match above
    if (privyUser?.wallet) {
      return { address: privyUser.wallet.address, chain: "base" };
    }

    return null;
  }, [authenticated, privyUser, wallets]);

  const { data: user } = useQuery<AuthUser | null>({
    queryKey: ["auth-user", connectedWallet?.address, connectedWallet?.chain],
    queryFn: async () => {
      if (!connectedWallet) return null;
      const token = await getAccessToken();
      if (!token) return null;

      const res = await fetch("/api/auth/me", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          walletAddress: connectedWallet.address,
          chain: connectedWallet.chain,
        }),
      });

      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!connectedWallet,
    staleTime: 5 * 60 * 1000,
  });

  return {
    ready,
    authenticated,
    user: user ?? null,
    connectedWallet,
    signIn,
    signOut,
    getAccessToken,
  };
}
