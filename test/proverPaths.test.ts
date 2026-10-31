import type { AddressInfo } from 'node:net';
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

const { attack, changesBetween } = await import('../src/prover/attack');
const { prove, PROOF_STATEMENT } = await import('../src/prover/prove');
const { parseDatabase } = await import('../src/prover/schema');
const { applyProof, NOT_REPRODUCED_NOTE, proofSentence } = await import('../src/engine/card');
const { renderCardHtml } = await import('../src/ui/cardHtml');
const { askProve, cardAfterProof, proveRequest, touchesDatabase, wantsProof } = await import('../extension/src/prove');
const { provenToast } = await import('../extension/src/messages');
const { parseDiff } = await import('../src/engine/diff');
const { handleProve } = await import('../src/server/handler');
const { DailyLimits } = await import('../src/server/limits');
const { createLucidServer, proveDepsFromEnv, PROOFS_PER_USER_DAILY } = await import('../src/server/main');
const { callModel } = await import('../src/engine/model');
const { judgeInput } = await import('../src/prover/judge');
const { proverCommit } = await import('./proverFixtures');

import type { WarningCard } from '../src/engine/card';
import type { ProofResult } from '../src/prover/result';
import type { PsqlCall, Sandbox } from '../src/prover/sandbox';
import type { FunctionInfo, TableInfo, ViewInfo } from '../src/prover/schema';

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
  ],
  fks: [{ column: 'owner_id', refTable: 'auth.users', refColumn: 'id' }],
  policies: [{ name: 'owners read their notes', command: 'SELECT', roles: ['public'], using: '(auth.uid() = owner_id)', withCheck: null }],
};

const notesForUser: FunctionInfo = { name: 'notes_for_user', args: 'target uuid', returns: 'SETOF notes', securityDefiner: true, source: 'select * from public.notes where owner_id = target;', anon: true, authenticated: true };
const notesFeed: ViewInfo = { name: 'notes_feed', definition: 'SELECT id, title FROM notes;', securityInvoker: false, anon: true, authenticated: true };

const whoFor = (user: string) => (user === 'anon' ? ['anon', '-'] : ['authenticated', users.bob]);

/** A sandbox whose answers depend on the SQL; the superuser's fingerprint can change along the way. */
const scripted = (answer: (sql: string) => string, fingerprint: () => string = () => 'notes\t1\tsame-hash'): Sandbox => ({
  start: async () => undefined,
  stop: async () => undefined,
  psql: async (call: PsqlCall) => {
    if (call.user === 'postgres') return { code: 0, out: fingerprint(), ms: 1 };
    const [role, uid] = whoFor(call.user);
    const marked = call.sql.includes('LUCID-Q0') ? 'LUCID-Q0\nid\ttitle\n' : '';
    return { code: 0, out: `${marked}${answer(call.sql)}\n?column?\tcurrent_user\tcoalesce\nLUCID-END\t${role}\t${uid}`, ms: 1 };
  },
});

const context = (sandbox: Sandbox) => ({
  sandbox,
  db: 'after',
  users,
  tables: [notes],
  views: [notesFeed],
  functions: [notesForUser],
  targets: [{ table: 'notes', owner: 'owner_id' }],
  deadline: Date.now() + 60_000,
  attacker: 'meta' as const,
});
const call = (tool: string, args: object = {}) => JSON.stringify({ tool, args });

describe('reading views and functions from the database', () => {
  it('parses both, and copes with an output that has neither', () => {
    const db = parseDatabase(`\n${JSON.stringify({ tables: [], views: [notesFeed], functions: [notesForUser] })}\n`);
    expect(db.views[0]).toMatchObject({ name: 'notes_feed', securityInvoker: false });
    expect(db.functions[0]).toMatchObject({ name: 'notes_for_user', securityDefiner: true });
    expect(parseDatabase(JSON.stringify({ tables: [] }))).toEqual({ tables: [], views: [], functions: [] });
  });
});

