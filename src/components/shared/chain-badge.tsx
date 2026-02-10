import type { ChainId } from "@/types/chain";

const chainConfig: Record<ChainId, { label: string; color: string; bg: string }> = {
  solana: { label: "SOL", color: "#9945FF", bg: "rgba(153, 69, 255, 0.1)" },
  base: { label: "BASE", color: "#0052FF", bg: "rgba(0, 82, 255, 0.1)" },
  bsc: { label: "BSC", color: "#F0B90B", bg: "rgba(240, 185, 11, 0.1)" },
};

export function ChainBadge({ chain }: { chain: ChainId }) {
  const config = chainConfig[chain];
  if (!config) return null;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold uppercase tracking-wider border"
      style={{
        color: config.color,
        backgroundColor: config.bg,
        borderColor: `${config.color}20`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: config.color }}
      />
      {config.label}
    </span>
  );
}
