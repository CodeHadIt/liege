import { bot } from "@/lib/telegram/bot";

// Allow long-running bot handlers (scraping can take ~60s)
export const maxDuration = 120;

export async function POST(req: Request): Promise<Response> {
  // Validate webhook secret to prevent unauthorized requests
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = req.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const update = await req.json();
    // Fire-and-forget: return 200 immediately so Telegram doesn't retry,
    // while the bot processes the update in the background.
    bot.handleUpdate(update).catch((err) => {
      console.error("[telegram/webhook] Handler error:", err);
    });
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[telegram/webhook] Parse error:", err);
    return new Response("Bad Request", { status: 400 });
  }
}
