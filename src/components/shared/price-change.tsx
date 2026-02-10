import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";

interface PriceChangeProps {
  value: number | null;
  className?: string;
  showIcon?: boolean;
}

export function PriceChange({
  value,
  className,
  showIcon = false,
}: PriceChangeProps) {
  if (value == null) {
    return <span className={cn("text-[#6B6B80] font-mono", className)}>--</span>;
  }

  const isPositive = value > 0;
  const isNeutral = value === 0;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono font-medium",
        isPositive && "text-[#00FF88]",
        !isPositive && !isNeutral && "text-[#FF3B5C]",
        isNeutral && "text-[#6B6B80]",
        className
      )}
    >
      {showIcon && !isNeutral &&
        (isPositive ? (
          <TrendingUp className="h-3 w-3" />
        ) : (
          <TrendingDown className="h-3 w-3" />
        ))}
      {isPositive ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}
