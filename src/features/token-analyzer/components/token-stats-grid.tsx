import { formatUsd, formatNumber, formatTimeAgo } from "@/lib/utils";
import {
  CurrencyDollarSimple,
  ChartBar,
  Drop,
  ArrowsLeftRight,
  Clock,
  Stack,
} from "@phosphor-icons/react";
import type { UnifiedTokenData } from "@/types/token";

interface TokenStatsGridProps {
  token: UnifiedTokenData;
}

const iconColors = [
  "#00F0FF",
  "#A855F7",
  "#00FF88",
  "#FFB800",
  "#FF3B5C",
  "#0080FF",
];

export function TokenStatsGrid({ token }: TokenStatsGridProps) {
  const stats = [
    {
      label: "MARKET CAP",
      value: formatUsd(token.marketCap),
      icon: CurrencyDollarSimple,
    },
    {
      label: "24H VOLUME",
      value: formatUsd(token.volume24h),
      icon: ChartBar,
    },
    {
      label: "LIQUIDITY",
      value: formatUsd(token.liquidity?.totalUsd),
      icon: Drop,
    },
    {
      label: "FDV",
      value: formatUsd(token.fdv),
      icon: Stack,
    },
    {
      label: "24H TXNS",
      value: token.txns24h
        ? `${formatNumber(token.txns24h.buys + token.txns24h.sells)}`
        : "--",
      sub: token.txns24h
        ? `${token.txns24h.buys}B / ${token.txns24h.sells}S`
        : undefined,
      icon: ArrowsLeftRight,
    },
    {
      label: "AGE",
      value: token.createdAt ? formatTimeAgo(token.createdAt) : "--",
      icon: Clock,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {stats.map((stat, i) => (
        <div
          key={stat.label}
          className={`glow-card stat-card rounded-xl p-4 animate-fade-up stagger-${i + 1}`}
        >
          <div className="flex items-center gap-2 mb-2.5">
            <stat.icon
              className="h-3.5 w-3.5"
              style={{ color: iconColors[i], opacity: 0.6 }}
            />
            <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6B6B80]">
              {stat.label}
            </span>
          </div>
          <div className="text-base font-bold font-mono text-[#E8E8ED]">
            {stat.value}
          </div>
          {stat.sub && (
            <div className="text-[10px] font-mono text-[#6B6B80] mt-1">
              {stat.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
