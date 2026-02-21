"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./use-auth";
import { useCallback } from "react";
import type { ChainId } from "@/types/chain";

export interface Favorite {
  id: string;
  user_id: string;
  wallet_address: string;
  chain: ChainId;
  label: string | null;
  created_at: string;
}

export function useFavorites() {
  const { authenticated, getAccessToken } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: favorites = [],
    isLoading,
    error,
  } = useQuery<Favorite[]>({
    queryKey: ["favorites"],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [];
      const res = await fetch("/api/favorites", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: authenticated,
    staleTime: 30_000,
  });

  const addMutation = useMutation({
    mutationFn: async ({
      walletAddress,
      chain,
      label,
    }: {
      walletAddress: string;
      chain: ChainId;
      label?: string;
    }) => {
      const token = await getAccessToken();
      const res = await fetch("/api/favorites", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ walletAddress, chain, label }),
      });
      if (!res.ok) throw new Error("Failed to add favorite");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["favorites"] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const token = await getAccessToken();
      const res = await fetch(`/api/favorites/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to remove favorite");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["favorites"] });
    },
  });

  const isFavorited = useCallback(
    (address: string, chain: ChainId): boolean => {
      return favorites.some(
        (f) =>
          f.wallet_address.toLowerCase() === address.toLowerCase() &&
          f.chain === chain
      );
    },
    [favorites]
  );

  const getFavoriteId = useCallback(
    (address: string, chain: ChainId): string | null => {
      const fav = favorites.find(
        (f) =>
          f.wallet_address.toLowerCase() === address.toLowerCase() &&
          f.chain === chain
      );
      return fav?.id ?? null;
    },
    [favorites]
  );

  return {
    favorites,
    isLoading,
    error,
    addFavorite: addMutation.mutate,
    removeFavorite: removeMutation.mutate,
    isAdding: addMutation.isPending,
    isRemoving: removeMutation.isPending,
    isFavorited,
    getFavoriteId,
  };
}
