import { describe, expect, it } from 'vitest';
import { parseDiff, type DiffSource } from '../src/engine/diff';
import { filterDiff } from '../src/engine/filter';
import { checkEvidence, checkQuotes, locate } from '../src/engine/quoteCheck';
import { gradeReply, readAnswer } from '../src/engine/quickCheck';
import type { Quote } from '../src/engine/schemas';
import { RLS_DIFF } from './fixtures';

const { files } = filterDiff(parseDiff(RLS_DIFF));
const source: DiffSource = { owner: 'me', repo: 'notes', headSha: 'head123', baseSha: 'base456' };

const quote = (over: Partial<Quote>): Quote => ({
  file: 'supabase/migrations/002_notes_rls.sql',
  line: 5,
  role: 'shows',
  code: 'using (auth.uid() = user_id);',
  note: 'only the owner matches',
  ...over,
});

describe('locate', () => {
  it('finds an added line and reports its real number', () => {
    const r = locate(files, 'supabase/migrations/002_notes_rls.sql', 'using (auth.uid() = user_id);', 5, 'shows');
    expect(r.ok && r.match.start).toBe(5);
  });

  it('ignores indentation and spacing differences', () => {
    const r = locate(files, 'supabase/migrations/002_notes_rls.sql', '   using   (auth.uid() = user_id);', 5, 'shows');
    expect(r.ok).toBe(true);
  });

  it('matches multi-line quotes only when the lines are consecutive', () => {
    const ok = locate(files, 'supabase/migrations/002_notes_rls.sql', 'on notes for select\nusing (auth.uid() = user_id);', 4, 'shows');
    expect(ok.ok && [ok.match.start, ok.match.end]).toEqual([4, 5]);
    const gap = locate(files, 'supabase/migrations/002_notes_rls.sql', 'alter table notes enable row level security;\nusing (auth.uid() = user_id);', 1, 'shows');
    expect(gap.ok).toBe(false);
  });

  it('corrects a wrong line number instead of failing', () => {
    const r = locate(files, 'supabase/migrations/002_notes_rls.sql', 'using (auth.uid() = user_id);', 40, 'shows');
    expect(r.ok && r.match).toMatchObject({ start: 5, lineCorrected: true });
  });

  it('accepts a shortened path when it points at one file', () => {
    expect(locate(files, 'notes.ts', 'if (error) throw error;', 5, 'shows').ok).toBe(true);
  });

  it('never lets a removed line prove how the app works now', () => {
    const r = locate(files, 'src/lib/notes.ts', "// TODO: only show the signed-in user's notes", 4, 'shows');
    expect(r).toEqual({ ok: false, reason: 'the quote uses removed lines to describe how the app works now' });
  });

  it('lets removed lines describe what was taken away', () => {
    const r = locate(files, 'src/lib/notes.ts', "// TODO: only show the signed-in user's notes", 4, 'removed');
    expect(r.ok && r.match.start).toBe(4);
  });

  it('rejects a removed-role quote that uses current lines', () => {
    expect(locate(files, 'src/lib/notes.ts', 'if (error) throw error;', 5, 'removed').ok).toBe(false);
  });

  it('rejects code that is not in the diff at all', () => {
    const r = locate(files, 'src/lib/notes.ts', 'await supabase.auth.signOut();', 3, 'shows');
    expect(r.ok).toBe(false);
  });

  it('never quotes a line hidden as a secret', () => {
    expect(locate(files, 'src/lib/notes.ts', "export const ADMIN_KEY = 'sk-live-abcdefghijklmnopqrstuvwx';", 9, 'removed').ok).toBe(false);
  });

  it('strips a copied listing prefix', () => {
    expect(locate(files, 'src/lib/notes.ts', '+ 5 | if (error) throw error;', 5, 'shows').ok).toBe(true);
  });
});

describe('checkQuotes', () => {
  it('keeps good quotes, drops bad ones, and links each to its exact lines', () => {
    const { verified, failed } = checkQuotes(
      [
        quote({}),
        quote({ file: 'src/lib/notes.ts', line: 4, role: 'removed', code: "// TODO: only show the signed-in user's notes" }),
        quote({ file: 'src/lib/notes.ts', line: 2, code: 'made up line that is not there' }),
      ],
      files,
      source,
    );
    expect(verified).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect(verified[0]!.link).toBe('https://github.com/me/notes/blob/head123/supabase/migrations/002_notes_rls.sql#L5');
    // Removed lines link to the OLD version of the file.
    expect(verified[1]!.link).toBe('https://github.com/me/notes/blob/base456/src/lib/notes.ts#L4');
  });

  it('shows the real code from the diff, not the model’s retyping', () => {
    const { verified } = checkQuotes([quote({ code: 'using   (auth.uid() = user_id);' })], files, source);
    expect(verified[0]!.code).toBe('  using (auth.uid() = user_id);');
  });

  it('has no links for a local diff', () => {
    const { verified } = checkQuotes([quote({})], files, null);
    expect(verified[0]!.link).toBeNull();
  });
});

describe('checkEvidence', () => {
  it('uses the evidence status to pick the rule', () => {
    const failed = checkEvidence(
      [
        { file: 'src/lib/notes.ts', line: 4, status: 'removed', code: "// TODO: only show the signed-in user's notes" },
        { file: 'src/lib/notes.ts', line: 4, status: 'added', code: "// TODO: only show the signed-in user's notes" },
      ],
      files,
    );
    expect(failed).toHaveLength(1);
  });
});

describe('quick check', () => {
  it.each([
    ['B', 'B'],
    ['b)', 'B'],
    ['(c)', 'C'],
    ['Answer: a', 'A'],
    ['my answer is b', 'B'],
    ['/lucid C', 'C'],
    ['A. because the policy filters rows', 'A'],
  ])('reads %s as %s', (reply, letter) => {
    expect(readAnswer(reply)).toBe(letter);
  });

  it.each(['I think it is a good question', 'not sure', 'D'])('treats "%s" as unclear', (reply) => {
    expect(readAnswer(reply)).toBeNull();
  });

  it('grades against the answer key', () => {
    expect(gradeReply('B', 'B')).toEqual({ status: 'correct', letter: 'B' });
    expect(gradeReply('c', 'B')).toEqual({ status: 'wrong', letter: 'C' });
    expect(gradeReply('hmm', 'B')).toEqual({ status: 'unclear' });
  });
});
