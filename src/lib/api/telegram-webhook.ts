// ── Telegram webhook health ───────────────────────────────────────────────────
// `getWebhookInfo` is the only window onto the half of the bot that nothing else
// watches: whether Telegram can actually DELIVER an update to us.
//
// Everything else in the monitoring suite probes an upstream source — "can we
// read StonkFun" — and the alert feeds only ever push, so for months nothing
// exercised the inbound path at all. It had been broken the whole time: the
// webhook was registered without a `secret_token` while the route required one,
// so every update was answered 401 and retried forever. Push alerts kept working,
// which is precisely why nobody noticed.
//
// Read-only. This never calls setWebhook — a watchdog that reconfigures the thing
// it is watching can turn a diagnosable fault into a moving target.

export interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  ip_address?: string;
  max_connections?: number;
}

/**
 * Ask Telegram how delivery to us is going.
 *
 * Returns null when the call itself fails, which is a different fault from an
 * unhealthy webhook and is reported as such by the caller.
 */
export async function fetchWebhookInfo(token: string, timeoutMs = 15_000): Promise<WebhookInfo | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; result?: WebhookInfo };
    if (!body.ok || !body.result) return null;
    return body.result;
  } catch {
    return null;
  }
}

/**
 * How recent a delivery error has to be to count as "now".
 *
 * Telegram keeps `last_error_date` forever, so a one-off blip six weeks ago would
 * otherwise read as a permanent outage and the alert would never clear. Only an
 * error inside this window means deliveries are failing at the moment.
 */
export const RECENT_ERROR_WINDOW_MS = 20 * 60_000;

/**
 * A backlog means Telegram is holding updates it cannot hand over. One or two is
 * normal in-flight traffic; a standing queue is the signature of a webhook that
 * answers but never succeeds — the 401 loop sat at a steady 2 and climbed.
 */
export const PENDING_BACKLOG = 5;

export interface WebhookVerdict {
  healthy: boolean;
  /** Why it is unhealthy, phrased for an alert. */
  reason?: string;
}

export function judgeWebhook(info: WebhookInfo, now = Date.now()): WebhookVerdict {
  if (!info.url) {
    return { healthy: false, reason: "no webhook registered — Telegram has nowhere to deliver updates" };
  }

  const errAgeMs = info.last_error_date !== undefined ? now - info.last_error_date * 1000 : Infinity;
  if (errAgeMs <= RECENT_ERROR_WINDOW_MS) {
    const mins = Math.max(1, Math.round(errAgeMs / 60_000));
    return {
      healthy: false,
      reason: `delivery failing (${mins}m ago): ${info.last_error_message ?? "unspecified error"}`,
    };
  }

  const pending = info.pending_update_count ?? 0;
  if (pending >= PENDING_BACKLOG) {
    return { healthy: false, reason: `${pending} updates queued at Telegram and not being consumed` };
  }

  return { healthy: true };
}
