"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Star, Smiley, CircleNotch } from "@phosphor-icons/react";
import { useAuth } from "@/hooks/use-auth";
import { useFavorites } from "@/hooks/use-favorites";
import { useFolders } from "@/hooks/use-folders";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type { ChainId } from "@/types/chain";

const EmojiPicker = dynamic(
  () => import("@emoji-mart/react").then((mod) => mod.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center p-8">
        <CircleNotch className="h-5 w-5 animate-spin text-[#00F0FF]" />
      </div>
    ),
  }
);

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
  const { folders } = useFolders();

  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("");
  const [folderId, setFolderId] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const favorited = authenticated && isFavorited(walletAddress, chain);
  const isLoading = isAdding || isRemoving;

  function resetForm() {
    setLabel("");
    setEmoji("");
    setFolderId("");
    setShowEmojiPicker(false);
  }

  function handleStarClick() {
    if (!authenticated) {
      signIn();
      return;
    }

    if (favorited) {
      const id = getFavoriteId(walletAddress, chain);
      if (id) removeFavorite(id);
    }
    // If not favorited, the Popover trigger handles opening
  }

  function handleSave() {
    addFavorite({
      walletAddress,
      chain,
      label: label.trim() || undefined,
      emoji: emoji || undefined,
      folder_id: folderId || undefined,
    });
    setOpen(false);
    resetForm();
  }

  // Already favorited: plain button to remove
  if (favorited) {
    return (
      <button
        onClick={handleStarClick}
        disabled={isLoading}
        className={cn(
          "flex items-center justify-center h-8 w-8 rounded-lg border transition-all",
          "border-[#FFB800]/30 bg-[#FFB800]/10 text-[#FFB800] hover:bg-[#FFB800]/20",
          isLoading && "opacity-50 pointer-events-none",
          className
        )}
        title="Remove from favorites"
      >
        <Star className="h-4 w-4" weight="fill" />
      </button>
    );
  }

  // Not favorited: popover with form
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!authenticated) {
          signIn();
          return;
        }
        setOpen(next);
        if (!next) resetForm();
      }}
    >
      <PopoverTrigger asChild>
        <button
          disabled={isLoading}
          className={cn(
            "flex items-center justify-center h-8 w-8 rounded-lg border transition-all",
            "border-white/[0.06] bg-white/[0.03] text-[#6B6B80] hover:text-[#FFB800] hover:border-[#FFB800]/20 hover:bg-[#FFB800]/[0.06]",
            isLoading && "opacity-50 pointer-events-none",
            className
          )}
          title="Add to favorites"
        >
          <Star className="h-4 w-4" weight="regular" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-72">
        <div className="space-y-3">
          <div className="text-xs font-semibold text-[#E8E8ED] font-mono tracking-wide uppercase">
            Add to Favorites
          </div>

          {/* Label input */}
          <div>
            <label className="text-[10px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1 block">
              Label (optional)
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Smart money whale"
              className="w-full h-8 px-2.5 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm font-mono text-[#E8E8ED] placeholder:text-[#6B6B80]/50 outline-none focus:border-[#00F0FF]/30 transition-colors"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
            />
          </div>

          {/* Emoji picker */}
          <div>
            <label className="text-[10px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1 block">
              Emoji (optional)
            </label>
            <div className="relative">
              <button
                onClick={() => setShowEmojiPicker((v) => !v)}
                className="h-8 px-3 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm font-mono text-[#E8E8ED] hover:border-[#00F0FF]/20 transition-colors flex items-center gap-2"
              >
                {emoji ? (
                  <span className="text-lg leading-none">{emoji}</span>
                ) : (
                  <Smiley className="h-4 w-4 text-[#6B6B80]" />
                )}
                <span className="text-xs text-[#6B6B80]">
                  {emoji ? "Change" : "Pick emoji"}
                </span>
              </button>
              {showEmojiPicker && (
                <div className="absolute top-10 left-0 z-[9999]">
                  <EmojiPicker
                    data={async () =>
                      (await import("@emoji-mart/data")).default
                    }
                    theme="dark"
                    onEmojiSelect={(e: { native: string }) => {
                      setEmoji(e.native);
                      setShowEmojiPicker(false);
                    }}
                    previewPosition="none"
                    skinTonePosition="search"
                    maxFrequentRows={1}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Folder select */}
          {folders.length > 0 && (
            <div>
              <label className="text-[10px] font-mono uppercase tracking-widest text-[#6B6B80] mb-1 block">
                Folder (optional)
              </label>
              <select
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                className="w-full h-8 px-2.5 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm font-mono text-[#E8E8ED] outline-none focus:border-[#00F0FF]/30 transition-colors appearance-none cursor-pointer"
              >
                <option value="" className="bg-[#1A1A2E]">
                  No folder
                </option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id} className="bg-[#1A1A2E]">
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={isAdding}
            className="w-full h-8 rounded-lg bg-[#FFB800]/10 border border-[#FFB800]/20 text-[#FFB800] text-sm font-semibold font-mono hover:bg-[#FFB800]/20 transition-all disabled:opacity-50"
          >
            {isAdding ? (
              <CircleNotch className="h-4 w-4 animate-spin mx-auto" />
            ) : (
              "Save"
            )}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
