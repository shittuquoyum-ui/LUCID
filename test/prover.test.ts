import { beforeEach, describe, expect, it, vi } from 'vitest';

// Script the model's answers (the judge, the attacker) so nothing calls an API.
const answers: string[] = [];
vi.mock('../src/engine/model', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/engine/model')>();
  return {
    ...real,
    callModel: vi.fn(async () => {
      const next = answers.shift();
      if (next === undefined) throw new Error('no scripted answer left');
      return next;
    }),
  };
});

const { checkAttackSql, prepareSetupSql, stripMetaCommands } = await import('../src/prover/sqlSafety');
const { isSetupPath, orderSetupFiles, prepareSetupFiles, SETUP_MAX_BYTES, touchedObjects } = await import('../src/prover/setupFiles');
const { attack, canaryRowsIn, changesBetween, tableOfCanary } = await import('../src/prover/attack');
const { downgrade, judgePrivacy } = await import('../src/prover/judge');
const { ownerColumn, seedSql, seedTargets } = await import('../src/prover/schema');
const { PROOF_STATEMENT } = await import('../src/prover/result');
const { applyProof, NOT_REPRODUCED_NOTE, proofSentence } = await import('../src/engine/card');
const { renderCardHtml } = await import('../src/ui/cardHtml');
const { handleProve } = await import('../src/server/handler');
const { DailyLimits } = await import('../src/server/limits');
const { proveRequest } = await import('../extension/src/prove');
const { parseDiff } = await import('../src/engine/diff');
const { PROVER_COMMITS, proverCommit } = await import('./proverFixtures');

import type { ProofResult } from '../src/prover/result';
import type { Sandbox } from '../src/prover/sandbox';
import type { TableInfo } from '../src/prover/schema';
import type { WarningCard } from '../src/engine/card';

beforeEach(() => {
  answers.length = 0;
});

const users = { alice: '00000000-0000-4000-8000-0000000a11ce', bob: '00000000-0000-4000-8000-000000000b0b', canary: 'CANARY-ALICE-TEST01' };

const notes: TableInfo = {
  name: 'notes',
  rls: true,
  columns: [
    { name: 'id', type: 'uuid', notNull: true, hasDefault: true, enum: null },
    { name: 'owner_id', type: 'uuid', notNull: true, hasDefault: false, enum: null },
    { name: 'title', type: 'text', notNull: true, hasDefault: false, enum: null },
    { name: 'created_at', type: 'timestamp with time zone', notNull: true, hasDefault: true, enum: null },
  ],
  fks: [{ column: 'owner_id', refTable: 'auth.users', refColumn: 'id' }],
  policies: [{ name: 'owners read their notes', command: 'SELECT', roles: ['public'], using: '(auth.uid() = owner_id)', withCheck: null }],
};

describe('what SQL may run', () => {
  it('refuses files, programs, other servers and changing identity in the attacker’s SQL', () => {
    for (const sql of [
      "copy (select 1) to program 'curl x'",
      "copy notes to '/tmp/x'",
      "select dblink('host=x', 'select 1')",
      "select net.http_post('https://x')",
      "select pg_read_file('/etc/passwd')",
      "select set_config('request.jwt.claims', '{}', false)",
      'set role postgres',
      'reset role',
      'select 1; set session authorization postgres',
      "do $$ begin perform 1; end $$",
      'create table x (a int)',
      'drop table notes',
      'grant all on notes to anon',
      '\\! ls',
    ]) {
      expect(checkAttackSql(sql), sql).toMatch(/^refused: /);
    }
  });

  it('lets reads and writes through, including UPDATE … SET', () => {
    expect(checkAttackSql("select * from public.notes where owner_id = 'x'")).toBeNull();
    expect(checkAttackSql("update public.notes set title = 'x' where owner_id = 'y'")).toBeNull();
    expect(checkAttackSql("delete from public.notes where owner_id = 'y'")).toBeNull();
  });

  it('strips psql commands and unlisted extensions from setup files, and refuses file access', () => {
    expect(stripMetaCommands('select 1;\n\\i other.sql\n\\copy x from y')).toBe('select 1;\n-- (psql command removed by Lucid)\n-- (psql command removed by Lucid)');
    const prepared = prepareSetupSql('create extension if not exists pg_net;\ncreate extension if not exists "uuid-ossp" with schema extensions;\ncreate table t (a int);');
    expect(prepared).toMatchObject({ skippedExtensions: ['pg_net'] });
    expect('sql' in prepared && prepared.sql).toContain('create extension if not exists "uuid-ossp" with schema extensions;');
    expect(prepareSetupSql("copy t from program 'cat /etc/passwd';")).toMatchObject({ refused: true });
  });
});