describe('the attacker model finds what the probes cannot reach', () => {
  it('reads the functions, calls one with Alice’s id, and only the canary makes it a proof', async () => {
    const leak = (sql: string) => (sql.includes('notes_for_user') ? `id\ttitle\n1\t${users.canary}-notes-title` : 'id\ttitle');
    answers.push(call('list_functions'), call('run_as', { role: 'anon', sql: `select * from public.notes_for_user('${users.alice}')` }));
    const outcome = await attack(context(scripted(leak)));
    expect(outcome.evidence).toMatchObject({ actor: 'anon', action: 'read', table: 'notes', by: 'attacker' });
    const listed = outcome.log.find((c) => c.tool === 'list_functions')!;
    expect(listed.output).toContain('notes_for_user(target uuid) returns SETOF notes: security definer; anon and bob may call it');
    // The probes ran first and found nothing.
    expect(outcome.log.filter((c) => c.by === 'probe' && c.canaryRows > 0)).toEqual([]);
  });

  it('shows the views, with what they run as', async () => {
    answers.push(call('list_views'), call('done'));
    const outcome = await attack(context(scripted(() => 'id\ttitle')));
    expect(outcome.log.find((c) => c.tool === 'list_views')!.output).toContain('notes_feed: security_invoker off; anon and bob may read it');
    expect(outcome.evidence).toBeNull();
  });

  it('never tells the model the canary', async () => {
    answers.push(call('run_as', { role: 'anon', sql: 'select * from public.notes_feed' }));
    const seen: string[] = [];
    vi.mocked(callModel).mockImplementationOnce(async (_p, c) => (seen.push(c.user), answers.shift()!));
    const consider = async () => 'skip' as const;
    vi.mocked(callModel).mockImplementationOnce(async (_p, c) => (seen.push(c.user), call('done')));
    await attack({ ...context(scripted((sql) => (sql.includes('notes_feed') ? `1\t${users.canary}-notes-title` : 'id\ttitle'))), consider });
    expect(seen[1]).toContain('<alice-data>');
    expect(seen.join('\n')).not.toContain(users.canary);
  });

  it('counts a row added in Alice’s name as an insert, from the fingerprints', async () => {
    let rows = 1;
    const sandbox = scripted(() => '', () => `notes\t${rows}\thash-${rows}`);
    const realPsql = sandbox.psql;
    sandbox.psql = async (c) => {
      if (c.user !== 'postgres' && c.sql.includes('insert into public.notes')) rows += 1;
      return realPsql(c);
    };
    answers.push(call('run_as', { role: 'bob', sql: `insert into public.notes (id, owner_id, title) values ('${users.bob}', '${users.alice}', 'x')` }));
    const outcome = await attack(context(sandbox));
    expect(outcome.evidence).toMatchObject({ actor: 'bob', action: 'insert', table: 'notes', rows: 1, by: 'attacker' });
    expect(changesBetween({ notes: { rows: 1, hash: 'a' } }, { notes: { rows: 3, hash: 'b' } })).toEqual([{ table: 'notes', action: 'insert', rows: 2 }]);
  });

  it('notices a write through a function, which does not read like a write', async () => {
    let hash = 'first';
    const sandbox = scripted(() => '', () => `notes\t1\t${hash}`);
    const realPsql = sandbox.psql;
    sandbox.psql = async (c) => {
      if (c.user !== 'postgres' && c.sql.includes('rename_note')) hash = 'second';
      return realPsql(c);
    };
    answers.push(call('run_as', { role: 'bob', sql: "select public.rename_note('x')" }));
    const outcome = await attack(context(sandbox));
    expect(outcome.evidence).toMatchObject({ action: 'update', by: 'attacker', query: "select public.rename_note('x')" });
  });

  it('survives an empty answer from the model: one call lost, not the proof', async () => {
    const leak = (sql: string) => (sql.includes('notes_for_user') ? `1\t${users.canary}-notes-title` : 'id\ttitle');
    vi.mocked(callModel).mockImplementationOnce(async () => {
      throw new Error('meta returned an empty answer (it ran out of tokens, likely while reasoning).');
    });
    answers.push(call('run_as', { role: 'anon', sql: `select * from public.notes_for_user('${users.alice}')` }));
    expect((await attack(context(scripted(leak)))).evidence).toMatchObject({ by: 'attacker', action: 'read' });
  });

  it('runs no model at all with zero calls allowed', async () => {
    vi.mocked(callModel).mockClear();
    const outcome = await attack({ ...context(scripted(() => 'id\ttitle')), maxAgentCalls: 0 });
    expect(outcome.evidence).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });
});

const proven: ProofResult = {
  status: 'proven', table: 'notes', role: 'bob', action: 'insert', rows: 1, query: 'insert into public.notes', foundBy: 'attacker', before: 'blocked',
  reason: null, judge: null, summary: 's', log: [],
  timings: { setupMs: 0, attackMs: 0, judgeMs: 0, beforeMs: 0, totalMs: 0 },
  usage: { attacker: { calls: 0, input: 0, output: 0, reasoning: 0 }, judge: { calls: 0, input: 0, output: 0, reasoning: 0 } },
};
const card = {
  kind: 'risk', category: 'data-exposure', severity: 'high', evidence: 'warning', title: 'This change opens notes',
  whatCouldHappen: 'x could happen.', whoIsAffected: 'People.', keyLine: { file: 'a.sql', line: 1, endLine: 1, code: 'x', link: null, plainWords: 'x' },
  fixPrompt: 'x', ideaBehindIt: 'x', concept: 'row-level-security',
  checks: { quotesVerified: 1, quotesTotal: 1, plainEnglish: 'passed', review: 'passed', timeMs: { pick: 0, write: 0, review: 0, total: 0 } },
} as WarningCard;

