import { fetchQuoteTokens, fetchStonkFunLaunches } from "@/lib/api/stonkfun";
import { fetchRobinhoodStockTokens } from "@/lib/api/robinhood-stocks";
import { fetchFlapPaymentTokens } from "@/lib/api/flap";
import { fetchO1Quotes, o1KeyConfigured, O1_CHAIN } from "@/lib/api/o1";
import { fetchBasestonkLaunches } from "@/lib/api/basestonk";
import { fetchSunriseTokens } from "@/lib/api/sunrise";
import { fetchFourMemeQuoteTokens } from "@/lib/api/four-meme";
import { fetchWhitelistedQuoteMints } from "@/lib/api/pumpfun-quotes";
import { getLatestBlock as rhLatestBlock } from "@/lib/api/long-onchain";
import { getLatestBlock as poolsFunLatestBlock } from "@/lib/api/pools-fun";
import { getAlertsBot, broadcastAlert, FEATURE } from "./alerts-bot";
import { loadHealth, recordProbe, setDownAlerted, type HealthRow } from "@/lib/api/feed-health";
import { fetchWebhookInfo, judgeWebhook } from "@/lib/api/telegram-webhook";
import { escapeHtml } from "./utils/format";

// ── Monitoring the monitors ──────────────────────────────────────────────────
//
// Every chain and launchpad we watch, probed independently, so an upstream going
// dark is an event rather than an absence of events.
//
// This exists because both StonkFun feeds stopped answering production on
// 2026-09-03 and nobody knew until 09-05. Nothing in our code was broken; the
// API simply stopped responding, and a failed fetch looked exactly like a quiet
// market. Two days of new base pairs — TAO, FIGUREAI, AMC — passed unreported.
//
// Two design decisions, both learned from that:
//
//   1. It probes the SOURCE, not the feed's output. "No new stocks this week" is
//      healthy; the Robinhood registry legitimately goes a fortnight without a
//      listing. Alerting on result-staleness would cry wolf constantly and be
//      switched off, which is worse than not having it.
//   2. It runs the real fetchers from inside production, so it measures what
//      production can actually reach. The StonkFun outage was invisible from a
//      developer machine — both endpoints answered perfectly here throughout.

interface Probe {
  source: string;
  label: string;
  chain: string;
  /** True when the source answered with something usable. */
  run: () => Promise<boolean>;
  /** Skip when a prerequisite (e.g. an API key) is absent. */
  skip?: () => boolean;
  /**
   * Probe timeout. Defaults to 60s, but a client with its own retry budget needs
   * longer than that budget or the probe reports DOWN for a source that is merely
   * rate-limited. o1 honours Retry-After with up to 3 x 30s waits, so a 60s
   * timeout marked it down every single time it was throttled — a false alarm,
   * and false alarms are how a watchdog gets ignored.
   */
  timeoutMs?: number;
}

