import { getAlertsBot } from "@/lib/telegram/alerts-bot";

// The Liège Alerts bot only handles a few lightweight commands (/start, /status,
// /id) behind an allow-list, so it doesn't need the long timeout the main bot's
// GMGN scraping does.
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_ALERTS_WEBHOOK_SECRET;
  if (secret) {
    const header = req.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      console.warn("[telegram/alerts] Secret mismatch — received:", header?.slice(0, 8));
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let update: unknown;
  try {
    update = await req.json();
  } catch (err) {
    console.error("[telegram/alerts] Failed to parse body:", err);
    return new Response("Bad Request", { status: 400 });
  }

  // Respond 200 immediately; process the update out of band (same rationale as
  // the main bot's webhook — Telegram retries on slow responses).
  getAlertsBot()
    .then((bot) => bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]))
    .catch((err) => console.error("[telegram/alerts] Handler error:", err));

  return new Response("OK", { status: 200 });
}