describe('the files that go to the prover', () => {
  it('are only database setup files, never seeds or other code', () => {
    expect(isSetupPath('supabase/migrations/20261001_init.sql')).toBe(true);
    expect(isSetupPath('supabase/schemas/notes.sql')).toBe(true);
    expect(isSetupPath('db/migrations/001.sql')).toBe(true);
    expect(isSetupPath('schema.sql')).toBe(true);
    expect(isSetupPath('supabase/seed.sql')).toBe(false);
    expect(isSetupPath('supabase/migrations/seed_users.sql')).toBe(false);
    expect(isSetupPath('src/app/page.tsx')).toBe(false);
    expect(isSetupPath('.env')).toBe(false);
  });

  it('come in build order, mask secret values, and stop at 1 MB', () => {
    const files = [
      { path: 'supabase/migrations/2_b.sql', text: 'select 2;' },
      { path: 'supabase/migrations/1_a.sql', text: `alter role x password 'hunter2hunter2';\nselect 'sk-${'a'.repeat(20)}';` },
      { path: 'supabase/schemas/x.sql', text: 'select 3;' },
      { path: 'src/index.ts', text: 'x' },
    ];
    const ready = prepareSetupFiles(files)!;
    expect(ready.map((f) => f.path)).toEqual(['supabase/migrations/1_a.sql', 'supabase/migrations/2_b.sql']);
    expect(ready[0]!.text).toContain("select 'sk-••••';");
    expect(orderSetupFiles([{ path: 'supabase/schemas/x.sql', text: '' }, { path: 'schema.sql', text: '' }]).map((f) => f.path)).toEqual(['supabase/schemas/x.sql']);
    expect(prepareSetupFiles([{ path: 'schema.sql', text: 'x'.repeat(SETUP_MAX_BYTES + 1) }])).toBeNull();
  });

  it('names the tables and policies each fixture commit touched', () => {
    expect(proverCommit('a').touched).toEqual({ tables: ['notes'], policies: [], views: [], functions: [] });
    expect(proverCommit('b').touched).toEqual({ tables: ['notes'], policies: ['owners read their notes', 'anyone can read notes'], views: [], functions: [] });
    expect(proverCommit('d').touched.tables).toEqual(['invoices']);
    expect(touchedObjects(parseDiff(proverCommit('e').diff)).tables).toEqual(['posts']);
    expect(proverCommit('g').touched).toEqual({ tables: [], policies: [], views: [], functions: ['notes_for_user'] });
    expect(proverCommit('i').touched).toEqual({ tables: [], policies: [], views: ['notes_feed'], functions: [] });
    expect(proverCommit('f').touched.tables).toEqual(['public.notes', 'note_versions'].map((t) => t.replace('public.', '')));
  });

  it('come from the commit and its parent in the extension, setup files only', async () => {
    const commit = (files: Record<string, string>) => ({ paths: async () => Object.keys(files), read: async (p: string) => files[p]! });
    const after = commit({ 'supabase/migrations/1.sql': 'create table a();', 'supabase/migrations/2.sql': 'alter table a disable row level security;', 'src/app.ts': 'x', 'supabase/seed.sql': "insert into a values ('real data');" });
    const before = commit({ 'supabase/migrations/1.sql': 'create table a();', 'src/app.ts': 'x' });
    const request = (await proveRequest(parseDiff(proverCommit('a').diff), after, before))!;
    expect(request.after.map((f) => f.path)).toEqual(['supabase/migrations/1.sql', 'supabase/migrations/2.sql']);
    expect(request.before.map((f) => f.path)).toEqual(['supabase/migrations/1.sql']);
    expect(JSON.stringify(request)).not.toContain('real data');
    expect(await proveRequest([], commit({ 'src/app.ts': 'x' }), null)).toBeNull();
  });
});

