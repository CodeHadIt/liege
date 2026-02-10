import { NextResponse } from "next/server";
import { getChainProvider, isChainSupported } from "@/lib/chains/registry";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";
import type { ApiError } from "@/types/api";
import type { WalletData } from "@/types/wallet";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> }
) {
  const { chain, address } = await params;

  if (!isChainSupported(chain)) {
    return NextResponse.json(
      { error: `Unsupported chain: ${chain}`, code: "CHAIN_ERROR" } satisfies ApiError,
      { status: 400 }
    );
  }

  try {
    const cacheKey = `wallet:${chain}:${address}`;
    const cached = serverCache.get<WalletData>(cacheKey);
    if (cached) {
      return NextResponse.json({ data: cached, cached: true });
    }

    const provider = getChainProvider(chain as ChainId);

    const [balance, deployedTokens] = await Promise.allSettled([
      provider.getWalletBalance(address),
      provider.getDeployedTokens(address),
    ]);

    const walletBalance = balance.status === "fulfilled" ? balance.value : null;
    const deployed = deployedTokens.status === "fulfilled" ? deployedTokens.value : [];

    const isDeployer = deployed.length > 0;
    const deployerScore = isDeployer ? calculateDeployerScore(deployed) : null;

    const data: WalletData = {
      address,
      chain: chain as ChainId,
      nativeBalance: walletBalance?.nativeBalance ?? 0,
      nativeBalanceUsd: walletBalance?.nativeBalanceUsd ?? 0,
      totalPortfolioUsd: walletBalance?.totalPortfolioUsd ?? 0,
      tokens: walletBalance?.tokens ?? [],
      isDeployer,
      deployedTokens: deployed,
      deployerScore,
    };

    serverCache.set(cacheKey, data, CACHE_TTL.TOKEN_META);

    return NextResponse.json({ data, timestamp: Date.now(), cached: false });
  } catch (error) {
    console.error(`Error fetching wallet ${chain}/${address}:`, error);
    return NextResponse.json(
      { error: "Internal server error", code: "UNKNOWN", chain } satisfies ApiError,
      { status: 500 }
    );
  }
}

function calculateDeployerScore(deployed: WalletData["deployedTokens"]): WalletData["deployerScore"] {
  const total = deployed.length;
  const active = deployed.filter((t) => t.status === "active").length;
  const rugged = deployed.filter((t) => t.status === "rugged").length;
  const dead = deployed.filter((t) => t.status === "dead").length;

  const rugRatio = total > 0 ? rugged / total : 0;
  let score = 100;
  score -= rugRatio * 80;
  score -= (dead / Math.max(total, 1)) * 20;
  score = Math.max(0, Math.round(score));

  let grade: "A" | "B" | "C" | "D" | "F";
  if (score >= 80) grade = "A";
  else if (score >= 60) grade = "B";
  else if (score >= 40) grade = "C";
  else if (score >= 20) grade = "D";
  else grade = "F";

  let riskLevel: "low" | "medium" | "high" | "critical";
  if (rugRatio === 0) riskLevel = "low";
  else if (rugRatio < 0.2) riskLevel = "medium";
  else if (rugRatio < 0.5) riskLevel = "high";
  else riskLevel = "critical";

  return { totalDeployed: total, activeCount: active, ruggedCount: rugged, deadCount: dead, score, grade, riskLevel };
}
