import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/engine/diff';
import { filterDiff } from '../src/engine/filter';
import { findSignals, runsInBrowser, type SignalId } from '../src/engine/signals';

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

describe('risk signals on small diffs', () => {
  const ids = (diff: string) => signalsIn(diff).map((s) => s.id);

  it('flags a removed sign-in check, but not one swapped for another check', () => {
    const removed = edit('src/app/dashboard/page.tsx', [[' ', 'export default async function Page() {'], ['-', '  const user = await getUser();'], ['-', "  if (!user) redirect('/login');"], [' ', '  return <Dashboard />;']]);
    expect(ids(removed)).toContain('auth-check-removed');
    const swapped = edit('src/app/dashboard/page.tsx', [['-', '  const user = await getUser();'], ['+', '  const session = await getSession();'], ['-', "  if (!user) redirect('/login');"], ['+', "  if (!session) redirect('/login');"]]);
    expect(ids(swapped)).not.toContain('auth-check-removed');
  });

  it('flags a hidden secret in browser code, not in server code', () => {
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
