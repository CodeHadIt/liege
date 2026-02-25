"use client";

import { PrivyProvider as BasePrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { useMemo, useCallback, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { mainnet, base, bsc } from "viem/chains";
import { AuthContext, type AuthContextValue } from "./auth-context";

const SUPPORTED_CHAINS = [mainnet, base, bsc];
const solanaConnectors = toSolanaWalletConnectors();

function AuthBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const queryClient = useQueryClient();

  const signIn = useCallback(() => {
    login();
  }, [login]);

  const signOut = useCallback(async () => {
    await logout();
    queryClient.removeQueries({ queryKey: ["auth-user"] });
    queryClient.removeQueries({ queryKey: ["favorites"] });
  }, [logout, queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      authenticated,
      privyUser: user,
      wallets,
      signIn,
      signOut,
      getAccessToken,
    }),
    [ready, authenticated, user, wallets, signIn, signOut, getAccessToken]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function PrivyInner({
  appId,
  children,
}: {
  appId: string;
  children: ReactNode;
}) {
  // Stabilize config so BasePrivyProvider doesn't remount mid-flow
  const configRef = useRef({
    appearance: {
      theme: "dark" as const,
      accentColor: "#00F0FF" as const,
    },
    loginMethods: ["wallet" as const],
    supportedChains: SUPPORTED_CHAINS,
    externalWallets: {
      solana: {
        connectors: solanaConnectors,
      },
    },
  });

  return (
    <BasePrivyProvider appId={appId} config={configRef.current}>
      <AuthBridge>{children}</AuthBridge>
    </BasePrivyProvider>
  );
}
