import { Shield, AlertTriangle, CheckCircle, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SafetySignals, SafetyFlag } from "@/types/token";

interface ContractSafetyProps {
  signals: SafetySignals;
}

const severityConfig: Record<
  SafetyFlag["severity"],
  { icon: typeof Shield; color: string; glow: string }
> = {
  critical: { icon: XCircle, color: "#FF3B5C", glow: "rgba(255, 59, 92, 0.08)" },
  warning: { icon: AlertTriangle, color: "#FFB800", glow: "rgba(255, 184, 0, 0.06)" },
  info: { icon: Info, color: "#00F0FF", glow: "rgba(0, 240, 255, 0.06)" },
  safe: { icon: CheckCircle, color: "#00FF88", glow: "rgba(0, 255, 136, 0.06)" },
};

export function ContractSafety({ signals }: ContractSafetyProps) {
  const criticalCount = signals.flags.filter((f) => f.severity === "critical").length;
  const warningCount = signals.flags.filter((f) => f.severity === "warning").length;
  const safeCount = signals.flags.filter((f) => f.severity === "safe").length;

  return (
    <div className="glow-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-[#00F0FF]/50" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-[#6B6B80]">
            Contract Safety
          </span>
        </div>
        <div className="flex items-center gap-2">
          {criticalCount > 0 && (
            <span className="text-[10px] font-mono font-bold text-[#FF3B5C] px-1.5 py-0.5 rounded bg-[#FF3B5C]/10 border border-[#FF3B5C]/20">
              {criticalCount} CRIT
            </span>
          )}
          {warningCount > 0 && (
            <span className="text-[10px] font-mono font-bold text-[#FFB800] px-1.5 py-0.5 rounded bg-[#FFB800]/10 border border-[#FFB800]/20">
              {warningCount} WARN
            </span>
          )}
          {safeCount > 0 && (
            <span className="text-[10px] font-mono font-bold text-[#00FF88] px-1.5 py-0.5 rounded bg-[#00FF88]/10 border border-[#00FF88]/20">
              {safeCount} SAFE
            </span>
          )}
        </div>
      </div>

      {/* Flags */}
      <div className="p-3 space-y-2">
        {signals.flags.map((flag, i) => {
          const config = severityConfig[flag.severity];
          const Icon = config.icon;
          return (
            <div
              key={i}
              className="flex items-start gap-3 p-3 rounded-lg border border-white/[0.04] transition-all hover:border-white/[0.08]"
              style={{ backgroundColor: config.glow }}
            >
              <Icon
                className="h-4 w-4 mt-0.5 shrink-0"
                style={{ color: config.color }}
              />
              <div>
                <div className="text-sm font-semibold text-[#E8E8ED]">
                  {flag.label}
                </div>
                <div className="text-[11px] text-[#6B6B80] mt-0.5 leading-relaxed">
                  {flag.description}
                </div>
              </div>
            </div>
          );
        })}
        {signals.flags.length === 0 && (
          <div className="text-center py-6 text-[#6B6B80]">
            <Shield className="h-6 w-6 mx-auto mb-2 opacity-20" />
            <span className="text-xs">No safety data available</span>
          </div>
        )}
      </div>
    </div>
  );
}
