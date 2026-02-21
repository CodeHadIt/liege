"use client";

import { PrivyProvider as BasePrivyProvider } from "@privy-io/react-auth";
import type { ReactNode } from "react";

export function PrivyProvider({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    // Gracefully render children without Privy when not configured
    return <>{children}</>;
  }

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
      {children}
    </BasePrivyProvider>
  );
}
