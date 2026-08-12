// Shared definition of the "new quote asset" launch window.
//
// When a launchpad adds a new pairing asset, the interesting period is not just
// the inaugural launch — it's the burst of tokens that follow while the pair is
// novel. Every platform we watch (StonkFun on Solana; Long, Pons, Flap and
// pools.trade on Robinhood Chain; Flap and Four.meme on BNB Chain) therefore
// reports EVERY token launched against a newly-added quote for a fixed window,
// not only the first.
//
// Keeping the constant here means a new platform inherits the same behaviour by
// importing it, rather than each watcher inventing its own timings.

/** How long a newly-added quote asset stays watched for new launches. */
export const LAUNCH_WINDOW_MS = 36 * 60 * 60 * 1000;

/**
 * Safety valve: stop reporting after this many launches against a single quote.
 *
 * A popular new pair on a fast chain can attract dozens of launches in 36 hours,
 * and past a certain point the feed stops being signal. The cap is high enough
 * that a normal window is unaffected and only a runaway one is truncated — when
 * it trips, the watcher says so rather than going quiet unexplained.
 */
export const MAX_LAUNCHES_PER_WINDOW = 25;

/** Human label for the window, used in alert copy. */
export const LAUNCH_WINDOW_LABEL = "36h";

/** A quote asset being watched for launches, shared shape across platforms. */
export interface QuoteWatch {
  /** ISO/ms timestamp the watch opened */
  openedAt: number;
  /** how many launches have been reported so far */
  launchCount: number;
}

export function isWindowOpen(w: { openedAt: number }, now = Date.now()): boolean {
  return now - w.openedAt <= LAUNCH_WINDOW_MS;
}

/** Ordinal used in alert copy: "1st", "2nd", "3rd", "11th"… */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
