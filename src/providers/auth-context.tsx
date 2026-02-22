"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface AuthContextValue {
  ready: boolean;
  authenticated: boolean;
  privyUser: any;
  wallets: any[];
  signIn: () => void;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const defaultValue: AuthContextValue = {
  ready: false,
  authenticated: false,
  privyUser: null,
  wallets: [],
  signIn: () => {},
  signOut: async () => {},
  getAccessToken: async () => null,
};

export const AuthContext = createContext<AuthContextValue>(defaultValue);

export function useAuthContext() {
  return useContext(AuthContext);
}

/** Fallback provider used during SSR / when Privy is not loaded */
export function AuthFallbackProvider({ children }: { children: ReactNode }) {
  return (
    <AuthContext.Provider value={defaultValue}>{children}</AuthContext.Provider>
  );
}