describe('fake users and seeding', () => {
  it('finds the owner column and seeds a canary only for Alice', () => {
    expect(ownerColumn(notes, [notes])).toBe('owner_id');
    const sql = seedSql([notes], users);
    expect(sql).toContain(`'${users.canary}-notes-title'`);
    expect(sql).toContain("'bob-title'");
    expect(seedTargets([notes])).toEqual([{ table: 'notes', owner: 'owner_id' }]);
  });
});

describe('ground truth', () => {
  it('counts canary rows in answers, never in error messages that echo a query', () => {
    const out = [`id\ttitle`, `1\t${users.canary}-notes-title`, `ERROR:  permission denied`, `LINE 1: select '${users.canary}'`].join('\n');
    expect(canaryRowsIn(out, users.canary)).toBe(1);
    expect(tableOfCanary(out, users.canary, [{ table: 'notes', owner: 'owner_id' }])).toBe('notes');
    expect(canaryRowsIn('id\ttitle\n', users.canary)).toBe(0);
  });

  it('sees a change or a delete of Alice’s rows in the fingerprints', () => {
    const before = { notes: { rows: 1, hash: 'a' }, profiles: { rows: 1, hash: 'b' } };
    expect(changesBetween(before, { notes: { rows: 1, hash: 'c' }, profiles: { rows: 1, hash: 'b' } })).toEqual([{ table: 'notes', action: 'update', rows: 1 }]);
    expect(changesBetween(before, { notes: { rows: 0, hash: 'd' }, profiles: { rows: 1, hash: 'b' } })).toEqual([{ table: 'notes', action: 'delete', rows: 1 }]);
    expect(changesBetween(before, before)).toEqual([]);
  });

  /** A sandbox that answers every query as the given actor sees the notes table. */
  const fakeSandbox = (rowsFor: (user: string) => string, endUser?: string): Sandbox => ({
    start: async () => undefined,
    stop: async () => undefined,
    psql: async (call) => {
      if (call.user === 'postgres') return { code: 0, out: `notes\t1\tsame-hash`, ms: 1 };
      const who = call.user === 'anon' ? ['anon', '-'] : ['authenticated', users.bob];
      const marked = call.sql.includes('LUCID-Q0') ? `LUCID-Q0\n${rowsFor(call.user)}\n` : '';
      return { code: 0, out: `${marked}?column?\tcurrent_user\tcoalesce\nLUCID-END\t${endUser ?? who[0]}\t${who[1]}`, ms: 1 };
    },
  });
  const context = (sandbox: Sandbox) => ({
    sandbox,
    db: 'after',
    users,
    tables: [notes],
    targets: [{ table: 'notes', owner: 'owner_id' }],
    deadline: Date.now() + 60_000,
    attacker: 'meta' as const,
    maxAgentCalls: 1,
  });

  it('proves a read only when Alice’s canary came back', async () => {
    const leaky = fakeSandbox((user) => (user === 'anon' ? `id\ttitle\n1\t${users.canary}-notes-title` : 'id\ttitle'));
    const outcome = await attack(context(leaky));
    expect(outcome.evidence).toEqual({ actor: 'anon', action: 'read', table: 'notes', rows: 1, query: 'select * from public."notes";', by: 'probe', columns: ['id', 'title'] });
  });

  it('keeps searching past a hit that was already open before the commit', async () => {
    const leaky = fakeSandbox(() => `id\ttitle\n1\t${users.canary}-notes-title`);
    const offered: string[] = [];
    const skipAnon = async (e: { actor: string }) => (offered.push(e.actor), e.actor === 'anon' ? ('skip' as const) : ('keep' as const));
    const outcome = await attack({ ...context(leaky), consider: skipAnon });
    expect(offered).toEqual(['anon', 'bob']);
    expect(outcome.evidence).toMatchObject({ actor: 'bob', action: 'read', table: 'notes' });
  });

  it('never trusts the attacker’s word, or a session that changed who it was', async () => {
    // Nothing leaks; the attacker model claims success anyway.
    answers.push(JSON.stringify({ tool: 'done', args: {}, why: "I read all of Alice's notes!" }));
    expect((await attack(context(fakeSandbox(() => 'id\ttitle')))).evidence).toBeNull();
    // The canary came back, but from a session that was not anon or Bob any more.
    answers.push(JSON.stringify({ tool: 'done', args: {} }));
    const tampered = fakeSandbox(() => `id\ttitle\n1\t${users.canary}-notes-title`, 'postgres');
    expect((await attack(context(tampered))).evidence).toBeNull();
  });
});

