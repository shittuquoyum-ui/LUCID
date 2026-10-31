/**
 * What Lucid tells the builder when something goes wrong: one plain
 * sentence, never a stack trace. Pure code, so it can be tested directly.
 */

export const MISSING_KEYS = 'Lucid needs API keys to explain your changes.';
export const NO_LESSON = "Lucid couldn't write a lesson it could stand behind for this commit, so it skipped it.";

/** The second toast. It never leaves out where the proof happened: nothing real was touched. */
export const provenToast = (title: string): string => `⚠️ Lucid proved it in a sandbox with fake users: ${title}`;

export interface Problem {
  message: string;
  /** Offer the "Set keys" button with the message. */
  offerKeys: boolean;
}

export const plainReason = (err: unknown): Problem => {
  const e = (err ?? {}) as { name?: string; status?: number; message?: string; code?: string };
  const message = typeof e.message === 'string' ? e.message : '';

  if (e.status === 401 || e.status === 403) {
    return { message: 'A model service rejected your API key. Check your Meta and Baseten keys.', offerKeys: true };
  }
  if (/is not set/.test(message)) return { message: MISSING_KEYS, offerKeys: true };
  if (e.status === 429) return { message: 'The model service is busy right now. Try again in a minute.', offerKeys: false };
  if (typeof e.status === 'number' && e.status >= 500) {
    return { message: 'The model service had a problem on its side. Try again in a minute.', offerKeys: false };
  }
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError' || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(message)) {
    return { message: "Lucid couldn't reach the model service. Check your internet connection.", offerKeys: false };
  }
  if (e.name === 'GitError') return { message: "Lucid couldn't read this commit from git.", offerKeys: false };
  if (/empty answer/.test(message)) return { message: 'The model ran out of room before it finished. Try again.', offerKeys: false };
  return { message: 'Something went wrong while Lucid was reading your change.', offerKeys: false };
};
