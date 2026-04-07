import { InlineKeyboard } from "grammy";
import type { ChainId } from "@/types/chain";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://liege.up.railway.app";

// ── Chain pickers ─────────────────────────────────────────────────────────────

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

// ── Token detail keyboard ─────────────────────────────────────────────────────
// Trading and social links live in the message body as HTML hyperlinks.
// The keyboard only holds the 3 action buttons.

export function tokenKeyboard(
  chain: ChainId,
  address: string,
): InlineKeyboard {
  return new InlineKeyboard()
    .url("Liège", `${APP_URL}/token/${chain}/${address}`)
    .text("🔄", `rt:${chain}:${address}`)
    .text("🗑️", "del");
}
