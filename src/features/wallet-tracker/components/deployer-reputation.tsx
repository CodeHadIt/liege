import { UserCheck, AlertTriangle, Skull, CheckCircle, Code } from "lucide-react";
import type { DeployerScore } from "@/types/wallet";

interface DeployerReputationProps {
  score: DeployerScore;
}

const riskColors: Record<DeployerScore["riskLevel"], string> = {
  low: "#00FF88",
  medium: "#FFB800",
  high: "#FF8C42",
  critical: "#FF3B5C",
};

const gradeColors: Record<DeployerScore["grade"], string> = {
  A: "#00FF88",
  B: "#00D4AA",
  C: "#FFB800",
  D: "#FF8C42",
  F: "#FF3B5C",
};

export function DeployerReputation({ score }: DeployerReputationProps) {
  const gradeColor = gradeColors[score.grade];
  const riskColor = riskColors[score.riskLevel];
  const circumference = 2 * Math.PI * 38;
  const strokeDashoffset = circumference - (score.score / 100) * circumference;

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserCheck className="h-4 w-4 text-[#A855F7]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Deployer Reputation
          </span>
        </div>
        <span
          className="text-[10px] font-mono font-bold px-2 py-0.5 rounded"
          style={{
            color: riskColor,
            backgroundColor: `${riskColor}10`,
            border: `1px solid ${riskColor}20`,
          }}
        >
          {score.riskLevel.toUpperCase()} RISK
        </span>
      </div>

      <div className="p-5">
        {/* Grade circle */}
        <div className="flex items-center justify-center mb-5">
          <div className="relative">
            <svg width="90" height="90" viewBox="0 0 90 90">
              <circle
                cx="45"
                cy="45"
                r="38"
                fill="none"
                stroke="rgba(255,255,255,0.04)"
                strokeWidth="5"
              />
              <circle
                cx="45"
                cy="45"
                r="38"
                fill="none"
                stroke={gradeColor}
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                transform="rotate(-90 45 45)"
                style={{
                  filter: `drop-shadow(0 0 6px ${gradeColor}40)`,
                  transition: "stroke-dashoffset 1s ease-out",
                }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span
                className="text-xl font-bold font-mono"
                style={{ color: gradeColor }}
              >
                {score.grade}
              </span>
              <span className="text-[10px] font-mono text-[#6B6B80]">
                {score.score}/100
              </span>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2">
          <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] text-center">
            <div className="flex items-center justify-center gap-1.5 mb-1">
              <Code className="h-3 w-3 text-[#00F0FF]/50" />
              <span className="text-[10px] font-mono text-[#6B6B80]">DEPLOYED</span>
            </div>
            <span className="text-lg font-bold font-mono text-[#E8E8ED]">
              {score.totalDeployed}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] text-center">
            <div className="flex items-center justify-center gap-1.5 mb-1">
              <CheckCircle className="h-3 w-3 text-[#00FF88]/50" />
              <span className="text-[10px] font-mono text-[#6B6B80]">ACTIVE</span>
            </div>
            <span className="text-lg font-bold font-mono text-[#00FF88]">
              {score.activeCount}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] text-center">
            <div className="flex items-center justify-center gap-1.5 mb-1">
              <Skull className="h-3 w-3 text-[#FF3B5C]/50" />
              <span className="text-[10px] font-mono text-[#6B6B80]">RUGGED</span>
            </div>
            <span className="text-lg font-bold font-mono text-[#FF3B5C]">
              {score.ruggedCount}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] text-center">
            <div className="flex items-center justify-center gap-1.5 mb-1">
              <AlertTriangle className="h-3 w-3 text-[#FFB800]/50" />
              <span className="text-[10px] font-mono text-[#6B6B80]">DEAD</span>
            </div>
            <span className="text-lg font-bold font-mono text-[#FFB800]">
              {score.deadCount}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
