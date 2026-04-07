import { getBot } from "@/lib/telegram/bot";

// Allow long-running bot handlers (scraping can take ~60s)
export const maxDuration = 120;

export async function POST(req: Request): Promise<Response> {
  // Validate webhook secret to prevent unauthorized requests
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = req.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      console.warn("[telegram/webhook] Secret mismatch — received:", header?.slice(0, 8));
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let update: unknown;
  try {
    update = await req.json();
  } catch (err) {
    console.error("[telegram/webhook] Failed to parse body:", err);
    return new Response("Bad Request", { status: 400 });
  }

  console.log("[telegram/webhook] Update received:", JSON.stringify(update).slice(0, 200));

  try {
    const bot = getBot();
    // Await the handler so errors are visible in Railway logs.
    // maxDuration = 120 gives us enough headroom for the 60s Telegram timeout.
    await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
    console.log("[telegram/webhook] Update handled OK");
  } catch (err) {
    // Log the error but still return 200 — returning non-200 causes Telegram to retry endlessly.
    console.error("[telegram/webhook] Handler error:", err);
  }

  return new Response("OK", { status: 200 });
}
