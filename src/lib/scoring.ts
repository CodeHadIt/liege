import type { UnifiedTokenData, DueDiligenceScore, HolderEntry } from "@/types/token";

const WEIGHTS = {
  liquidity: 0.25,
  holderDistribution: 0.20,
  contractSafety: 0.25,
  deployerHistory: 0.15,
  ageAndVolume: 0.15,
};

export function calculateDDScore(
  token: UnifiedTokenData,
  holders: HolderEntry[]
): DueDiligenceScore {
  const liquidity = scoreLiquidity(token);
  const holderDistribution = scoreHolderDistribution(holders);
  const contractSafety = scoreContractSafety(token);
  const deployerHistory = 50; // Default — needs deployer data
  const ageAndVolume = scoreAgeAndVolume(token);

  const overall = Math.round(
    liquidity * WEIGHTS.liquidity +
    holderDistribution * WEIGHTS.holderDistribution +
    contractSafety * WEIGHTS.contractSafety +
    deployerHistory * WEIGHTS.deployerHistory +
    ageAndVolume * WEIGHTS.ageAndVolume
  );

  return {
    overall,
    grade: getGrade(overall),
    breakdown: {
      liquidity,
      holderDistribution,
      contractSafety,
      deployerHistory,
      ageAndVolume,
    },
  };
}

function scoreLiquidity(token: UnifiedTokenData): number {
  let score = 0;
  const liq = token.liquidity?.totalUsd ?? 0;

  // Liquidity depth scoring
  if (liq >= 500_000) score += 40;
  else if (liq >= 100_000) score += 30;
  else if (liq >= 50_000) score += 20;
  else if (liq >= 10_000) score += 10;

  // Pool count
  const poolCount = token.liquidity?.pools.length ?? 0;
  if (poolCount >= 3) score += 20;
  else if (poolCount >= 2) score += 15;
  else if (poolCount >= 1) score += 10;

  // Lock status
  const locked = token.liquidity?.pools.some((p) => p.isLocked === true);
  if (locked) score += 40;
  else score += 10; // Unknown or unlocked gets small credit

  return Math.min(100, score);
}

function scoreHolderDistribution(holders: HolderEntry[]): number {
  if (holders.length === 0) return 50; // No data — neutral

  const top10 = holders.slice(0, 10);
  const top10Pct = top10.reduce((sum, h) => sum + h.percentage, 0);
  const topWhalePct = top10.length > 0 ? top10[0].percentage : 0;

  let score = 100;

  // Top 10 concentration penalty
  if (top10Pct > 80) score -= 50;
  else if (top10Pct > 60) score -= 30;
  else if (top10Pct > 40) score -= 15;

  // Single whale penalty
  if (topWhalePct > 30) score -= 30;
  else if (topWhalePct > 15) score -= 15;
  else if (topWhalePct > 10) score -= 5;

  return Math.max(0, score);
}

function scoreContractSafety(token: UnifiedTokenData): number {
  if (!token.safetySignals) return 50;

  let score = 100;
  for (const flag of token.safetySignals.flags) {
    if (flag.severity === "critical") score -= 30;
    else if (flag.severity === "warning") score -= 10;
  }

  return Math.max(0, score);
}

function scoreAgeAndVolume(token: UnifiedTokenData): number {
  let score = 0;

  // Age scoring
  if (token.createdAt) {
    const ageHours = (Date.now() / 1000 - token.createdAt) / 3600;
    if (ageHours >= 720) score += 50; // 30+ days
    else if (ageHours >= 168) score += 35; // 7+ days
    else if (ageHours >= 24) score += 20; // 1+ day
    else score += 5;
  }

  // Volume scoring
  const vol = token.volume24h ?? 0;
  if (vol >= 1_000_000) score += 50;
  else if (vol >= 100_000) score += 35;
  else if (vol >= 10_000) score += 20;
  else if (vol > 0) score += 5;

  return Math.min(100, score);
}

function getGrade(score: number): DueDiligenceScore["grade"] {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  if (score >= 20) return "D";
  return "F";
}
