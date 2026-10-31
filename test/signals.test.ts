import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/engine/diff';
import { filterDiff } from '../src/engine/filter';
import { findSignals, recreatedPolicies, runsInBrowser, tightenedNote, tightenedRules, type SignalId } from '../src/engine/signals';
import { proverCommit, type CommitLetter } from './proverFixtures';

const dir = join(import.meta.dirname, 'fixtures', 'risky-commits');
const signalsIn = (diff: string) => findSignals(filterDiff(parseDiff(diff)).files);
const fixture = (name: string) => readFileSync(join(dir, name), 'utf8');

/** A diff that adds a whole new file. */
const newFile = (path: string, lines: string[]) =>
  [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');

/** A diff that changes lines in an existing file: [' ' | '-' | '+', text][]. */
const edit = (path: string, lines: [' ' | '-' | '+', string][]) => {
  const old = lines.filter(([m]) => m !== '+').length;
  const now = lines.filter(([m]) => m !== '-').length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${old} +1,${now} @@`, ...lines.map(([m, t]) => `${m}${t}`), ''].join('\n');
};

const RISKY: Record<string, SignalId> = {
  'risky-01-rls-disabled.diff': 'rls-disabled',
  'risky-02-policy-using-true.diff': 'policy-allows-all',
  'risky-03-owner-check-removed.diff': 'owner-check-removed',
  'risky-04-service-role-in-client.diff': 'service-role-in-browser-code',
  'risky-05-public-env-secret.diff': 'public-env-secret',
  'risky-06-admin-route-no-role.diff': 'admin-without-role-check',
  'risky-07-delete-without-owner.diff': 'write-without-owner-filter',
  'risky-08-stripe-webhook-unverified.diff': 'webhook-without-signature-check',
  'risky-09-bucket-public.diff': 'bucket-made-public',
  'risky-10-secret-in-browser-code.diff': 'secret-in-browser-code',
};

describe('risk signals on the fixture commits', () => {
  const names = readdirSync(dir).filter((n) => n.endsWith('.diff'));

  it('has at least 8 risky and 6 safe fixtures, all known to this test', () => {
    expect(names.filter((n) => n.startsWith('risky-')).length).toBeGreaterThanOrEqual(8);
    expect(names.filter((n) => n.startsWith('safe-')).length).toBeGreaterThanOrEqual(6);
    for (const n of names.filter((n) => n.startsWith('risky-'))) expect(RISKY[n], n).toBeDefined();
  });

  for (const [name, id] of Object.entries(RISKY)) {
    it(`fires ${id} on ${name}`, () => {
      expect(signalsIn(fixture(name)).map((s) => s.id)).toContain(id);
    });
  }

  for (const name of names.filter((n) => n.startsWith('safe-'))) {
    it(`stays quiet on ${name}`, () => {
      expect(signalsIn(fixture(name))).toEqual([]);
    });
  }

  it('points at the exact line, with its status', () => {
    const [s] = signalsIn(fixture('risky-01-rls-disabled.diff'));
    expect(s).toMatchObject({ category: 'data-exposure', file: 'supabase/migrations/20261030090000_profiles_open.sql', line: 2, status: 'added' });
    const removed = signalsIn(fixture('risky-03-owner-check-removed.diff')).find((x) => x.id === 'owner-check-removed')!;
    expect(removed).toMatchObject({ line: 12, status: 'removed', code: 'using (auth.uid() = user_id)' });
  });

  it('puts data exposure first', () => {
    const ids = signalsIn(fixture('risky-08-stripe-webhook-unverified.diff')).map((s) => s.category);
    expect(ids).toEqual([...ids].sort((a, b) => ['data-exposure', 'secrets', 'auth', 'ownership', 'payments', 'other'].indexOf(a) - ['data-exposure', 'secrets', 'auth', 'ownership', 'payments', 'other'].indexOf(b)));
  });
});

describe('risk signals on the leaks the standard probes cannot reach', () => {
  const idsIn = (letter: CommitLetter) => signalsIn(proverCommit(letter).diff).map((s) => s.id);

  it('fires on each hard fixture', () => {
    expect(idsIn('f')).toContain('policy-allows-all');
    expect(idsIn('g')).toContain('definer-without-caller-check');
    expect(idsIn('h')).toContain('insert-without-owner-check');
    expect(idsIn('i')).toContain('view-skips-rules');
  });

  it('stays quiet on their safe look-alikes', () => {
    for (const letter of ['j', 'k', 'l'] as const) expect(idsIn(letter), letter).toEqual([]);
  });

  it('leaves a view of public rows, or a rule replaced under a new name, to the picker: hints, not verdicts', () => {
    expect(idsIn('m')).toEqual(['view-skips-rules']);
    expect(idsIn('n')).toEqual(['policy-dropped']);
  });

  it('does not take a trigger function for a function anyone can call', () => {
    expect(idsIn('l')).not.toContain('definer-without-caller-check');
  });

  it('points at the statement, not a comment above it', () => {
    expect(signalsIn(proverCommit('i').diff)[0]).toMatchObject({ line: 2, code: 'create view public.notes_feed as' });
  });

  const policy = (lines: string[]) => signalsIn(newFile('supabase/migrations/1.sql', lines)).map((s) => s.id);

  it('accepts the owner check in the forms people write it', () => {
    expect(policy(['create policy "a" on public.notes for insert with check (auth.uid() = owner_id);'])).toEqual([]);
    expect(policy(['create policy "a" on public.notes for insert with check (user_id = auth.uid());'])).toEqual([]);
    expect(policy(['create policy "a" on public.notes for insert with check (owner_id = (select auth.uid()));'])).toEqual([]);
    expect(policy(['create policy "a" on public.notes for insert with check ((auth.uid()) = created_by);'])).toEqual([]);
  });

  it('accepts `auth.uid() = id` where the row is the person, and nowhere else', () => {
    expect(policy(['create policy "a" on public.profiles for insert with check (auth.uid() = id);'])).toEqual([]);
    expect(policy(['create policy "a" on public.notes for insert with check (auth.uid() = id);'])).toEqual(['insert-without-owner-check']);
    expect(policy(['create policy "a" on public.notes for insert with check (auth.role() = \'authenticated\');'])).toEqual(['insert-without-owner-check']);
  });
});

describe('a rule the change narrows, with both versions in the diff', () => {
  const inPlace = edit('supabase/schema.sql', [
    [' ', 'create policy "read items"'],
    [' ', '  on public.items for select'],
    ['-', '  using (true);'],
    ['+', '  using (auth.uid() = owner_id);'],
  ]);
  const files = (diff: string) => filterDiff(parseDiff(diff)).files;

  it('finds it when the old line is removed and the new one added, on the same table', () => {
    expect(tightenedRules(files(inPlace))).toEqual([{ table: 'items', before: 'using (true);', after: 'using (auth.uid() = owner_id);' }]);
    expect(tightenedNote(files(inPlace))).toContain('RULE TIGHTENED: on items, the removed line `using (true);` let every row through');
  });

  it('claims nothing when the old rule is not in the diff, like a new migration that drops it by name', () => {
    const newMigration = newFile('supabase/migrations/2.sql', ['drop policy if exists select_all_policy on public.private_items;', 'create policy "owners read their private items"', '  on public.private_items for select', '  using (auth.uid() = owner_id);']);
    expect(tightenedRules(files(newMigration))).toEqual([]);
    expect(tightenedNote(files(newMigration))).toBeNull();
  });

  it('claims nothing across two different tables', () => {
    const two = edit('supabase/schema.sql', [
      [' ', 'create policy "read items" on public.items for select'],
      ['-', '  using (true);'],
      [' ', 'create policy "read notes" on public.notes for select'],
      ['+', '  using (auth.uid() = owner_id);'],
    ]);
    expect(tightenedRules(files(two))).toEqual([]);
  });

  it('claims nothing when a rule is opened, the other way round', () => {
    const opened = edit('supabase/schema.sql', [
      [' ', 'create policy "read items" on public.items for select'],
      ['-', '  using (auth.uid() = owner_id);'],
      ['+', '  using (true);'],
    ]);
    expect(tightenedRules(files(opened))).toEqual([]);
  });
});

describe('risk signals on small diffs', () => {
  const ids = (diff: string) => signalsIn(diff).map((s) => s.id);

  it('flags a removed sign-in check, but not one swapped for another check', () => {
    const removed = edit('src/app/dashboard/page.tsx', [[' ', 'export default async function Page() {'], ['-', '  const user = await getUser();'], ['-', "  if (!user) redirect('/login');"], [' ', '  return <Dashboard />;']]);
    expect(ids(removed)).toContain('auth-check-removed');
    const swapped = edit('src/app/dashboard/page.tsx', [['-', '  const user = await getUser();'], ['+', '  const session = await getSession();'], ['-', "  if (!user) redirect('/login');"], ['+', "  if (!session) redirect('/login');"]]);
    expect(ids(swapped)).not.toContain('auth-check-removed');
  });

  it('points at a masked secret in browser code, never showing it', () => {
    const [s] = signalsIn(fixture('risky-10-secret-in-browser-code.diff'));
    expect(s).toMatchObject({ id: 'secret-in-browser-code', line: 5, code: "const stripe = new Stripe('sk_live••••');" });
  });

  it('finds rules dropped and created again, unless the old rule is shown', () => {
    expect(recreatedPolicies(filterDiff(parseDiff(fixture('safe-07-policy-recreated.diff'))).files)).toEqual(['owners read their notes']);
    expect(recreatedPolicies(filterDiff(parseDiff(fixture('risky-02-policy-using-true.diff'))).files)).toEqual([]);
    const shown = edit('supabase/migrations/1_notes.sql', [
      ['-', 'create policy "read notes" on notes for select using (auth.uid() = user_id);'],
      ['+', 'drop policy if exists "read notes" on notes;'],
      ['+', 'create policy "read notes" on notes for select using (true);'],
    ]);
    expect(recreatedPolicies(filterDiff(parseDiff(shown)).files)).toEqual([]);
  });

  it('flags a secret in browser code, not in server code', () => {
    const key = "const stripeKey = 'sk_live_abcdefghijklmnopqrstuv';";
    expect(ids(newFile('src/components/Pay.tsx', [key]))).toContain('secret-in-browser-code');
    expect(ids(newFile('src/app/api/pay/route.ts', [key]))).not.toContain('secret-in-browser-code');
  });

  it('flags any-origin CORS, not a named origin', () => {
    expect(ids(newFile('src/app/api/data/route.ts', ["  headers: { 'Access-Control-Allow-Origin': '*' },"]))).toContain('cors-any-origin');
    expect(ids(newFile('src/app/api/data/route.ts', ["  headers: { 'Access-Control-Allow-Origin': 'https://myapp.com' },"]))).toEqual([]);
  });

  it('flags a dropped table and a delete with no condition, not a delete with one', () => {
    expect(ids(newFile('supabase/migrations/1_cleanup.sql', ['drop table public.old_orders;']))).toContain('table-dropped');
    expect(ids(newFile('supabase/migrations/2_cleanup.sql', ['delete from public.sessions;']))).toContain('delete-all');
    expect(ids(newFile('supabase/migrations/3_cleanup.sql', ["delete from public.sessions where expires_at < now();"]))).toEqual([]);
  });

  it('flags a price taken from the request, not one looked up on the server', () => {
    expect(ids(newFile('src/app/api/checkout/route.ts', ['  unit_amount: body.price,']))).toContain('amount-from-request');
    expect(ids(newFile('src/app/api/checkout/route.ts', ['  unit_amount: product.price,']))).toEqual([]);
  });

  it('flags an update with no owner filter, not one with it', () => {
    expect(ids(newFile('src/app/profile/actions.ts', ["'use server';", "  await supabase.from('profiles').update({ name }).eq('id', id);"]))).toContain('write-without-owner-filter');
    expect(ids(newFile('src/app/profile/actions.ts', ["'use server';", "  await supabase.from('profiles').update({ name }).eq('user_id', user.id);"]))).toEqual([]);
  });

  it('flags a removed policy that is not created again', () => {
    expect(ids(edit('supabase/migrations/1_notes.sql', [['-', 'create policy "owners read notes" on notes for select'], ['-', '  using (auth.uid() = user_id);']]))).toContain('policy-dropped');
  });

  it('knows which files run in the browser', () => {
    const file = (path: string, lines: string[]) => parseDiff(newFile(path, lines))[0]!;
    expect(runsInBrowser(file('src/components/Button.tsx', ['export const B = 1;']))).toBe(true);
    expect(runsInBrowser(file('src/lib/util.ts', ["'use client';"]))).toBe(true);
    expect(runsInBrowser(file('src/app/actions.tsx', ["'use server';"]))).toBe(false);
    expect(runsInBrowser(file('src/app/api/x/route.ts', ['export const GET = 1;']))).toBe(false);
    expect(runsInBrowser(file('src/lib/db.ts', ['export const db = 1;']))).toBe(false);
  });
});
