"use client";

import { PrivyProvider as BasePrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { useMemo, useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AuthContext, type AuthContextValue } from "./auth-context";

function AuthBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const queryClient = useQueryClient();

  const signIn = useCallback(() => login(), [login]);

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
  return (
    <BasePrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#00F0FF",
        },
        loginMethods: ["wallet"],
        supportedChains: [
          {
            id: 1,
            name: "Ethereum",
            network: "homestead",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: {
              default: { http: ["https://eth.llamarpc.com"] },
            },
          } as any,
          {
            id: 8453,
            name: "Base",
            network: "base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: {
              default: { http: ["https://mainnet.base.org"] },
            },
          } as any,
          {
            id: 56,
            name: "BNB Smart Chain",
            network: "bsc",
            nativeCurrency: {
              name: "BNB",
              symbol: "BNB",
              decimals: 18,
            },
            rpcUrls: {
              default: { http: ["https://bsc-dataseed1.binance.org"] },
            },
          } as any,
        ],
      }}
    >
      <AuthBridge>{children}</AuthBridge>
    </BasePrivyProvider>
  );
}
