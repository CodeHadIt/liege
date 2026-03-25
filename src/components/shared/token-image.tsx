import { cn } from "@/lib/utils";
import { CHAIN_COLORS } from "@/components/shared/chain-badge";
import type { ChainId } from "@/types/chain";

interface TokenImageProps {
  logoUrl: string | null | undefined;
  symbol: string;
  chain: ChainId;
  /** Pass Tailwind size + shape classes, e.g. "h-8 w-8 rounded-full" */
  className?: string;
}

/**
 * Token avatar with a chain-colored border frame.
 * Renders a fallback gradient div with initials when no logoUrl is provided.
 */
export function TokenImage({ logoUrl, symbol, chain, className = "" }: TokenImageProps) {
  const color = CHAIN_COLORS[chain]?.color ?? "#6B6B80";
  const frameStyle: React.CSSProperties = {
    border: `2px solid ${color}cc`,
    boxShadow: `0 0 10px ${color}55`,
  };

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={symbol}
        className={cn("shrink-0", className)}
        style={frameStyle}
      />
    );
  }

  return (
    <div
      className={cn(
        "shrink-0 bg-gradient-to-br from-[#00F0FF]/20 to-[#A855F7]/20 flex items-center justify-center font-bold font-mono text-[#00F0FF] text-[10px]",
        className
      )}
      style={frameStyle}
    >
      {symbol.slice(0, 2)}
    </div>
  );
}