const PROBES: Probe[] = [
  {
    source: "stonkfun.quotes",
    label: "StonkFun quote catalog",
    chain: "Solana",
    run: async () => {
      const q = await fetchQuoteTokens();
      return q !== null && q.length > 0;
    },
  },
  {
    source: "stonkfun.launches",
    label: "StonkFun launches feed",
    chain: "Solana",
    run: async () => {
      const l = await fetchStonkFunLaunches();
      return l !== null && l.length > 0;
    },
  },
  {
    source: "pumpfun.quotes",
    label: "Pump.fun quote whitelist",
    chain: "Solana",
    run: async () => {
      const m = await fetchWhitelistedQuoteMints();
      return m !== null && m.length > 0;
    },
  },
  {
    source: "sunrise.tokens",
    label: "Sunrise asset list",
    chain: "Solana",
    run: async () => (await fetchSunriseTokens()).length > 0,
  },
  {
    source: "robinhood.registry",
    label: "Robinhood asset registry",
    chain: "Robinhood Chain",
    run: async () => (await fetchRobinhoodStockTokens()).length > 0,
  },
  {
    source: "robinhood.rpc",
    label: "Robinhood Chain RPC",
    chain: "Robinhood Chain",
    run: async () => (await rhLatestBlock()) !== null,
  },
  {
    source: "poolsfun.rpc",
    label: "pools.fun factory reads",
    chain: "Robinhood Chain",
    run: async () => (await poolsFunLatestBlock()) !== null,
  },
  {
    source: "flap.catalog",
    label: "Flap payment tokens (RH + BNB)",
    chain: "multi",
    run: async () => (await fetchFlapPaymentTokens()).length > 0,
  },
  {
    source: "fourmeme.quotes",
    label: "Four.meme quote tokens",
    chain: "BNB Chain",
    run: async () => (await fetchFourMemeQuoteTokens()).length > 0,
  },
  {
    source: "basestonk.launches",
    label: "basestonk launch feed",
    chain: "Base",
    run: async () => {
      const l = await fetchBasestonkLaunches(10);
      return l !== null && l.length > 0;
    },
  },
  {
    source: "o1.base",
    label: "o1 quote catalog (Base)",
    chain: "Base",
    skip: () => !o1KeyConfigured(),
    timeoutMs: 150_000,
    run: async () => {
      const q = await fetchO1Quotes(O1_CHAIN.BASE, false);
      return q !== null && q.length > 0;
    },
  },
  /*
   * The inbound half of the bot.
   *
   * Every other probe here asks "can we READ an upstream". These two ask "can
   * Telegram REACH us", which nothing watched until the webhook spent an unknown
   * length of time answering 401 to every update — the alerts bot's commands had
   * never once worked, and the feeds kept pushing happily throughout because
   * broadcasting never touches the webhook.
   *
   * Probing Telegram's own API rather than our route, because Telegram is the one
   * that knows whether delivery succeeded. Hitting our own endpoint would only
   * prove the server is up, which is the part that was never broken.
   */
  {
    source: "telegram.webhook.alerts",
    label: "Telegram inbound webhook (alerts bot)",
    chain: "infra",
    skip: () => !process.env.TELEGRAM_ALERTS_API_KEY,
    timeoutMs: 30_000,
    run: async () => {
      const info = await fetchWebhookInfo(process.env.TELEGRAM_ALERTS_API_KEY as string);
      if (info === null) throw new Error("getWebhookInfo did not answer");
      const verdict = judgeWebhook(info);
      if (!verdict.healthy) throw new Error(verdict.reason ?? "webhook unhealthy");
      return true;
    },
  },
  {
    source: "telegram.webhook.main",
    label: "Telegram inbound webhook (main bot)",
    chain: "infra",
    skip: () => !process.env.TELEGRAM_API_KEY,
    timeoutMs: 30_000,
    run: async () => {
      const info = await fetchWebhookInfo(process.env.TELEGRAM_API_KEY as string);
      if (info === null) throw new Error("getWebhookInfo did not answer");
      const verdict = judgeWebhook(info);
      if (!verdict.healthy) throw new Error(verdict.reason ?? "webhook unhealthy");
      return true;
    },
  },
  {
    source: "o1.rh",
    label: "o1 quote catalog (Robinhood)",
    chain: "Robinhood Chain",
    skip: () => !o1KeyConfigured(),
    timeoutMs: 150_000,
    run: async () => {
      const q = await fetchO1Quotes(O1_CHAIN.ROBINHOOD, false);
      return q !== null && q.length > 0;
    },
  },
];

/**
 * How many consecutive failed probes before it counts as down.
 *
 * Not 1. Every source here is a public endpoint that will occasionally time out
 * or rate-limit, and a watchdog that fires on a single blip gets muted, which
 * would leave us exactly where we started. Three failures at a 10-minute cadence
 * means roughly half an hour of genuine unavailability.
 */
const FAILURES_BEFORE_DOWN = 3;

function formatDownAlert(rows: { probe: Probe; row: HealthRow | undefined }[]): string {
  const lines: string[] = [];
  lines.push(`🔴 <b>MONITORING DOWN</b>`);
  lines.push(`<i>These sources are not answering. Alerts that depend on them are silent, not quiet.</i>`);
  lines.push("");
  for (const { probe, row } of rows) {
    lines.push(`<b>${escapeHtml(probe.label)}</b>`);
    lines.push(`⛓ ${escapeHtml(probe.chain)}  ·  <code>${escapeHtml(probe.source)}</code>`);
    lines.push(`❌ ${row?.consecutive_failures ?? "?"} consecutive failures`);
    if (row?.last_ok_at) {
      const mins = Math.round((Date.now() - Date.parse(row.last_ok_at)) / 60000);
      lines.push(`🕐 Last good response: ${mins > 120 ? `${Math.round(mins / 60)}h` : `${mins}m`} ago`);
    } else {
      lines.push(`🕐 No successful response on record`);
    }
    if (row?.last_error) lines.push(`💬 <code>${escapeHtml(row.last_error.slice(0, 160))}</code>`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatRecoveryAlert(probes: Probe[]): string {
  const lines: string[] = [];
  lines.push(`🟢 <b>MONITORING RECOVERED</b>`);
  lines.push("");
  for (const p of probes) {
    lines.push(`<b>${escapeHtml(p.label)}</b>  ·  ⛓ ${escapeHtml(p.chain)}`);
  }
  lines.push("");
  lines.push(`<i>Note: anything these sources listed while they were down was not alerted.</i>`);
  return lines.join("\n");
}

async function send(chatId: string, text: string): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

/**
 * One health sweep.
 *
 * Probes run in parallel — they hit different hosts, and a slow one should not
 * delay the rest. Each is independently timed out so a hanging socket cannot
 * stall the sweep indefinitely.
 */
export async function pollFeedHealth(): Promise<void> {
  const health = await loadHealth();
  if (health === null) {
    console.error("[health] cannot read feed_health — has add_feed_health.sql been run?");
    return;
  }

  const active = PROBES.filter((p) => !p.skip?.());
  const results = await Promise.all(
    active.map(async (p) => {
      const prior = health.get(p.source);
      let ok = false;
      let err: string | null = null;
      try {
        const limit = p.timeoutMs ?? 60_000;
        ok = await Promise.race([
          p.run(),
          new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error(`probe timeout (${limit / 1000}s)`)), limit)),
        ]);
        if (!ok) err = "responded but returned no usable data";
      } catch (e) {
        err = (e as Error).message;
      }
      await recordProbe(p.source, p.label, p.chain, ok, err, prior);
      return { probe: p, prior, ok, err };
    })
  );

  const failing = results.filter((r) => !r.ok);
  const healthy = results.filter((r) => r.ok);
  console.log(`[health] ${healthy.length}/${results.length} sources OK${failing.length ? ` — failing: ${failing.map((f) => f.probe.source).join(", ")}` : ""}`);

  // Newly down: crossed the threshold and not yet announced.
  const newlyDown = failing.filter(
    (r) => (r.prior?.consecutive_failures ?? 0) + 1 >= FAILURES_BEFORE_DOWN && !r.prior?.down_alerted
  );
  if (newlyDown.length) {
    const text = formatDownAlert(newlyDown.map((r) => ({ probe: r.probe, row: { ...(r.prior as HealthRow), consecutive_failures: (r.prior?.consecutive_failures ?? 0) + 1, last_error: r.err } })));
    try {
      await broadcastAlert(FEATURE.HEALTH, (chatId) => send(chatId, text));
      for (const r of newlyDown) await setDownAlerted(r.probe.source, true);
      console.error(`[health] ALERTED DOWN: ${newlyDown.map((r) => r.probe.source).join(", ")}`);
    } catch (e) {
      console.error("[health] failed to send down alert:", e);
    }
  }

  // Recovered: previously announced down, now answering. recordProbe already
  // cleared the flag, so this reads the PRIOR state to decide.
  const recovered = healthy.filter((r) => r.prior?.down_alerted);
  if (recovered.length) {
    try {
      await broadcastAlert(FEATURE.HEALTH, (chatId) => send(chatId, formatRecoveryAlert(recovered.map((r) => r.probe))));
      console.log(`[health] ALERTED RECOVERY: ${recovered.map((r) => r.probe.source).join(", ")}`);
    } catch (e) {
      console.error("[health] failed to send recovery alert:", e);
    }
  }
}

