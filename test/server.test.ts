import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDiff, toUnifiedDiff } from '../src/engine/diff';
import { filterDiff, HIDDEN_TEXT } from '../src/engine/filter';
import type { LucidReport } from '../src/engine/lucid';
import { createGitHubVerifier } from '../src/server/github';
import { handleLesson, type ServerDeps } from '../src/server/handler';
import { DailyLimits } from '../src/server/limits';
import { createLucidServer } from '../src/server/main';
import { RECREATED_RULE_DIFF, RLS_DIFF } from './fixtures';

const report = (over: Partial<LucidReport> = {}): LucidReport => ({
  outcome: 'nothing-to-teach',
  comment: null,
  lesson: null,
  warning: null,
  severity: null,
  severityCall: null,
  pick: null,
  signals: [],
  check: null,
  plain: null,
  review: null,
  warningReview: null,
  sentFiles: ['a.ts'],
  skippedFiles: [],
  redactedLines: 0,
  attempts: [],
  models: { pick: 'p', write: 'w' },
  timing: { pickMs: 1, writeMs: null, reviewMs: null, totalMs: 1 },
  usage: { pick: null, write: null, review: null },
  ...over,
});

const deps = (over: Partial<ServerDeps> = {}): ServerDeps => ({
  enabled: () => true,
  verify: async (token) => (token === 'good' ? { id: '1', login: 'ada' } : null),
  limits: new DailyLimits({ perUser: 20, global: 300 }),
  runLesson: async () => report(),
  ...over,
});

const body = JSON.stringify({ diff: 'diff --git a/a b/a', title: 'x' });

describe('DailyLimits', () => {
  it('allows 20 lessons per user per day, then says no', () => {
    const limits = new DailyLimits({ perUser: 20, global: 300 });
    for (let i = 0; i < 20; i += 1) expect(limits.take('ada').ok).toBe(true);
    expect(limits.take('ada')).toEqual({ ok: false, reason: 'user-limit' });
    expect(limits.take('bob').ok).toBe(true);
  });

  it('stops everyone at the global cap', () => {
    const limits = new DailyLimits({ perUser: 20, global: 2 });
    expect(limits.take('a').ok).toBe(true);
    expect(limits.take('b').ok).toBe(true);
    expect(limits.take('c')).toEqual({ ok: false, reason: 'daily-cap' });
  });

  it('starts over on a new UTC day', () => {
    let now = new Date('2026-10-29T23:59:00Z');
    const limits = new DailyLimits({ perUser: 1, global: 300 }, () => now);
    expect(limits.take('ada').ok).toBe(true);
    expect(limits.take('ada').ok).toBe(false);
    now = new Date('2026-10-30T00:00:01Z');
    expect(limits.take('ada').ok).toBe(true);
  });
});

describe('handleLesson', () => {
  it('is paused by the kill switch before anything else', async () => {
    expect(await handleLesson('Bearer good', body, deps({ enabled: () => false }))).toEqual({ status: 503, body: { error: 'paused' } });
  });

  it('needs a GitHub sign-in that GitHub accepts', async () => {
    expect((await handleLesson(undefined, body, deps())).body).toEqual({ error: 'sign-in-required' });
    expect(await handleLesson('Bearer nope', body, deps())).toEqual({ status: 401, body: { error: 'bad-token' } });
    const down = deps({ verify: async () => { throw new Error('GitHub answered 503'); } });
    expect(await handleLesson('Bearer good', body, down)).toEqual({ status: 502, body: { error: 'github-unavailable' } });
  });

  it('rejects a malformed request without spending a lesson', async () => {
    const d = deps({ limits: new DailyLimits({ perUser: 1, global: 300 }) });
    expect((await handleLesson('Bearer good', '{not json', d)).status).toBe(400);
    expect((await handleLesson('Bearer good', JSON.stringify({ title: 'no diff' }), d)).status).toBe(400);
    expect((await handleLesson('Bearer good', body, d)).status).toBe(200);
  });

  it('answers 429 once the daily limit is used up, without calling the models', async () => {
    let runs = 0;
    const d = deps({ limits: new DailyLimits({ perUser: 1, global: 300 }), runLesson: async () => (runs += 1, report()) });
    await handleLesson('Bearer good', body, d);
    expect(await handleLesson('Bearer good', body, d)).toEqual({ status: 429, body: { error: 'user-limit' } });
    expect(runs).toBe(1);
  });

  it('returns the outcome, the card (none here) and the report lines', async () => {
    const r = await handleLesson('Bearer good', body, deps());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'nothing-to-teach', card: null });
    expect(r.body.report).toEqual(expect.arrayContaining(['outcome: nothing-to-teach']));
  });

  it('writes lessons only for extensions that predate warnings, and the asked kinds otherwise', async () => {
    const asked: unknown[] = [];
    const recording = deps({ runLesson: async ({ kinds }) => (asked.push(kinds), report()) });
    await handleLesson('Bearer good', body, recording);
    await handleLesson('Bearer good', JSON.stringify({ diff: 'x', kinds: ['risk'] }), recording);
    expect(asked).toEqual([['lesson'], ['risk']]);
    expect((await handleLesson('Bearer good', JSON.stringify({ diff: 'x', kinds: ['proven'] }), recording)).status).toBe(400);
  });

  it('never passes a model error message on', async () => {
    const failing = deps({ runLesson: async () => { throw Object.assign(new Error('Incorrect API key sk-live-123'), { name: 'AuthenticationError', status: 401 }); } });
    const r = await handleLesson('Bearer good', body, failing);
    expect(r).toEqual({ status: 502, body: { error: 'model-error', kind: 'AuthenticationError', status: 401 } });
    expect(JSON.stringify(r)).not.toContain('sk-live');
  });
});

