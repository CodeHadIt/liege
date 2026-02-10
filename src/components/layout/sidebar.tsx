"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  TrendingUp,
  Search,
  Shield,
  Crown,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/trending", label: "Trending", icon: TrendingUp, shortcut: "T" },
  { href: "/search", label: "Search", icon: Search, shortcut: "S" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 bg-[#0D0D14] border-r border-white/[0.04]">
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-white/[0.04]">
        <div className="relative">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-[#00F0FF] to-[#0080FF] flex items-center justify-center">
            <Crown className="h-5 w-5 text-[#0A0A0F]" strokeWidth={2.5} />
          </div>
          <div className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-[#00FF88] pulse-dot" />
        </div>
        <div>
          <span className="text-lg font-bold tracking-wide text-neon">
            LIEGE
          </span>
          <div className="flex items-center gap-1.5">
            <Activity className="h-2.5 w-2.5 text-[#00FF88]" />
            <span className="text-[10px] font-mono text-[#00FF88]/70 uppercase tracking-widest">
              Live
            </span>
          </div>
        </div>
      </div>

      {/* Section label */}
      <div className="px-6 pt-6 pb-2">
        <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-[#6B6B80]">
          Navigate
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 space-y-0.5">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-[#00F0FF]/[0.08] text-[#00F0FF] shadow-[inset_0_0_20px_rgba(0,240,255,0.04)]"
                  : "text-[#6B6B80] hover:text-[#E8E8ED] hover:bg-white/[0.03]"
              )}
            >
              <div className="flex items-center gap-3">
                <item.icon
                  className={cn(
                    "h-4 w-4 transition-colors",
                    isActive ? "text-[#00F0FF]" : "text-[#6B6B80] group-hover:text-[#E8E8ED]"
                  )}
                />
                {item.label}
              </div>
              <kbd
                className={cn(
                  "hidden lg:inline text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors",
                  isActive
                    ? "border-[#00F0FF]/20 text-[#00F0FF]/50"
                    : "border-white/[0.06] text-[#6B6B80]/50"
                )}
              >
                {item.shortcut}
              </kbd>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-white/[0.04]">
        <div className="glow-card rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Shield className="h-3.5 w-3.5 text-[#00F0FF]" />
            <span className="text-xs font-semibold text-[#E8E8ED]">
              Onchain Intel
            </span>
          </div>
          <p className="text-[10px] text-[#6B6B80] leading-relaxed">
            Deep analysis for Solana, Base & BSC
          </p>
        </div>
      </div>
    </aside>
  );
}
