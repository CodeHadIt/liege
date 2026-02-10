import { cn } from "@/lib/utils";

interface ScoreIndicatorProps {
  score: number;
  grade: string;
  size?: "sm" | "md" | "lg";
}

function getScoreColor(score: number): string {
  if (score >= 80) return "text-green-500 border-green-500/30 bg-green-500/10";
  if (score >= 60) return "text-emerald-400 border-emerald-400/30 bg-emerald-400/10";
  if (score >= 40) return "text-yellow-500 border-yellow-500/30 bg-yellow-500/10";
  if (score >= 20) return "text-orange-500 border-orange-500/30 bg-orange-500/10";
  return "text-red-500 border-red-500/30 bg-red-500/10";
}

const sizes = {
  sm: "h-10 w-10 text-sm",
  md: "h-14 w-14 text-lg",
  lg: "h-20 w-20 text-2xl",
};

export function ScoreIndicator({
  score,
  grade,
  size = "md",
}: ScoreIndicatorProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-full border-2 font-bold",
        getScoreColor(score),
        sizes[size]
      )}
    >
      <span>{grade}</span>
    </div>
  );
}
