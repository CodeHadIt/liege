"use client";

import { SignIn, SignOut, Wallet } from "@phosphor-icons/react";
import { useAuth } from "@/hooks/use-auth";
import { shortenAddress } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AuthButton() {
  const { ready, authenticated, connectedWallet, signIn, signOut } = useAuth();

  if (!ready) {
    return (
      <div className="h-9 w-24 rounded-lg bg-white/[0.03] border border-white/[0.06] animate-pulse" />
    );
  }

  if (!authenticated || !connectedWallet) {
    return (
      <button
        onClick={signIn}
        className="flex items-center gap-2 h-9 px-3 rounded-lg border border-[#00F0FF]/20 bg-[#00F0FF]/[0.06] hover:bg-[#00F0FF]/[0.12] transition-all text-sm text-[#00F0FF] font-medium"
      >
        <SignIn className="h-4 w-4" />
        <span className="hidden sm:inline">Sign In</span>
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 h-9 px-3 rounded-lg border border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06] transition-all text-sm">
          <Wallet className="h-4 w-4 text-[#00F0FF]" />
          <span className="font-mono text-[#E8E8ED] text-xs">
            {shortenAddress(connectedWallet.address, 4)}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="bg-[#111118] border-white/[0.06]"
      >
        <DropdownMenuItem
          onClick={signOut}
          className="flex items-center gap-2.5 cursor-pointer text-[#FF3B5C] focus:text-[#FF3B5C]"
        >
          <SignOut className="h-4 w-4" />
          <span>Sign Out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
