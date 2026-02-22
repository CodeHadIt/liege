"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { AuthFallbackProvider } from "./auth-context";

/** Client-only Privy inner provider — never loaded during SSR */
const PrivyInner = dynamic(() => import("./privy-inner").then((m) => m.PrivyInner), {
  ssr: false,
});

export function PrivyProvider({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    return <AuthFallbackProvider>{children}</AuthFallbackProvider>;
  }

  return <PrivyInner appId={appId}>{children}</PrivyInner>;
}
