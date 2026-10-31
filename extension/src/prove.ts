/**
 * Asking Lucid's server to prove a data-exposure warning. Only the database
 * setup files are sent (migrations, supabase/schemas, schema.sql), as they
 * were before the commit and after it, with secret values masked. Never
 * data, never other code. No editor API here, so it can be tested directly.
 */
import { applyProof, NOT_REPRODUCED_NOTE, type Card, type WarningCard } from '../../src/engine/card';
import type { DiffFile } from '../../src/engine/diff';
import { isSetupPath, prepareSetupFiles, touchedObjects, type SetupFile, type Touched } from '../../src/prover/setupFiles';
import type { ProofResult } from '../../src/prover/result';

export interface ProveRequest {
  before: SetupFile[];
  after: SetupFile[];
  touched: Touched;
}

/** Reads the files of one commit: its paths, and one file's text. */
export interface CommitFiles {
  paths: () => Promise<string[]>;
  read: (path: string) => Promise<string>;
}

const setupOf = async (commit: CommitFiles | null): Promise<SetupFile[] | null> => {
  if (!commit) return [];
  const paths = (await commit.paths()).filter(isSetupPath);
  const files = await Promise.all(paths.map(async (path) => ({ path, text: await commit.read(path) })));
  return prepareSetupFiles(files);
};

/** Only a data-exposure warning is worth a sandbox. The evaluation uses this same check. */
export const wantsProof = (card: Card | null): card is WarningCard => card?.kind === 'risk' && card.category === 'data-exposure';

/** Did this commit change the database setup at all? If not, the sandbox would rebuild the same thing twice. */
export const touchesDatabase = (diff: DiffFile[]): boolean => diff.some((f) => isSetupPath(f.path) || (f.oldPath !== null && isSetupPath(f.oldPath)));

/**
 * What the prover needs for this commit, or null when there is nothing to
 * prove: the commit changed no setup file, there are no setup files, or they
 * are over the 1 MB cap.
 */
export const proveRequest = async (diff: DiffFile[], after: CommitFiles, parent: CommitFiles | null): Promise<ProveRequest | null> => {
  if (!touchesDatabase(diff)) return null;
  const touched = touchedObjects(diff);
  const [beforeFiles, afterFiles] = await Promise.all([setupOf(parent), setupOf(after)]);
  if (!beforeFiles || !afterFiles || afterFiles.length === 0) return null;
  return { before: beforeFiles, after: afterFiles, touched };
};

export type ProveAnswer = { kind: 'done'; result: ProofResult } | { kind: 'problem'; message: string };

const NOT_SAFE = "That doesn't mean it's safe.";

export const askProve = async (serverUrl: string, githubToken: string, request: ProveRequest, fetchImpl: typeof fetch = fetch): Promise<ProveAnswer> => {
  let res: Response;
  try {
    res = await fetchImpl(`${serverUrl.replace(/\/+$/, '')}/prove`, {
      method: 'POST',
      headers: { authorization: `Bearer ${githubToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch {
    return { kind: 'problem', message: NOT_REPRODUCED_NOTE };
  }
  const body = (await res.json().catch(() => ({}))) as { result?: ProofResult; error?: string };
  if (res.ok && body.result) return { kind: 'done', result: body.result };
  const messages: Record<string, string> = {
    'user-limit': `You've used today's 5 Lucid sandbox tests, so this one was not tested. ${NOT_SAFE}`,
    'daily-cap': `Lucid's sandbox has reached its limit for everyone today, so this was not tested. ${NOT_SAFE}`,
    paused: `Lucid's sandbox is paused right now, so this was not tested. ${NOT_SAFE}`,
    'too-large': `Your database setup files are too big for the sandbox (1 MB at most), so this was not tested. ${NOT_SAFE}`,
  };
  return { kind: 'problem', message: messages[body.error ?? ''] ?? NOT_REPRODUCED_NOTE };
};

/**
 * The card once the sandbox test is over. Only a proven result can change
 * its label; an error or a timeout leaves the warning, with the quiet line.
 */
export const cardAfterProof = (card: WarningCard, answer: ProveAnswer): WarningCard =>
  answer.kind === 'done' ? applyProof(card, answer.result) : { ...card, proofNote: answer.message };
