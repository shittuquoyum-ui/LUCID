/**
 * Asking Lucid's server to prove a data-exposure warning. Only the database
 * setup files are sent (migrations, supabase/schemas, schema.sql), as they
 * were before the commit and after it, with secret values masked. Never
 * data, never other code. No editor API here, so it can be tested directly.
 */
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

/**
 * What the prover needs for this commit, or null when there is nothing to
 * prove with (no setup files) or they are over the 1 MB cap.
 */
export const proveRequest = async (diff: DiffFile[], after: CommitFiles, parent: CommitFiles | null): Promise<ProveRequest | null> => {
  const touched = touchedObjects(diff);
  const [beforeFiles, afterFiles] = await Promise.all([setupOf(parent), setupOf(after)]);
  if (!beforeFiles || !afterFiles || afterFiles.length === 0) return null;
  return { before: beforeFiles, after: afterFiles, touched };
};

export type ProveAnswer = { kind: 'done'; result: ProofResult } | { kind: 'problem'; message: string };

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
    return { kind: 'problem', message: "Lucid couldn't reach its server to test this warning." };
  }
  const body = (await res.json().catch(() => ({}))) as { result?: ProofResult; error?: string };
  if (res.ok && body.result) return { kind: 'done', result: body.result };
  const messages: Record<string, string> = {
    'user-limit': "You've used today's 5 Lucid sandbox tests. More tomorrow.",
    'daily-cap': "Lucid's sandbox has reached its limit for everyone today.",
    paused: "Lucid's sandbox is paused right now.",
    'too-large': 'Your database setup files are too big for the sandbox (1 MB at most).',
  };
  return { kind: 'problem', message: messages[body.error ?? ''] ?? "Lucid couldn't test this warning in its sandbox." };
};