describe('the privacy judge is told how the row came back', () => {
  const read = { actor: 'bob' as const, action: 'read' as const, table: 'notes', rows: 1, query: 'select * from public.notes_feed', by: 'attacker' as const };

  it('says when the table’s own rule hides the row, and what it came through', () => {
    const input = JSON.parse(judgeInput(notes, { ...read, hiddenByTableRule: true }, { through: ['view notes_feed: SELECT id FROM notes;'], blockedBefore: true }));
    expect(input).toMatchObject({ query: 'select * from public.notes_feed', hiddenByTableRule: true, blockedBefore: true, through: ['view notes_feed: SELECT id FROM notes;'] });
  });

  it('says nothing of the kind for a plain read', () => {
    const input = JSON.parse(judgeInput(notes, { ...read, by: 'probe', query: 'select * from public."notes";' }));
    expect(input).not.toHaveProperty('hiddenByTableRule');
    expect(input).not.toHaveProperty('through');
    expect(input).not.toHaveProperty('blockedBefore');
  });

  it('marks a hit by the attacker model only when the plain read of that table failed', async () => {
    // The plain read of notes shows nothing; the view shows Alice's row.
    const leak = (sql: string) => (sql.includes('notes_feed') ? `1\t${users.canary}-notes-title` : 'id\ttitle');
    answers.push(call('run_as', { role: 'bob', sql: 'select * from public.notes_feed' }));
    expect((await attack(context(scripted(leak)))).evidence).toMatchObject({ by: 'attacker', hiddenByTableRule: true });
    // The plain read is open, so it is a probe's hit and nothing is hidden.
    const open = await attack(context(scripted(() => `1\t${users.canary}-notes-title`)));
    expect(open.evidence).toMatchObject({ by: 'probe' });
    expect(open.evidence?.hiddenByTableRule).toBeUndefined();
  });
});

describe('a proven card never implies real data leaked', () => {
  it('says sandbox and fake users on the card, in the sentence and in the toast', () => {
    const p = applyProof({ ...card }, { ...proven, action: 'read', rows: 1 });
    const html = renderCardHtml(p);
    expect(html).toContain('Reproduced with fake users in a disposable sandbox');
    expect(html).toContain('In a disposable sandbox with fake users, another signed-in user (Bob) read Alice&#39;s private row');
    expect(html).toContain(PROOF_STATEMENT);
    expect(html).not.toMatch(/\breal (user|people|customer|production|deployed)|production data|your data (was|has been)|live data/i);
    expect(provenToast('This change opens notes')).toBe('⚠️ Lucid proved it in a sandbox with fake users: This change opens notes');
  });

  it('describes a row added in Alice’s name', () => {
    expect(proofSentence(proven)).toBe("In a disposable sandbox with fake users, another signed-in user (Bob) added a row in Alice's name in `notes`. Before your commit: blocked. After: allowed.");
    expect(proofSentence({ ...proven, rows: 2 })).toContain('added 2 rows in Alice');
  });
});