describe('the privacy judge', () => {
  const read = { actor: 'anon' as const, action: 'read' as const, table: 'posts', rows: 1, query: 'select * from posts', by: 'probe' as const };

  it('downgrades a read of clearly public data, never a write', async () => {
    answers.push(JSON.stringify({ clearlyPublic: true, reason: 'Published blog posts, meant for everyone.' }));
    const verdict = await judgePrivacy(notes, read, 'baseten');
    expect(downgrade(read, verdict)).toEqual({ keep: false, reason: 'the data looks meant for everyone: Published blog posts, meant for everyone.' });
    expect(downgrade({ ...read, action: 'update' }, verdict).keep).toBe(true);
    expect(downgrade(read, { clearlyPublic: false, reason: 'Private notes.' }).keep).toBe(true);
    // No verdict: no proof claimed.
    expect(downgrade(read, null).keep).toBe(false);
  });
});

describe('the words on a proven card', () => {
  const proven: ProofResult = {
    status: 'proven', table: 'notes', role: 'anon', action: 'read', rows: 2, query: 'select * from public."notes";', foundBy: 'probe', before: 'blocked',
    reason: null, judge: { clearlyPublic: false, reason: 'x' }, summary: 's', log: [],
    timings: { setupMs: 0, attackMs: 0, judgeMs: 0, beforeMs: 0, totalMs: 0 },
    usage: { attacker: { calls: 0, input: 0, output: 0, reasoning: 0 }, judge: { calls: 0, input: 0, output: 0, reasoning: 0 } },
  };
  const card = {
    kind: 'risk', category: 'data-exposure', severity: 'high', evidence: 'warning', title: 'This change turns off the lock on notes',
    whatCouldHappen: 'x could happen.', whoIsAffected: 'People.', keyLine: { file: 'a.sql', line: 1, endLine: 1, code: 'x', link: null, plainWords: 'x' },
    fixPrompt: 'x', ideaBehindIt: 'x', concept: 'row-level-security',
    checks: { quotesVerified: 1, quotesTotal: 1, plainEnglish: 'passed', review: 'passed', timeMs: { pick: 0, write: 0, review: 0, total: 0 } },
  } as WarningCard;

  it('says what happened to fake users, before and after, and never "safe" or "real"', () => {
    expect(proofSentence(proven)).toBe("In a disposable sandbox with fake users, a signed-out visitor read 2 of Alice's private rows from `notes`. Before your commit: blocked. After: leaked.");
    expect(proofSentence({ ...proven, role: 'bob', action: 'delete', rows: 1, before: 'no-table' })).toBe(
      "In a disposable sandbox with fake users, another signed-in user (Bob) deleted Alice's row from `notes`. Before your commit: the table didn't exist. After: allowed.",
    );
    expect(proofSentence({ ...proven, action: 'update', rows: 1, before: 'leaked' })).toBe(
      "In a disposable sandbox with fake users, a signed-out visitor changed Alice's row in `notes`. Before your commit: also open. After: allowed.",
    );
    expect(PROOF_STATEMENT).toBe('Reproduced unauthorized access against fake users, using your database rules, in a disposable sandbox.');
    for (const text of [proofSentence(proven), PROOF_STATEMENT]) expect(text).not.toMatch(/\bsafe|secure|real (user )?data/i);
  });

  it('turns a warning into "Proven" only for a proven result', () => {
    const p = applyProof(card, proven);
    expect(p).toMatchObject({ evidence: 'proven', proof: { table: 'notes', rows: 2, before: 'blocked', statement: PROOF_STATEMENT } });
    const html = renderCardHtml(p);
    expect(html).toContain('<span class="badge">Proven</span>');
    expect(html).toContain('What Lucid reproduced');
    expect(html).toContain('select * from public.&quot;notes&quot;;');

    for (const status of ['not-reproduced', 'error'] as const) {
      const w = applyProof(card, { ...proven, status });
      expect(w.evidence).toBe('warning');
      expect(w.proofNote).toBe(NOT_REPRODUCED_NOTE);
      expect(renderCardHtml(w)).toContain('<span class="badge">Warning</span>');
    }
  });
});

