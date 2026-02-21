"use client";

import { Star } from "@phosphor-icons/react";
import { useAuth } from "@/hooks/use-auth";
import { useFavorites } from "@/hooks/use-favorites";
import { cn } from "@/lib/utils";
import type { ChainId } from "@/types/chain";

interface FavoriteButtonProps {
  walletAddress: string;
  chain: ChainId;
  className?: string;
}

export function FavoriteButton({
  walletAddress,
  chain,
  className,
}: FavoriteButtonProps) {
  const { authenticated, signIn } = useAuth();
  const { isFavorited, getFavoriteId, addFavorite, removeFavorite, isAdding, isRemoving } =
    useFavorites();

  const favorited = authenticated && isFavorited(walletAddress, chain);
  const isLoading = isAdding || isRemoving;

  function handleClick() {
    if (!authenticated) {
      signIn();
      return;
    }

    if (favorited) {
      const id = getFavoriteId(walletAddress, chain);
      if (id) removeFavorite(id);
    } else {
      addFavorite({ walletAddress, chain });
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={isLoading}
      className={cn(
        "flex items-center justify-center h-8 w-8 rounded-lg border transition-all",
        favorited
          ? "border-[#FFB800]/30 bg-[#FFB800]/10 text-[#FFB800] hover:bg-[#FFB800]/20"
          : "border-white/[0.06] bg-white/[0.03] text-[#6B6B80] hover:text-[#FFB800] hover:border-[#FFB800]/20 hover:bg-[#FFB800]/[0.06]",
        isLoading && "opacity-50 pointer-events-none",
        className
      )}
      title={favorited ? "Remove from favorites" : "Add to favorites"}
    >
      <Star
        className="h-4 w-4"
        weight={favorited ? "fill" : "regular"}
      />
    </button>
  );
}