describe('when the sandbox fails or times out, the card stays a warning', () => {
  const input = () => {
    const c = proverCommit('a');
    return { before: c.before, after: c.after, touched: c.touched };
  };
  const expectQuietWarning = (r: ProofResult) => {
    expect(r.status).toBe('error');
    const w = applyProof(card, r);
    expect(w.evidence).toBe('warning');
    expect(w.proofNote).toBe(NOT_REPRODUCED_NOTE);
    const html = renderCardHtml(w);
    expect(html).toContain('<span class="badge">Warning</span>');
    expect(html).not.toContain('<span class="badge">Proven</span>');
    expect(html).toContain('Lucid couldn&#39;t reproduce this in its sandbox. That doesn&#39;t mean it&#39;s safe.');
  };

  it('a sandbox that will not start', async () => {
    let stopped = 0;
    const r = await prove(input(), { sandbox: () => ({ start: async () => { throw new Error('no capacity'); }, psql: async () => ({ code: 0, out: '', ms: 0 }), stop: async () => void (stopped += 1) }) });
    expectQuietWarning(r);
    expect(r.reason).toContain('no capacity');
    expect(stopped).toBe(1);
  });

  it('a sandbox that dies halfway', async () => {
    const r = await prove(input(), { sandbox: () => ({ start: async () => undefined, psql: async () => { throw new Error('the sandbox stopped'); }, stop: async () => undefined }) });
    expectQuietWarning(r);
  });

  it('a sandbox that hangs: the hard limit ends the proof and stops the sandbox', async () => {
    let stopped = 0;
    const r = await prove(input(), { hardLimitMs: 30, sandbox: () => ({ start: async () => undefined, psql: () => new Promise(() => undefined), stop: async () => void (stopped += 1) }) });
    expectQuietWarning(r);
    expect(r.reason).toBe('the proof ran out of time');
    expect(stopped).toBe(1);
  });

  it('/prove answers an error, times out, or cannot be reached', async () => {
    const request = { before: [], after: [], touched: { tables: [], policies: [], views: [], functions: [] } };
    const answersFrom: (typeof fetch)[] = [
      (async () => new Response(JSON.stringify({ error: 'prover-error', kind: 'Error' }), { status: 502 })) as typeof fetch,
      (async () => new Response('<html>Bad gateway</html>', { status: 504 })) as typeof fetch,
      (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as typeof fetch,
      (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    ];
    for (const f of answersFrom) {
      const w = cardAfterProof(card, await askProve('https://lucid.test', 'token', request, f));
      expect(w.evidence).toBe('warning');
      expect(w.proofNote).toBe(NOT_REPRODUCED_NOTE);
    }
  });

  it('never leaves a refused test sounding like a clean result', async () => {
    const request = { before: [], after: [], touched: { tables: [], policies: [], views: [], functions: [] } };
    for (const error of ['user-limit', 'daily-cap', 'paused', 'too-large']) {
      const f = (async () => new Response(JSON.stringify({ error }), { status: 429 })) as typeof fetch;
      expect(cardAfterProof(card, await askProve('https://lucid.test', 'token', request, f)).proofNote).toMatch(/not tested\. That doesn't mean it's safe\.$/);
    }
  });

  it('a proven answer still turns the card', async () => {
    const f = (async () => new Response(JSON.stringify({ result: proven }), { status: 200 })) as typeof fetch;
    const answer = await askProve('https://lucid.test', 'token', { before: [], after: [], touched: { tables: [], policies: [], views: [], functions: [] } }, f);
    expect(cardAfterProof(card, answer).evidence).toBe('proven');
  });
});

describe('no sandbox for a commit that changed no database file', () => {
  const uiDiff = ['diff --git a/src/app/page.tsx b/src/app/page.tsx', '--- a/src/app/page.tsx', '+++ b/src/app/page.tsx', '@@ -1,1 +1,1 @@', '-<h1>Old</h1>', '+<h1>New</h1>', ''].join('\n');
  const repo = (files: Record<string, string>) => ({ paths: async () => Object.keys(files), read: async (p: string) => files[p]! });
  const withMigrations = repo({ 'supabase/migrations/1.sql': 'create table a();', 'src/app/page.tsx': 'x' });

  it('sends nothing, even in a repository full of migrations', async () => {
    expect(await proveRequest(parseDiff(uiDiff), withMigrations, withMigrations)).toBeNull();
  });

  it('counts a changed, deleted or renamed setup file, but not a seed file', () => {
    expect(touchesDatabase(parseDiff(proverCommit('a').diff))).toBe(true);
    const deleted = ['diff --git a/supabase/migrations/1.sql b/supabase/migrations/1.sql', 'deleted file mode 100644', '--- a/supabase/migrations/1.sql', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-select 1;', ''].join('\n');
    expect(touchesDatabase(parseDiff(deleted))).toBe(true);
    const renamed = ['diff --git a/supabase/migrations/1.sql b/old/1.sql', 'similarity index 100%', 'rename from supabase/migrations/1.sql', 'rename to old/1.sql', ''].join('\n');
    expect(touchesDatabase(parseDiff(renamed))).toBe(true);
    const seed = ['diff --git a/supabase/seed.sql b/supabase/seed.sql', '--- a/supabase/seed.sql', '+++ b/supabase/seed.sql', '@@ -1,1 +1,1 @@', '-select 1;', '+select 2;', ''].join('\n');
    expect(touchesDatabase(parseDiff(seed))).toBe(false);
  });

  it('tests only a data-exposure warning', () => {
    expect(wantsProof(card)).toBe(true);
    expect(wantsProof({ ...card, category: 'secrets' })).toBe(false);
    expect(wantsProof(null)).toBe(false);
  });

  it('is refused by the server too, without spending a test', async () => {
    let runs = 0;
    const lessons = { enabled: () => true, verify: async () => ({ id: '1', login: 'ada' }), limits: new DailyLimits({ perUser: 20, global: 300 }), runLesson: async () => { throw new Error('not used'); } };
    const limits = new DailyLimits({ perUser: 1, global: 100 });
    const proveDeps = { enabled: () => true, limits, runProof: async () => (runs += 1, proven) };
    const same = [{ path: 'supabase/migrations/1.sql', text: 'select 1;' }];
    const body = (after: object[]) => JSON.stringify({ before: same, after, touched: { tables: [], policies: [] } });
    expect(await handleProve('Bearer good', body(same), lessons, proveDeps)).toEqual({ status: 422, body: { error: 'no-database-change' } });
    expect(runs).toBe(0);
    // The test it did not spend is still there, and a request from an extension before 0.3.1 still works.
    expect((await handleProve('Bearer good', body([...same, { path: 'supabase/migrations/2.sql', text: 'select 2;' }]), lessons, proveDeps)).status).toBe(200);
    expect(runs).toBe(1);
  });
});

describe('the caps and switches, over real HTTP', () => {
  const start = async (env: Record<string, string | undefined>) => {
    let runs = 0;
    const lessons = {
      enabled: () => env.LUCID_ENABLED?.trim().toLowerCase() !== 'false',
      verify: async (token: string) => ({ id: token, login: token }),
      limits: new DailyLimits({ perUser: 20, global: 300 }),
      runLesson: async () => { throw new Error('not used'); },
    };
    const server = createLucidServer(lessons, proveDepsFromEnv(env, async () => (runs += 1, proven)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = JSON.stringify({ before: [], after: [{ path: 'supabase/migrations/1.sql', text: 'select 1;' }], touched: { tables: [], policies: [] } });
    const ask = async (user: string) => {
      const r = await fetch(`${base}/prove`, { method: 'POST', headers: { authorization: `Bearer ${user}` }, body });
      return { status: r.status, error: ((await r.json()) as { error?: string }).error };
    };
    return { ask, base, runs: () => runs, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  };

  it('holds LUCID_PROVE_CAP for everyone, even at the same moment', async () => {
    const s = await start({ LUCID_PROVE_CAP: '3' });
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => s.ask(`user-${i}`)));
    expect(replies.filter((r) => r.status === 200)).toHaveLength(3);
    expect(replies.filter((r) => r.status === 429 && r.error === 'daily-cap')).toHaveLength(9);
    expect(s.runs()).toBe(3);
    await s.close();
  });

  it('holds the limit per person, and leaves other people alone', async () => {
    const s = await start({});
    const mine = await Promise.all(Array.from({ length: PROOFS_PER_USER_DAILY + 3 }, () => s.ask('ada')));
    expect(mine.filter((r) => r.status === 200)).toHaveLength(PROOFS_PER_USER_DAILY);
    expect(mine.filter((r) => r.status === 429 && r.error === 'user-limit')).toHaveLength(3);
    expect((await s.ask('grace')).status).toBe(200);
    await s.close();
  });

  it('LUCID_PROVE_ENABLED=false stops every proof at once, and spends nothing', async () => {
    const env: Record<string, string | undefined> = { LUCID_PROVE_CAP: '1', LUCID_PROVE_ENABLED: 'false' };
    const s = await start(env);
    expect(await s.ask('ada')).toEqual({ status: 503, error: 'paused' });
    expect(((await (await fetch(`${s.base}/health`)).json()) as { prove: boolean }).prove).toBe(false);
    expect(s.runs()).toBe(0);
    env.LUCID_PROVE_ENABLED = 'true';
    expect((await s.ask('ada')).status).toBe(200);
    await s.close();
  });

  it('LUCID_ENABLED=false stops proofs too', async () => {
    const s = await start({ LUCID_ENABLED: 'false' });
    expect(await s.ask('ada')).toEqual({ status: 503, error: 'paused' });
    expect(s.runs()).toBe(0);
    await s.close();
  });

  it('a cap of 0 refuses everything; an empty or broken cap falls back to 100, never to 0', async () => {
    const zero = await start({ LUCID_PROVE_CAP: '0' });
    expect(await zero.ask('ada')).toEqual({ status: 429, error: 'daily-cap' });
    await zero.close();
    for (const cap of ['', '  ', 'lots']) {
      const s = await start({ LUCID_PROVE_CAP: cap });
      expect((await s.ask('ada')).status).toBe(200);
      await s.close();
    }
  });
});
