"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./use-auth";

export interface Folder {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  created_at: string;
}

export function useFolders() {
  const { authenticated, getAccessToken } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: folders = [],
    isLoading,
  } = useQuery<Folder[]>({
    queryKey: ["favorite-folders"],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [];
      const res = await fetch("/api/favorites/folders", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: authenticated,
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: async ({ name, color }: { name: string; color?: string }) => {
      const token = await getAccessToken();
      const res = await fetch("/api/favorites/folders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) throw new Error("Failed to create folder");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["favorite-folders"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      color,
    }: {
      id: string;
      name?: string;
      color?: string | null;
    }) => {
      const token = await getAccessToken();
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (color !== undefined) body.color = color;
      const res = await fetch(`/api/favorites/folders/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to update folder");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["favorite-folders"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const token = await getAccessToken();
      const res = await fetch(`/api/favorites/folders/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to delete folder");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["favorite-folders"] });
      queryClient.invalidateQueries({ queryKey: ["favorites"] });
    },
  });

  return {
    folders,
    isLoading,
    createFolder: createMutation.mutate,
    updateFolder: updateMutation.mutate,
    deleteFolder: deleteMutation.mutate,
    isCreating: createMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}