/** Diagnostic: probe everything once and report, sending nothing. */
export async function healthSnapshot(): Promise<{ source: string; label: string; chain: string; ok: boolean; error: string | null }[]> {
  const active = PROBES.filter((p) => !p.skip?.());
  return Promise.all(
    active.map(async (p) => {
      try {
        const limit = p.timeoutMs ?? 60_000;
        const ok = await Promise.race([
          p.run(),
          new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error(`probe timeout (${limit / 1000}s)`)), limit)),
        ]);
        return { source: p.source, label: p.label, chain: p.chain, ok, error: ok ? null : "no usable data" };
      } catch (e) {
        return { source: p.source, label: p.label, chain: p.chain, ok: false, error: (e as Error).message };
      }
    })
  );
}

/**
 * Prove at boot that an inbound update can actually be handled.
 *
 * This is not a poll. It can only break when the code changes, so it runs once
 * per process — and it exists because of a fault no poll would have found:
 * `alerts-bot.ts` never called `bot.init()`, so grammy's `handleUpdate` threw
 * "Bot not initialized!" on the first line of every inbound update. The webhook
 * route is fire-and-forget, so the throw landed in a `.catch` that only logs, and
 * the symptom was silence.
 *
 * The synthetic update is addressed to chat id 1 with a command no handler
 * matches: the allow-list middleware drops it, so nothing is sent to anybody and
 * no Telegram API call is made. All it exercises is the path from `handleUpdate`
 * to a middleware decision — which is exactly where the fault was.
 */
export async function verifyInboundPath(): Promise<boolean> {
  if (!process.env.TELEGRAM_ALERTS_API_KEY) {
    console.log("[health] inbound self-check skipped — TELEGRAM_ALERTS_API_KEY not set");
    return true;
  }

  const update = {
    update_id: 0,
    message: {
      message_id: 0,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 1, type: "private" as const },
      from: { id: 1, is_bot: false, first_name: "healthcheck" },
      text: "/liege_selfcheck",
      entities: [{ type: "bot_command" as const, offset: 0, length: 16 }],
    },
  };

  try {
    const bot = await getAlertsBot();
    await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
    console.log("[health] inbound self-check OK — handleUpdate accepts updates");
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[health] ⚠ INBOUND SELF-CHECK FAILED — no command will work:", msg);
    try {
      const text =
        `🔴 <b>BOT COMMANDS ARE DEAD</b>\n\n` +
        `<i>An inbound update could not be handled at boot, so every command to this bot will fail silently.</i>\n\n` +
        `💬 <code>${escapeHtml(msg.slice(0, 200))}</code>\n\n` +
        `<i>Alert feeds are unaffected — pushing never touches this path.</i>`;
      await broadcastAlert(FEATURE.HEALTH, (chatId) => send(chatId, text));
    } catch (sendErr) {
      console.error("[health] could not report the inbound failure:", sendErr);
    }
    return false;
  }
}
