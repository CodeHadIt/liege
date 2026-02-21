"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
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
  const { ready, authenticated, user: privyUser, login, logout, getAccessToken } =
    usePrivy();
  const { wallets } = useWallets();
  const queryClient = useQueryClient();

  const connectedWallet = useMemo<ConnectedWalletInfo | null>(() => {
    if (!authenticated) return null;

    // First check the Privy user object for wallet info (includes Solana)
    if (privyUser?.wallet) {
      const w = privyUser.wallet;
      if (w.chainType === "solana") {
        return { address: w.address, chain: "solana" };
      }
      // For EVM wallets from user object, default to base
      // (the user object doesn't have specific chain ID)
    }

    // Fall back to connected EVM wallets from useWallets()
    if (wallets.length > 0) {
      const wallet = wallets[0];
      return {
        address: wallet.address,
        chain: evmChainIdToChain(wallet.chainId),
      };
    }

    // If we have a user wallet but couldn't determine above, use it
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

  const signIn = useCallback(() => {
    login();
  }, [login]);

  const signOut = useCallback(async () => {
    await logout();
    queryClient.removeQueries({ queryKey: ["auth-user"] });
    queryClient.removeQueries({ queryKey: ["favorites"] });
  }, [logout, queryClient]);

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
