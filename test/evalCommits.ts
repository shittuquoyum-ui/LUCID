/**
 * The commits the red-team evaluation runs on, each with its ground truth.
 * Hand-written ones come from the two fixture folders. The generated ones
 * were written by Muse Spark from one-line descriptions (npm run eval --
 * --generate) and are kept in test/fixtures/eval-generated, so a run can be
 * repeated on the same set.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSetupPath, type SetupFile } from '../src/prover/setupFiles';
import { baseFiles, newFileDiff, proverCommit, type CommitLetter } from './proverFixtures';

// On Modal (the run_eval function) the fixtures sit elsewhere than next to this file.
const root = process.env.LUCID_EVAL_FIXTURES ?? join(import.meta.dirname, 'fixtures');
export const GENERATED_DIR = join(root, 'eval-generated');

export interface EvalCommit {
  id: string;
  label: 'risky' | 'safe';
  what: string;
  /** Held out: generated after the prompts and signals were frozen, in shapes they never mention. Never tuned on. */
  source: 'authored' | 'generated' | 'held-out';
  /** A database-rule leak the sandbox can try to reproduce. */
  provable: boolean;
  title: string | null;
  diff: string;
  /** The database setup before and after; null when the fixture has none. */
  setup: { before: SetupFile[]; after: SetupFile[] } | null;
}

const DATABASE: { letter: CommitLetter; id: string; label: EvalCommit['label']; what: string }[] = [
  { letter: 'a', id: 'rls-off', label: 'risky', what: 'row level security turned off' },
  { letter: 'b', id: 'using-true', label: 'risky', what: 'read rule changed to using (true)' },
  { letter: 'c', id: 'owner-check-removed', label: 'risky', what: 'owner check taken out of a rule' },
  { letter: 'f', id: 'hard-f-related-table', label: 'risky', what: 'private data copied to a table any signed-in user can read' },
  { letter: 'g', id: 'hard-g-definer-function', label: 'risky', what: 'security definer function with no caller check' },
  { letter: 'h', id: 'hard-h-insert-wrong-column', label: 'risky', what: 'insert rule checks the wrong column' },
  { letter: 'i', id: 'hard-i-view', label: 'risky', what: 'view that skips row level security' },
  { letter: 'd', id: 'safe-invoices-owner-rules', label: 'safe', what: 'new table with owner-only rules' },
  { letter: 'e', id: 'safe-public-blog', label: 'safe', what: 'genuinely public table' },
  { letter: 'j', id: 'safe-invoker-view', label: 'safe', what: 'view with security_invoker on' },
  { letter: 'k', id: 'safe-checked-function', label: 'safe', what: 'security definer function that checks the caller' },
  { letter: 'l', id: 'safe-versions-owner', label: 'safe', what: 'version history with an owner rule' },
  { letter: 'm', id: 'safe-published-view', label: 'safe', what: 'view of rows marked public only' },
  { letter: 'n', id: 'safe-insert-right-column', label: 'safe', what: 'insert rule that checks the owner' },
];

const DIFFS: { file: string; label: EvalCommit['label']; what: string }[] = [
  { file: 'risky-04-service-role-in-client', label: 'risky', what: 'service role in browser code' },
  { file: 'risky-05-public-env-secret', label: 'risky', what: 'secret in a NEXT_PUBLIC_ setting' },
  { file: 'risky-06-admin-route-no-role', label: 'risky', what: 'admin route without a role check' },
  { file: 'risky-07-delete-without-owner', label: 'risky', what: 'missing owner filter on a delete' },
  { file: 'risky-08-stripe-webhook-unverified', label: 'risky', what: 'unsigned webhook' },
  { file: 'risky-09-bucket-public', label: 'risky', what: 'public storage bucket' },
  { file: 'risky-10-secret-in-browser-code', label: 'risky', what: 'secret typed into browser code' },
  { file: 'safe-01-owner-policy', label: 'safe', what: 'owner policy added' },
  { file: 'safe-02-server-only-key', label: 'safe', what: 'service key on the server only' },
  { file: 'safe-03-webhook-verified', label: 'safe', what: 'verified webhook' },
  { file: 'safe-04-ui-change', label: 'safe', what: 'ordinary UI change' },
  { file: 'safe-05-delete-with-owner', label: 'safe', what: 'delete with an owner filter' },
  { file: 'safe-06-admin-route-with-role', label: 'safe', what: 'admin route with a role check' },
  { file: 'safe-07-policy-recreated', label: 'safe', what: 'rule re-created unchanged' },
  { file: 'safe-08-anon-key-in-client', label: 'safe', what: 'public anon key in the browser' },
];

export interface GeneratedCommit {
  id: string;
  label: EvalCommit['label'];
  provable: boolean;
  what: string;
  /** The description the model was given. */
  description: string;
  heldOut?: boolean;
  model: string;
  title: string;
  files: SetupFile[];
}

const authored = (): EvalCommit[] => [
  ...DATABASE.map(({ letter, id, label, what }) => {
    const c = proverCommit(letter);
    return { id, label, what, source: 'authored' as const, provable: label === 'risky', title: null, diff: c.diff, setup: { before: c.before, after: c.after } };
  }),
  ...DIFFS.map(({ file, label, what }) => ({
    id: file,
    label,
    what,
    source: 'authored' as const,
    provable: false,
    title: null,
    diff: readFileSync(join(root, 'risky-commits', `${file}.diff`), 'utf8'),
    setup: null,
  })),
];

export const generatedCommit = (g: GeneratedCommit): EvalCommit => {
  const base = baseFiles();
  return {
    id: g.id,
    label: g.label,
    what: g.what,
    source: g.heldOut ? 'held-out' : 'generated',
    provable: g.provable,
    title: g.title,
    diff: g.files.map((f) => newFileDiff(f.path, f.text)).join(''),
    setup: g.files.some((f) => isSetupPath(f.path)) ? { before: base, after: [...base, ...g.files.filter((f) => isSetupPath(f.path))] } : null,
  };
};

const generated = (): EvalCommit[] =>
  existsSync(GENERATED_DIR)
    ? readdirSync(GENERATED_DIR)
        .filter((n) => n.endsWith('.json'))
        .sort()
        .map((n) => generatedCommit(JSON.parse(readFileSync(join(GENERATED_DIR, n), 'utf8')) as GeneratedCommit))
    : [];

export const evalCommits = (): EvalCommit[] => [...authored(), ...generated()];
