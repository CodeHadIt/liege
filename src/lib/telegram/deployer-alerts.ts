import { supabase } from "@/lib/supabase";
import {
  loadAlphaDeployers,
  tokensByDeployer,
  successRate,
  recentTxs,
  mintedTokensInTx,
  markDeployerChecked,
  SUCCESS_MULTIPLE,
  type AlphaDeployer,
  type DeployerToken,
} from "@/lib/api/alpha-deployers";
import { RH_EXPLORER } from "@/lib/api/ath-tokens";
import { getAlertsBot, broadcastAlert } from "./alerts-bot";
import { escapeHtml } from "./utils/format";
import { mc } from "./alpha-alerts";
import { rateLimit } from "@/lib/rate-limiter";

// ── Alpha deployer alerts ─────────────────────────────────────────────────────
// Devs with two or more $2M runners behind them, pinged the moment they deploy
// again. Distinct from every other feed by construction: builder emojis, and a
// track record rather than a trade.

const CHAIN = "rh";

export interface NewLaunch {
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  txHash: string;
  mcUsd: number | null;
}

function multipleLabel(t: DeployerToken): string {
  if (t.athMultiple == null) return "—";
  const x = t.athMultiple;
  const hit = x >= SUCCESS_MULTIPLE ? " ✅" : "";
  return `${x >= 100 ? Math.round(x) : x.toFixed(1)}x${hit}`;
}

export function formatDeployerLaunchAlert(
  deployer: AlphaDeployer,
  launch: NewLaunch,
  history: DeployerToken[]
): string {
  const { hits, total, pct } = successRate(history);
  const lines: string[] = [];

  lines.push(`🏗️ <b>ALPHA DEV DEPLOYED</b> 🔨`);
  lines.push(`<i>A dev with ${history.length} previous $2M+ runner${history.length === 1 ? "" : "s"} just shipped again.</i>`);
  lines.push("");
  lines.push(`👷 <b>${escapeHtml(deployer.label ?? deployer.address)}</b>`);
  lines.push(`<code>${escapeHtml(deployer.address)}</code>`);
  lines.push("");

  lines.push(`🧱 <b>NEW: ${escapeHtml(launch.name || launch.symbol || "Unknown")}</b>  ·  <code>$${escapeHtml(launch.symbol ?? "?")}</code>`);
  if (launch.mcUsd != null) lines.push(`📊 MC ${mc(launch.mcUsd)}`);
  lines.push(`<code>${escapeHtml(launch.tokenAddress)}</code>`);
  lines.push(
    `🟢 <a href="https://gmgn.ai/robinhood/token/${launch.tokenAddress}">Buy on GMGN</a>` +
      `  ·  🔭 <a href="${RH_EXPLORER}/token/${launch.tokenAddress}">Blockscout</a>`
  );

  lines.push("");
  lines.push(`⚒️ <b>TRACK RECORD</b>`);
  // The success rate is the headline: two runners could be two lucky launches
  // among fifty, and the ratio is what separates that from a real hit rate.
  lines.push(
    total > 0
      ? `🎯 <b>${hits}/${total} went ${SUCCESS_MULTIPLE}x+ from launch</b> (${pct.toFixed(0)}%)`
      : `🎯 <i>Launch market caps unavailable — success rate not measurable.</i>`
  );
  lines.push("");

  for (const t of history) {
    const bits = [`ATH ${mc(t.athMcUsd)}`];
    if (t.currentMcUsd != null) bits.push(`now ${mc(t.currentMcUsd)}`);
    if (t.deployMcUsd != null) bits.push(`from ${mc(t.deployMcUsd)}`);
    bits.push(multipleLabel(t));
    lines.push(`• <b>$${escapeHtml(t.symbol ?? "?")}</b> — ${bits.join("  ·  ")}`);
  }

  lines.push("");
  lines.push(`🏗 <a href="${RH_EXPLORER}/address/${deployer.address}">Dev wallet</a>`);
  return lines.join("\n");
}

async function send(chatId: string, text: string): Promise<void> {
  const bot = await getAlertsBot();
  await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

/** Current market cap for a freshly deployed token, if anything indexes it yet. */
async function fetchMc(tokenAddress: string): Promise<number | null> {
  await rateLimit("dexscreener");
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${tokenAddress}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const pairs = Array.isArray(d) ? d : (d?.pairs ?? []);
    const pool = pairs.sort(
      (a: { liquidity?: { usd?: number } }, b: { liquidity?: { usd?: number } }) =>
        (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0];
    return pool?.marketCap ?? pool?.fdv ?? null;
  } catch {
    return null;
  }
}

/**
 * One poll: check every alpha deployer for transactions we haven't examined, and
 * alert on any that minted a token we haven't seen before.
 */
export async function pollDeployerLaunches(): Promise<void> {
  const deployers = await loadAlphaDeployers(CHAIN);
  if (deployers.length === 0) return;

  for (const dep of deployers) {
    const txs = await recentTxs(dep.address);
    if (txs.length === 0) continue;

    // First sighting: record the head and alert on nothing, so adding a deployer
    // never replays its entire history as new launches.
    if (!dep.lastSeenTx) {
      await markDeployerChecked(dep.id, txs[0].hash);
      continue;
    }

    const idx = txs.findIndex((t) => t.hash === dep.lastSeenTx);
    // Unknown cursor means the head moved further than one page; take the page
    // rather than nothing, since the token dedupe below is the real guard.
    const fresh = idx === -1 ? txs : txs.slice(0, idx);
    await markDeployerChecked(dep.id, txs[0].hash);
    if (fresh.length === 0) continue;

    for (const tx of fresh) {
      const minted = await mintedTokensInTx(tx.hash);
      for (const token of minted) {
        // A launch is announced once, ever — the unique constraint on
        // (chain, token_address) is what survives restarts and cursor resets.
        const { error } = await supabase.from("deployer_launches").insert({
          deployer_id: dep.id,
          chain: CHAIN,
          deployer_address: dep.address,
          token_address: token.address,
          token_name: token.name,
          token_symbol: token.symbol,
          tx_hash: tx.hash,
          launched_at: tx.timestamp,
        });
        if (error) continue; // already recorded

        const history = await tokensByDeployer(CHAIN, dep.address);
        const mcUsd = await fetchMc(token.address);
        const text = formatDeployerLaunchAlert(
          dep,
          { tokenAddress: token.address, symbol: token.symbol, name: token.name, txHash: tx.hash, mcUsd },
          history
        );
        await broadcastAlert((chatId) => send(chatId, text));
        await supabase
          .from("deployer_launches")
          .update({ alerted_at: new Date().toISOString(), mc_at_alert_usd: mcUsd })
          .eq("chain", CHAIN)
          .eq("token_address", token.address);
        console.log(`[deployers] ${dep.label} deployed ${token.symbol ?? token.address}`);
      }
    }
  }
}
