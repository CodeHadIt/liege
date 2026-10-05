// ── Rendering a page that renders itself ──────────────────────────────────────
// A static GET is the right default: most documentation is server-rendered, and a
// fetch costs milliseconds where a browser costs seconds.
//
// But a growing share of project sites ship an empty shell. kairollm.live answers
// 200 with 1,998 bytes of HTML containing exactly one line of text — "kairo · a
// crypto-native model that reads the chain's web" — and everything a reader would
// want sits inside an 856 KB JS bundle. The pipeline reported "no documentation
// found", which was true of the HTML and false about the site.
//
// Mining strings out of the bundle was the other option and a bad one: 856 KB of
// React, router and buffer internals, from which the project's own copy has to be
// separated by guesswork. Rendering asks the page to assemble its own text, which
// is what a browser is for.
//
// Reuses the Chromium launcher the GMGN scraper already runs on Railway, so there
// is no second browser configuration to keep in step.

import { getScrapingBrowser } from "@/lib/api/gmgn-scraper";
import { budgetLeft, budgetSpent, type Budget } from "../fetcher";

/** Text this thin means the HTML is a shell, whatever its status code was. */
export const THIN_TEXT_CHARS = 600;

/**
 * Does this look like a page that builds itself in the browser?
 *
 * Both halves matter. Thin text alone could be a genuinely short page, and a
 * script tag alone is true of almost everything — a shell is thin text AND a
 * script that would have filled it.
 */
export function looksClientRendered(html: string, textChars: number): boolean {
  if (textChars > THIN_TEXT_CHARS) return false;
  return /<script[^>]+src=/i.test(html) || /<div[^>]+id=["'](root|app|__next)["']/i.test(html);
}

/**
 * Render `url` and return the HTML the browser ended up with.
 *
 * Null on any failure, same contract as `fetchPage` — a site that will not render
 * is reported as unreachable rather than taking the report down with it.
 */
export async function renderPage(url: string, budget: Budget, timeoutMs = 20_000): Promise<string | null> {
  if (budgetSpent(budget)) return null;
  const limit = Math.min(timeoutMs, Math.max(5_000, budgetLeft(budget)));

  let context: Awaited<ReturnType<Awaited<ReturnType<typeof getScrapingBrowser>>["newContext"]>> | null = null;
  try {
    const browser = await getScrapingBrowser();
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      viewport: { width: 1280, height: 1600 },
    });
    const page = await context.newPage();

    // Images and fonts are pure cost here: nothing in this pipeline reads a
    // picture, and blocking them is usually the difference between a 4s render
    // and a 15s one.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });

    budget.fetches++;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: limit });

    /*
     * Wait for the text to stop growing, rather than for a fixed beat.
     *
     * kairollm.live's docs say it outright — "numbers on this page come live from
     * the Kairo server" — and a 1.2s read caught the placeholders: the fee split
     * extracted as "— goes to the treasury ... and — goes to the rewards pool",
     * with the 70/30 still in flight. A report that drops the numbers out of a
     * fee split is worse than one that says nothing about fees.
     *
     * `networkidle` is the obvious alternative and the wrong one: these pages hold
     * a socket open for live data, so it routinely never fires.
     */
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 10 && stable < 2; i++) {
      await page.waitForTimeout(600);
      const len = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => last);
      if (len === last) stable++;
      else stable = 0;
      last = len;
    }

    /*
     * One more chance for live-injected numbers.
     *
     * These pages render "—" where a value will go and fill it from their own
     * server. If the text has settled with those placeholders still in place, the
     * socket may simply be slow (kairollm.live's docs showed "reconnecting" during
     * one read), so it is worth a short second wait — and if they never arrive,
     * `extract.ts` refuses to quote the sentence rather than print a fee split
     * with its numbers missing.
     */
    const PLACEHOLDER = /(?::|\band)\s+[—–]\s+[a-z]/;
    for (let i = 0; i < 5; i++) {
      const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (!PLACEHOLDER.test(text)) break;
      await page.waitForTimeout(700);
    }

    const html = await page.content();
    return html;
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => undefined);
  }
}
