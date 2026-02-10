import { Shield, TrendingUp, Users, Droplets, Clock, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DueDiligenceScore } from "@/types/token";

interface DDScoreCardProps {
  score: DueDiligenceScore;
}

const gradeColors: Record<DueDiligenceScore["grade"], string> = {
  A: "#00FF88",
  B: "#00D4AA",
  C: "#FFB800",
  D: "#FF8C42",
  F: "#FF3B5C",
};

const factors = [
  { key: "liquidity" as const, label: "Liquidity", icon: Droplets, weight: "25%" },
  { key: "holderDistribution" as const, label: "Holders", icon: Users, weight: "20%" },
  { key: "contractSafety" as const, label: "Contract", icon: Shield, weight: "25%" },
  { key: "deployerHistory" as const, label: "Deployer", icon: UserCheck, weight: "15%" },
  { key: "ageAndVolume" as const, label: "Age & Vol", icon: Clock, weight: "15%" },
];

function getScoreColor(score: number): string {
  if (score >= 80) return "#00FF88";
  if (score >= 60) return "#00D4AA";
  if (score >= 40) return "#FFB800";
  if (score >= 20) return "#FF8C42";
  return "#FF3B5C";
}

export function DDScoreCard({ score }: DDScoreCardProps) {
  const gradeColor = gradeColors[score.grade];
  const circumference = 2 * Math.PI * 42;
  const strokeDashoffset = circumference - (score.overall / 100) * circumference;

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Due Diligence Score
          </span>
        </div>
      </div>

      <div className="p-5">
        {/* Score Circle */}
        <div className="flex items-center justify-center mb-6">
          <div className="relative">
            <svg width="100" height="100" viewBox="0 0 100 100">
              {/* Background circle */}
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke="rgba(255,255,255,0.04)"
                strokeWidth="6"
              />
              {/* Score arc */}
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke={gradeColor}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                transform="rotate(-90 50 50)"
                style={{
                  filter: `drop-shadow(0 0 6px ${gradeColor}40)`,
                  transition: "stroke-dashoffset 1s ease-out",
                }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span
                className="text-2xl font-bold font-mono"
                style={{ color: gradeColor }}
              >
                {score.grade}
              </span>
              <span className="text-[11px] font-mono text-[#6B6B80]">
                {score.overall}/100
              </span>
            </div>
          </div>
        </div>

        {/* Factor Breakdown */}
        <div className="space-y-3">
          {factors.map((factor) => {
            const value = score.breakdown[factor.key];
            const color = getScoreColor(value);
            const Icon = factor.icon;
            return (
              <div key={factor.key}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <Icon className="h-3 w-3" style={{ color, opacity: 0.7 }} />
                    <span className="text-[11px] font-medium text-[#E8E8ED]">
                      {factor.label}
                    </span>
                    <span className="text-[9px] font-mono text-[#6B6B80]">
                      {factor.weight}
                    </span>
                  </div>
                  <span
                    className="text-[11px] font-mono font-bold"
                    style={{ color }}
                  >
                    {value}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${value}%`,
                      backgroundColor: color,
                      boxShadow: `0 0 8px ${color}40`,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
