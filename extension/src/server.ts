/**
 * Asking the Lucid server for a lesson. The diff is filtered on this machine
 * first; only the filtered diff is sent. Every answer the server can give is
 * turned into either a result or one plain sentence. No editor API here, so
 * it can be tested directly.
 */
import type { Card } from '../../src/engine/card';
import { toUnifiedDiff, parseDiff } from '../../src/engine/diff';
import { filterDiff } from '../../src/engine/filter';
import type { CardKind, LucidReport } from '../../src/engine/lucid';
import { plainReason } from './messages';

export const DEFAULT_SERVER_URL = 'https://shittuquoyum-ui--lucid-server.us-east.modal.run';

export type ServerAnswer =
  | { kind: 'done'; outcome: LucidReport['outcome']; card: Card | null; report: string[] }
  /** Nothing left to send once the diff was filtered (only lockfiles, .env files, binaries...). */
  | { kind: 'nothing-to-send' }
  | { kind: 'problem'; message: string; action: 'sign-in' | null };

/** Filter here, so secrets and .env files never leave the machine. */
export const filteredDiff = (diffText: string): string => toUnifiedDiff(filterDiff(parseDiff(diffText)).files);

export const askServer = async (
  serverUrl: string,
  githubToken: string,
  diffText: string,
  title: string | null,
  fetchImpl: typeof fetch = fetch,
  /** The cards to write: both, or only warnings when lessons are off. */
  kinds: CardKind[] = ['risk', 'lesson'],
): Promise<ServerAnswer> => {
  const diff = filteredDiff(diffText);
  if (!diff) return { kind: 'nothing-to-send' };

  let res: Response;
  try {
    // Lessons can take over a minute; Modal answers long requests with a
    // redirect to the result, which fetch follows.
    res = await fetchImpl(`${serverUrl.replace(/\/+$/, '')}/lesson`, {
      method: 'POST',
      headers: { authorization: `Bearer ${githubToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ diff, title, kinds }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch {
    return { kind: 'problem', message: "Lucid couldn't reach its server. Check your internet connection.", action: null };
  }

  const body = (await res.json().catch(() => ({}))) as {
    outcome?: LucidReport['outcome'];
    card?: Card | null;
    report?: string[];
    error?: string;
    kind?: string;
    status?: number | null;
  };

  if (res.ok && body.outcome) return { kind: 'done', outcome: body.outcome, card: body.card ?? null, report: body.report ?? [] };

  switch (body.error) {
    case 'sign-in-required':
    case 'bad-token':
      return { kind: 'problem', message: 'Lucid needs you to sign in with GitHub again.', action: 'sign-in' };
    case 'user-limit':
      return { kind: 'problem', message: "You've used today's 20 Lucid lessons. More tomorrow.", action: null };
    case 'daily-cap':
      return { kind: 'problem', message: 'Lucid has reached its limit for everyone today. Try again tomorrow.', action: null };
    case 'paused':
      return { kind: 'problem', message: 'Lucid is paused right now. Try again later.', action: null };
    case 'github-unavailable':
      return { kind: 'problem', message: "Lucid couldn't check your GitHub sign-in. Try again in a minute.", action: null };
    case 'too-large':
      return { kind: 'problem', message: 'This commit is too big for Lucid to read.', action: null };
    case 'model-error': {
      const reason = plainReason({ name: body.kind, status: body.status ?? undefined });
      // A key problem here is the server's key, not the builder's: don't offer "Set keys".
      return { kind: 'problem', message: reason.offerKeys ? 'Lucid had a problem on its side. Try again later.' : reason.message, action: null };
    }
    default:
      return { kind: 'problem', message: 'Something went wrong while Lucid was reading your change.', action: null };
  }
};
