import { NextResponse } from "next/server";
import { getChainProvider } from "@/lib/chains/registry";
import * as helius from "@/lib/api/helius";
import { serverCache, CACHE_TTL } from "@/lib/cache";
import type { ChainId } from "@/types/chain";
import type { HolderEntry } from "@/types/token";
import type {
  CommonTrader,
  CommonTradersRequest,
  CommonTradersResponse,
  TokenMeta,
} from "@/types/traders";

interface HolderWithOwner {
  ownerAddress: string;
  tokenAccountAddress: string;
  balance: number;
  percentage: number;
  tokenAddress: string;
  chain: ChainId;
  symbol: string;
  priceUsd: number | null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CommonTradersRequest;
    const { tokens } = body;

    if (!tokens || tokens.length < 2 || tokens.length > 10) {
      return NextResponse.json(
        { error: "Provide 2-10 tokens" },
        { status: 400 }
      );
    }

    // Phase 1: Fetch holders + pair data for each token in parallel
    const tokenResults = await Promise.all(
      tokens.map(async ({ chain, address }) => {
        const cacheKey = `common-holders:${chain}:${address}`;
        const cached = serverCache.get<{
          holders: HolderEntry[];
          symbol: string;
          priceUsd: number | null;
        }>(cacheKey);
        if (cached) return { chain, address, ...cached };

        const provider = getChainProvider(chain);
        const [holders, pairData, metadata] = await Promise.all([
          provider.getTopHolders(address, 50),
          provider.getPairData(address),
          provider.getTokenMetadata(address),
        ]);

        const result = {
          holders,
          symbol: metadata?.symbol ?? "???",
          priceUsd: pairData?.priceUsd ?? null,
        };
        serverCache.set(cacheKey, result, CACHE_TTL.HOLDERS);

        return { chain, address, ...result };
      })
    );

    // Phase 2: Resolve Solana token account PDAs to owner wallets
    const solanaTokenAccounts: string[] = [];
    for (const tr of tokenResults) {
      if (tr.chain === "solana") {
        for (const h of tr.holders) {
          solanaTokenAccounts.push(h.address);
        }
      }
    }

    const ownerMap =
      solanaTokenAccounts.length > 0
        ? await helius.getMultipleAccountOwners(solanaTokenAccounts)
        : new Map<string, string>();

    // Build unified holder list with resolved owner addresses
    const allHolders: HolderWithOwner[] = [];
    const tokensMeta: TokenMeta[] = [];

    for (const tr of tokenResults) {
      tokensMeta.push({
        address: tr.address,
        symbol: tr.symbol,
        chain: tr.chain,
        priceUsd: tr.priceUsd,
      });

      for (const h of tr.holders) {
        // For Solana, resolve PDA to owner; for EVM, address IS the owner
        const ownerAddress =
          tr.chain === "solana"
            ? ownerMap.get(h.address) ?? h.address
            : h.address;

        allHolders.push({
          ownerAddress,
          tokenAccountAddress: h.address,
          balance: h.balance,
          percentage: h.percentage,
          tokenAddress: tr.address,
          chain: tr.chain,
          symbol: tr.symbol,
          priceUsd: tr.priceUsd,
        });
      }
    }

    // Phase 3: Group by owner wallet, find intersections
    const walletMap = new Map<
      string,
      Map<string, HolderWithOwner>
    >();

    for (const holder of allHolders) {
      // Key by ownerAddress (lowercased for EVM dedup)
      const key = holder.ownerAddress.toLowerCase();
      if (!walletMap.has(key)) {
        walletMap.set(key, new Map());
      }
      // Key inner map by tokenAddress to deduplicate
      const tokenKey = `${holder.chain}:${holder.tokenAddress}`;
      const existing = walletMap.get(key)!.get(tokenKey);
      // Keep the entry with the larger balance (in case of duplicates)
      if (!existing || holder.balance > existing.balance) {
        walletMap.get(key)!.set(tokenKey, holder);
      }
    }

    // Filter to wallets appearing in 2+ tokens
    const traders: CommonTrader[] = [];
    const inputTokenCount = tokens.length;

    for (const [, holdersByToken] of walletMap) {
      if (holdersByToken.size < 2) continue;

      const tokenEntries = Array.from(holdersByToken.values());
      let totalValueUsd = 0;

      const traderTokens = tokenEntries.map((h) => {
        const balanceUsd = h.priceUsd ? h.balance * h.priceUsd : 0;
        totalValueUsd += balanceUsd;
        return {
          address: h.tokenAddress,
          symbol: h.symbol,
          chain: h.chain,
          balance: h.balance,
          balanceUsd,
          percentage: h.percentage,
        };
      });

      traders.push({
        // Use the original-case address from the first entry
        walletAddress: tokenEntries[0].ownerAddress,
        tokens: traderTokens,
        totalValueUsd,
        tokenCount: holdersByToken.size,
      });
    }

    // Sort: most tokens first, then by total USD value
    traders.sort((a, b) => {
      if (b.tokenCount !== a.tokenCount) return b.tokenCount - a.tokenCount;
      return b.totalValueUsd - a.totalValueUsd;
    });

    const response: CommonTradersResponse = {
      traders: traders.slice(0, 100),
      tokensMeta,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Common traders error:", error);
    return NextResponse.json(
      { error: "Failed to find common traders" },
      { status: 500 }
    );
  }
}
