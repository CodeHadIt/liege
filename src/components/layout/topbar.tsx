"use client";

import { Crown, Menu, Scan } from "lucide-react";
import { ChainSelector } from "./chain-selector";
import { ThemeToggle } from "./theme-toggle";
import { TokenSearch } from "@/components/shared/token-search";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Sidebar } from "./sidebar";
import { ClipboardIndicator } from "./clipboard-indicator";

export function Topbar() {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b border-white/[0.04] bg-[#0A0A0F]/90 backdrop-blur-xl px-4 md:px-6">
      {/* Mobile menu */}
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="md:hidden text-[#6B6B80] hover:text-[#00F0FF]">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-64 border-white/[0.04]">
          <Sidebar />
        </SheetContent>
      </Sheet>

      {/* Mobile logo */}
      <div className="flex items-center gap-2 md:hidden">
        <div className="h-7 w-7 rounded-md bg-gradient-to-br from-[#00F0FF] to-[#0080FF] flex items-center justify-center">
          <Crown className="h-4 w-4 text-[#0A0A0F]" strokeWidth={2.5} />
        </div>
        <span className="font-bold text-neon tracking-wide text-sm">LIEGE</span>
      </div>

      {/* Divider + label */}
      <div className="hidden md:flex items-center gap-2 text-[#6B6B80]">
        <Scan className="h-3.5 w-3.5" />
        <span className="text-[10px] font-mono uppercase tracking-[0.15em]">
          Terminal
        </span>
      </div>

      {/* Search */}
      <div className="flex-1 max-w-xl">
        <TokenSearch />
      </div>

      {/* Clipboard detection */}
      <ClipboardIndicator />

      {/* Right side */}
      <div className="flex items-center gap-2">
        <ChainSelector />
        <ThemeToggle />
      </div>
    </header>
  );
}
