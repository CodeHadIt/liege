import { InlineKeyboard } from "grammy";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://liege.up.railway.app";

export function ctChainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("◎ Solana", "ct:chain:solana")
    .text("🔵 Base", "ct:chain:base")
    .text("🟡 BSC", "ct:chain:bsc");
}

export function dexPaidPeriodKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("30m", "dexpaid:30m")
    .text("1h", "dexpaid:1h")
    .text("2h", "dexpaid:2h")
    .row()
    .text("4h", "dexpaid:4h")
    .text("8h", "dexpaid:8h");
}

/**
 * Shown when user sends an EVM address — we don't know if it's Base or BSC.
 * command: "token" | "holders" | "toptraders"
 * Callback data format: "evm:{command}:{chain}:{address}" (max 64 bytes)
 */
export function evmChainKeyboard(
  command: string,
  address: string
): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔵 Base", `evm:${command}:base:${address}`)
    .text("🟡 BSC", `evm:${command}:bsc:${address}`);
}

export function viewOnSiteKeyboard(chain: string, address: string): InlineKeyboard {
  return new InlineKeyboard().url(
    "🌐 Full Analysis on Liège",
    `${APP_URL}/token/${chain}/${address}`
  );
}
