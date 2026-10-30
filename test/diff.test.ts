import { describe, expect, it } from 'vitest';
import { parseDiff, shownLine } from '../src/engine/diff';
import { filterDiff, hasMaskedSecret, HIDDEN_TEXT, looksLikeSecret, maskSecrets } from '../src/engine/filter';
import { LISTING_LEGEND, renderListing, renderVersions } from '../src/engine/listing';
import { RECREATED_RULE_DIFF, RLS_DIFF } from './fixtures';

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

  it('masks secret values but keeps the line and its line number', () => {
    const ts = result.files.find((f) => f.path === 'src/lib/notes.ts')!;
    const masked = ts.lines.find((l) => l.masked)!;
    expect(masked.text).toBe("export const ADMIN_KEY = 'sk-••••';");
    expect(masked.redacted).toBeUndefined();
    expect(masked.oldLine).toBe(9);
    expect(result.redacted).toBe(1);
  });

  it('keeps a known key prefix of 7 characters at most, and nothing of an unknown one', () => {
    const live = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
    expect(maskSecrets(`const stripe = new Stripe('${live}');`)).toBe("const stripe = new Stripe('sk_live••••');");
    expect(maskSecrets('const password = "hunter2hunter2";')).toBe('const password = "••••";');
    expect(maskSecrets('fetch("https://ada:hunter2hunter2@db.example.com")')).toBe('fetch("https://ada:••••@db.example.com")');
    expect(maskSecrets('eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.abcdefghijklmnop')).toBe('eyJ••••');
    // Masking twice changes nothing, so the server's second filter keeps the line as it came.
    expect(maskSecrets("const stripe = new Stripe('sk_live••••');")).toBe("const stripe = new Stripe('sk_live••••');");
  });

  it('tells a masked value from dots the app shows', () => {
    expect(hasMaskedSecret("new Stripe('sk_live••••')")).toBe(true);
    expect(hasMaskedSecret('<input placeholder="••••••••" />')).toBe(false);
  });

  it('still hides a whole private key line', () => {
    const files = filterDiff(parseDiff(['diff --git a/k.ts b/k.ts', '--- a/k.ts', '+++ b/k.ts', '@@ -1,0 +1,1 @@', '+-----BEGIN RSA PRIVATE KEY-----', ''].join('\n'))).files;
    expect(files[0]!.lines[0]).toMatchObject({ text: HIDDEN_TEXT, redacted: true });
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

describe('moved lines', () => {
  const [items, order] = parseDiff(RECREATED_RULE_DIFF);

  it('marks a removed line and its unchanged twin (ignoring spacing) as moved', () => {
    const using = items!.lines.filter((l) => l.text.includes('using (true)'));
    expect(using.map((l) => [l.status, l.oldLine, l.newLine])).toEqual([
      ['moved', 3, null],
      ['moved', null, 5],
    ]);
    const drop = items!.lines.find((l) => l.text.startsWith('drop policy'))!;
    expect(drop.status).toBe('added');
  });

  it('shows moved lines once, at their new spot, as "=" context', () => {
    const text = renderListing(filterDiff([items!]).files);
    expect(text).toContain('= 3 | create policy "anyone can read items"');
    expect(text).toContain('+ 2 | drop policy if exists "anyone can read items" on items;');
    expect(text.match(/anyone can read items"$/gm)).toHaveLength(1);
    expect(LISTING_LEGEND).toContain("'=' = moved");
  });

  it('skips a file whose only changes are moved lines', () => {
    const result = filterDiff([items!, order!]);
    expect(result.files.map((f) => f.path)).toEqual(['supabase/migrations/003_items.sql']);
    expect(result.skipped).toEqual([{ path: 'supabase/migrations/004_order.sql', reason: 'only moved lines' }]);
  });

  it('shows BEFORE and AFTER versions for the fact check', () => {
    const text = renderVersions([items!]);
    const [before, after] = text.split('--- AFTER ---');
    expect(before).toContain('1 | create policy "anyone can read items"');
    expect(before).not.toContain('drop policy');
    expect(after).toContain('2 | drop policy if exists');
    expect(after).toContain('5 |     using (true);');
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
