"use client";

import { PrivyProvider as BasePrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { useMemo, useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { mainnet, base, bsc } from "viem/chains";
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
        supportedChains: [mainnet, base, bsc],
      }}
    >
      <AuthBridge>{children}</AuthBridge>
    </BasePrivyProvider>
  );
}
