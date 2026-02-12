import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(num: number | null | undefined): string {
  if (num == null) return "—";
  if (num === 0) return "0";
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  if (abs >= 1) return num.toFixed(2);
  if (abs >= 0.01) return num.toFixed(4);
  return num.toFixed(6);
}

export function formatUsd(num: number | null | undefined): string {
  if (num == null) return "—";
  return `$${formatNumber(num)}`;
}

export function formatPercent(num: number | null | undefined): string {
  if (num == null) return "—";
  const sign = num >= 0 ? "+" : "";
  return `${sign}${num.toFixed(2)}%`;
}

export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp * 1000) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function detectChainFromAddress(
  address: string
): "solana" | "evm" | null {
  if (isValidSolanaAddress(address)) return "solana";
  if (isValidEvmAddress(address)) return "evm";
  return null;
}

const CHAIN_LABELS: Record<string, string> = {
  solana: "SOL",
  base: "BASE",
  bsc: "BSC",
  evm: "EVM",
};

export function chainLabel(chain: string): string {
  return CHAIN_LABELS[chain] ?? chain.toUpperCase();
}
