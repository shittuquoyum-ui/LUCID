/**
 * The prover-app fixtures as the extension would send them: BEFORE (the
 * base migrations), AFTER (base plus the commit's new migration) and what
 * the commit touched.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDiff } from '../src/engine/diff';
import { touchedObjects, type SetupFile, type Touched } from '../src/prover/setupFiles';

// On Modal (the prove_fixtures function) the fixtures sit elsewhere than next to this file.
const dir = process.env.LUCID_PROVER_FIXTURES ?? join(import.meta.dirname, 'fixtures', 'prover-app');

export const PROVER_COMMITS = {
  a: { file: 'a-disable-rls-on-notes.sql', expect: 'proven' },
  b: { file: 'b-notes-using-true.sql', expect: 'proven' },
  c: { file: 'c-owner-check-removed.sql', expect: 'proven' },
  d: { file: 'd-invoices-owner-policy.sql', expect: 'not-proven' },
  e: { file: 'e-public-posts.sql', expect: 'not-proven' },
  // Leaks the standard probes cannot reach: only the attacker model can find these.
  f: { file: 'f-note-versions-open.sql', expect: 'proven', needsAgent: true },
  g: { file: 'g-notes-for-user-function.sql', expect: 'proven', needsAgent: true },
  h: { file: 'h-insert-wrong-column.sql', expect: 'proven', needsAgent: true },
  i: { file: 'i-notes-feed-view.sql', expect: 'proven', needsAgent: true },
  // Their safe look-alikes: the same shapes, written properly.
  j: { file: 'j-notes-feed-invoker-view.sql', expect: 'not-proven' },
  k: { file: 'k-notes-for-user-checked.sql', expect: 'not-proven' },
  l: { file: 'l-note-versions-owner.sql', expect: 'not-proven' },
  m: { file: 'm-published-notes-view.sql', expect: 'not-proven' },
  n: { file: 'n-insert-right-column.sql', expect: 'not-proven' },
  // A table closed before the commit, opened on purpose; then one opened with emails and phones in it.
  o: { file: 'o-leaderboard-public.sql', expect: 'not-proven', extra: 'leaderboard.sql' },
  p: { file: 'p-public-profiles-open.sql', expect: 'not-proven', extra: 'public-profiles.sql' },
  q: { file: 'q-profiles-emails-opened.sql', expect: 'proven' },
} as const satisfies Record<string, { file: string; expect: 'proven' | 'not-proven'; needsAgent?: boolean; extra?: string }>;

export type CommitLetter = keyof typeof PROVER_COMMITS;

export const baseFiles = (): SetupFile[] => {
  const migrations = 'supabase/migrations';
  return readdirSync(join(dir, 'base', migrations))
    .sort()
    .map((name) => ({ path: `${migrations}/${name}`, text: readFileSync(join(dir, 'base', migrations, name), 'utf8') }));
};

/** The diff of a commit that adds one file. */
export const newFileDiff = (path: string, text: string): string => {
  const lines = text.replace(/\n$/, '').split('\n');
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');
};

/** The commit adds one migration. Its diff, BEFORE, AFTER and the touched tables. */
export const proverCommit = (letter: CommitLetter): { diff: string; before: SetupFile[]; after: SetupFile[]; touched: Touched } => {
  const commit = PROVER_COMMITS[letter];
  const { file } = commit;
  const text = readFileSync(join(dir, 'commits', file), 'utf8');
  const path = `supabase/migrations/20261030120000_${file.replace(/^\w-/, '').replace(/-/g, '_')}`;
  const diff = newFileDiff(path, text);
  const extra = 'extra' in commit ? [{ path: 'supabase/migrations/20261002000000_extra.sql', text: readFileSync(join(dir, 'extra', commit.extra), 'utf8') }] : [];
  const before = [...baseFiles(), ...extra];
  return { diff, before, after: [...before, { path, text }], touched: touchedObjects(parseDiff(diff)) };
};
