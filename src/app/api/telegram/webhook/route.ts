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

  // Return 200 immediately — Telegram retries any webhook that doesn't respond
  // within ~15s, which causes infinite loops for slow commands like /tt (GMGN
  // scraping takes up to 60s). Fire-and-forget is safe on Railway (persistent
  // process) since the server stays alive after the response is sent.
  getBot()
    .then((bot) => bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]))
    .then(() => console.log("[telegram/webhook] Update handled OK"))
    .catch((err) => console.error("[telegram/webhook] Handler error:", err));

  return new Response("OK", { status: 200 });
}