describe('createGitHubVerifier', () => {
  it('asks GitHub once, then trusts the cache; a rejected token is null', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization ?? '';
      calls.push(auth);
      return auth === 'Bearer good'
        ? new Response(JSON.stringify({ id: 7, login: 'ada' }), { status: 200 })
        : new Response('{}', { status: 401 });
    }) as typeof fetch;
    const verify = createGitHubVerifier(fakeFetch);
    expect(await verify('good')).toEqual({ id: '7', login: 'ada' });
    expect(await verify('good')).toEqual({ id: '7', login: 'ada' });
    expect(await verify('bad')).toBeNull();
    expect(calls).toEqual(['Bearer good', 'Bearer bad']);
  });

  it('throws when GitHub itself has a problem', async () => {
    const verify = createGitHubVerifier((async () => new Response('', { status: 503 })) as typeof fetch);
    await expect(verify('good')).rejects.toThrow('GitHub answered 503');
  });
});

describe('the filtered diff that leaves the machine', () => {
  it('turns back into the same lines on the server', () => {
    for (const fixture of [RLS_DIFF, RECREATED_RULE_DIFF]) {
      const local = filterDiff(parseDiff(fixture)).files;
      const again = filterDiff(parseDiff(toUnifiedDiff(local))).files;
      const shape = (files: typeof local) => files.map((f) => ({ path: f.path, isNew: f.isNew, lines: f.lines.map(({ status, text, oldLine, newLine, redacted }) => ({ status, text, oldLine, newLine, redacted: !!redacted })) }));
      expect(shape(again)).toEqual(shape(local));
    }
  });

  it('never contains a secret, and a masked line stays masked on the server', () => {
    const text = toUnifiedDiff(filterDiff(parseDiff(RLS_DIFF)).files);
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(text).not.toContain('package-lock');
    const masked = filterDiff(parseDiff(text)).files.flatMap((f) => f.lines).filter((l) => l.masked);
    expect(masked.map((l) => l.text)).toEqual(["export const ADMIN_KEY = 'sk-••••';"]);
    // A line hidden whole by an older extension stays hidden.
    const old = filterDiff(parseDiff(text.replace("export const ADMIN_KEY = 'sk-••••';", HIDDEN_TEXT))).files.flatMap((f) => f.lines);
    expect(old.find((l) => l.text === HIDDEN_TEXT)?.redacted).toBe(true);
  });

  it('sends a secret typed into browser code only masked', () => {
    const diff = readFileSync(join(import.meta.dirname, 'fixtures', 'risky-commits', 'risky-10-secret-in-browser-code.diff'), 'utf8');
    const sent = toUnifiedDiff(filterDiff(parseDiff(diff)).files);
    expect(sent).toContain("+const stripe = new Stripe('sk_live••••');");
    expect(sent).not.toMatch(/sk_live_[a-z]/);
  });
});

describe('HTTP server', () => {
  const server = createLucidServer(deps());
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('answers health, lessons and unknown paths', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, enabled: true, prove: false });
    const lesson = await fetch(`${base}/lesson`, { method: 'POST', headers: { authorization: 'Bearer good' }, body });
    expect(lesson.status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('runs 10 lessons at the same time, not one after another', async () => {
    let running = 0;
    let most = 0;
    const slow = createLucidServer(
      deps({
        runLesson: async () => {
          running += 1;
          most = Math.max(most, running);
          await new Promise((r) => setTimeout(r, 300));
          running -= 1;
          return report();
        },
      }),
    );
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/lesson`;
    const started = Date.now();
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, i) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer good' }, body: JSON.stringify({ diff: `d${i}` }) })),
    );
    const took = Date.now() - started;
    await new Promise<void>((resolve) => slow.close(() => resolve()));

    expect(replies.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(most).toBe(10);
    expect(took).toBeLessThan(1500); // one after another would take 3 s
  });

  it('refuses a body over 2 MB', async () => {
    const big = JSON.stringify({ diff: 'x'.repeat(2_100_000) });
    const r = await fetch(`${base}/lesson`, { method: 'POST', headers: { authorization: 'Bearer good' }, body: big }).catch(() => null);
    // Either the 413 arrives, or the server cut the upload off; it never reaches the models.
    if (r) expect(r.status).toBe(413);
  });
});
