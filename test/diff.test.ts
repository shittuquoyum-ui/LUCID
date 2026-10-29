import { describe, expect, it } from 'vitest';
import { parseDiff, shownLine } from '../src/engine/diff';
import { filterDiff, looksLikeSecret } from '../src/engine/filter';
import { renderListing } from '../src/engine/listing';
import { RLS_DIFF } from './fixtures';

describe('parseDiff', () => {
  const files = parseDiff(RLS_DIFF);
  const byPath = (p: string) => files.find((f) => f.path === p)!;

  it('finds every file, including new, binary and dotfiles', () => {
    expect(files.map((f) => f.path)).toEqual([
      'supabase/migrations/002_notes_rls.sql',
      'src/lib/notes.ts',
      'package-lock.json',
      '.env.local',
      'public/logo.png',
    ]);
    expect(byPath('supabase/migrations/002_notes_rls.sql').isNew).toBe(true);
    expect(byPath('public/logo.png').isBinary).toBe(true);
  });

  it('numbers added lines in the new file', () => {
    const sql = byPath('supabase/migrations/002_notes_rls.sql');
    const policy = sql.lines.find((l) => l.text.includes('auth.uid()'))!;
    expect(policy).toMatchObject({ status: 'added', newLine: 5, oldLine: null });
  });

  it('numbers removed lines in the OLD file and context in both', () => {
    const ts = byPath('src/lib/notes.ts');
    const todo = ts.lines.find((l) => l.text.includes('TODO'))!;
    expect(todo).toMatchObject({ status: 'removed', oldLine: 4, newLine: null });
    expect(shownLine(todo)).toBe(4);

    const ret = ts.lines.find((l) => l.text.includes('return data'))!;
    expect(ret).toMatchObject({ status: 'unchanged', oldLine: 6, newLine: 6 });

    const pageSize = ts.lines.find((l) => l.text.includes('PAGE_SIZE'))!;
    expect(pageSize).toMatchObject({ status: 'added', newLine: 8 });
  });

  it('treats lines that start with --- inside a hunk as content', () => {
    const diff = ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,2 +1,2 @@', ' title', '--- old rule', '+--- new rule'].join('\n');
    const [file] = parseDiff(diff);
    expect(file!.lines.map((l) => l.status)).toEqual(['unchanged', 'removed', 'added']);
    expect(file!.lines[1]!.text).toBe('-- old rule');
  });
});

describe('filterDiff', () => {
  const result = filterDiff(parseDiff(RLS_DIFF));

  it('never sends .env files, lockfiles or binaries', () => {
    const sent = result.files.map((f) => f.path);
    expect(sent).not.toContain('.env.local');
    expect(sent).not.toContain('package-lock.json');
    expect(sent).not.toContain('public/logo.png');
    expect(result.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining(['may contain secrets', 'lockfile', 'binary or media file']),
    );
  });

  it('hides secret-looking lines but keeps their line numbers', () => {
    const ts = result.files.find((f) => f.path === 'src/lib/notes.ts')!;
    const hidden = ts.lines.find((l) => l.redacted)!;
    expect(hidden.text).not.toContain('sk-live');
    expect(hidden.oldLine).toBe(9);
    expect(result.redacted).toBe(1);
  });

  it('spots common key formats', () => {
    expect(looksLikeSecret("const k = 'sk-ant-api03-abcdefghijklmnopqrst'")).toBe(true);
    expect(looksLikeSecret('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(true);
    expect(looksLikeSecret('password: "hunter2hunter2"')).toBe(true);
    expect(looksLikeSecret('const PAGE_SIZE = 20;')).toBe(false);
  });

  it('keeps only the files that changed the most', () => {
    const many = parseDiff(RLS_DIFF);
    const one = filterDiff(many, { maxFiles: 1 });
    expect(one.files).toHaveLength(1);
    // notes.ts changed 7 lines (4 removed, 3 added); the SQL file added 6.
    expect(one.files[0]!.path).toBe('src/lib/notes.ts');
  });
});

describe('renderListing', () => {
  it('shows marker, line number and code for every line', () => {
    const { files } = filterDiff(parseDiff(RLS_DIFF));
    const text = renderListing(files);
    expect(text).toContain('=== FILE: supabase/migrations/002_notes_rls.sql (new file) ===');
    expect(text).toContain('+ 5 |   using (auth.uid() = user_id);');
    expect(text).toContain('- 4 |   // TODO: only show the signed-in user\'s notes');
    expect(text).not.toContain('sk-live');
  });
});