describe('POST /prove', () => {
  const lessonDeps = {
    enabled: () => true,
    verify: async (token: string) => (token === 'good' ? { id: '1', login: 'ada' } : null),
    limits: new DailyLimits({ perUser: 20, global: 300 }),
    runLesson: async () => {
      throw new Error('not used');
    },
  };
  const body = (over: object = {}) => JSON.stringify({ before: [], after: [{ path: 'supabase/migrations/1.sql', text: 'select 1;' }, { path: 'src/app.ts', text: 'code' }], touched: { tables: ['notes'], policies: [] }, ...over });

  it('is paused by its own switch, needs sign-in, and gives 5 proofs a day', async () => {
    const seen: unknown[] = [];
    const prove = { enabled: () => true, limits: new DailyLimits({ perUser: 5, global: 100 }), runProof: async (input: unknown) => (seen.push(input), { status: 'not-reproduced' } as ProofResult) };
    expect((await handleProve('Bearer good', body(), lessonDeps, { ...prove, enabled: () => false })).status).toBe(503);
    expect((await handleProve(undefined, body(), lessonDeps, prove)).status).toBe(401);
    for (let i = 0; i < 5; i += 1) expect((await handleProve('Bearer good', body(), lessonDeps, prove)).status).toBe(200);
    expect(await handleProve('Bearer good', body(), lessonDeps, prove)).toEqual({ status: 429, body: { error: 'user-limit' } });
    // Only setup files reach the prover, whatever was sent.
    expect(JSON.stringify(seen[0])).not.toContain('src/app.ts');
  });

  it('refuses setup files over 1 MB', async () => {
    const prove = { enabled: () => true, limits: new DailyLimits({ perUser: 5, global: 100 }), runProof: async () => ({}) as ProofResult };
    const big = body({ after: [{ path: 'supabase/migrations/1.sql', text: 'x'.repeat(600_000) }, { path: 'supabase/migrations/2.sql', text: 'x'.repeat(600_000) }] });
    expect((await handleProve('Bearer good', big, lessonDeps, prove)).status).toBe(413);
  });

  it('knows every fixture', () => {
    expect(Object.keys(PROVER_COMMITS)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q']);
  });
});
