import { describe, expect, it } from 'vitest';
import { plainReason } from '../extension/src/messages';
import { askServer } from '../extension/src/server';
import { RLS_DIFF } from './fixtures';
import { classifyHeadChange, RunQueue } from '../extension/src/trigger';
import type { LessonCard } from '../src/engine/card';
import { renderCardHtml } from '../src/ui/cardHtml';

describe('classifyHeadChange', () => {
  const base = { previous: 'aaa', current: 'bbb', parents: ['aaa'], reflogSubject: 'commit: Fix the login button' };

  it('sees a new commit on top of the previous HEAD', () => {
    expect(classifyHeadChange(base)).toBe('new-commit');
  });

  it('ignores a HEAD that did not move, or the first HEAD it sees', () => {
    expect(classifyHeadChange({ ...base, current: 'aaa' })).toBe('unchanged');
    expect(classifyHeadChange({ ...base, current: undefined })).toBe('unchanged');
    expect(classifyHeadChange({ ...base, previous: undefined })).toBe('other');
  });

  it('ignores a checkout to another branch', () => {
    expect(classifyHeadChange({ ...base, parents: ['zzz'], reflogSubject: 'checkout: moving from main to feature' })).toBe('other');
  });

  it('ignores a pull, even one that fast-forwards by a single commit', () => {
    expect(classifyHeadChange({ ...base, reflogSubject: 'pull: Fast-forward' })).toBe('other');
    expect(classifyHeadChange({ ...base, reflogSubject: 'merge origin/main: Fast-forward' })).toBe('other');
  });

  it('ignores amends, rebases, resets, cherry-picks and merge commits', () => {
    expect(classifyHeadChange({ ...base, parents: ['000'], reflogSubject: 'commit (amend): Fix the login button' })).toBe('other');
    expect(classifyHeadChange({ ...base, reflogSubject: 'rebase (finish): returning to refs/heads/main' })).toBe('other');
    expect(classifyHeadChange({ ...base, reflogSubject: 'reset: moving to HEAD~1' })).toBe('other');
    expect(classifyHeadChange({ ...base, reflogSubject: 'cherry-pick: Fix the login button' })).toBe('other');
    expect(classifyHeadChange({ ...base, parents: ['aaa', 'ccc'], reflogSubject: 'commit (merge): Merge branch x' })).toBe('other');
  });

  it('stays quiet when the reflog is unreadable', () => {
    expect(classifyHeadChange({ ...base, reflogSubject: '' })).toBe('other');
  });
});

describe('RunQueue', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('runs one job at a time and keeps only the newest waiting job', async () => {
    const ran: string[] = [];
    let release: () => void = () => {};
    const queue = new RunQueue<string>(async (job) => {
      ran.push(job);
      if (job === 'first') await new Promise<void>((r) => (release = r));
    });

    queue.request('first');
    queue.request('second');
    queue.request('third');
    expect(queue.busy).toBe(true);
    expect(ran).toEqual(['first']);

    release();
    for (let i = 0; i < 5; i += 1) await tick();
    expect(ran).toEqual(['first', 'third']);
    expect(queue.busy).toBe(false);
  });

  it('keeps going after a job throws', async () => {
    const ran: string[] = [];
    const queue = new RunQueue<string>(async (job) => {
      ran.push(job);
      throw new Error('boom');
    });
    queue.request('a');
    for (let i = 0; i < 3; i += 1) await tick();
    queue.request('b');
    for (let i = 0; i < 3; i += 1) await tick();
    expect(ran).toEqual(['a', 'b']);
  });
});

describe('plainReason', () => {
  it('turns errors into one plain sentence', () => {
    expect(plainReason({ status: 401, message: 'Incorrect API key provided: sk-abc' })).toEqual({
      message: 'A model service rejected your API key. Check your Meta and Baseten keys.',
      offerKeys: true,
    });
    expect(plainReason({ name: 'APIConnectionError', message: 'Connection error.' }).message).toMatch(/couldn't reach/);
    expect(plainReason({ name: 'GitError', message: 'git show failed' }).message).toBe("Lucid couldn't read this commit from git.");
    expect(plainReason(new TypeError('x is undefined')).message).toBe('Something went wrong while Lucid was reading your change.');
  });

  it('never repeats the raw error text', () => {
    expect(plainReason({ status: 401, message: 'key sk-secret-123 rejected' }).message).not.toContain('sk-secret');
  });
});

describe('lesson card in a webview', () => {
  const card: LessonCard = {
    kind: 'lesson',
    category: null,
    severity: null,
    evidence: null,
    title: 'Your <script>alert(1)</script> app',
    story: ['A story with `<b>code</b>` in it.', 'Second paragraph & more.'],
    keyLine: { file: 'src/a.ts', line: 3, endLine: 3, code: 'if (a < b) return "</script>";', link: null, plainWords: 'Compare "a" and b.' },
    question: 'What <i>now</i>?',
    options: { A: 'One', B: 'Two', C: 'Three' },
    answer: 'C',
    feedback: { A: 'Not quite.', B: 'Not quite.', C: 'Right.' },
    concept: 'error-handling',
    checks: { quotesVerified: 1, quotesTotal: 1, plainEnglish: 'passed', review: 'passed', timeMs: { pick: 1, write: 1, review: 1, total: 3 } },
  };
  const nonce = 'abcdef0123456789abcdef0123456789';
  const html = renderCardHtml(card, { webview: { nonce } });

  it('carries a strict Content Security Policy with the nonce', () => {
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`,
    );
  });

  it('puts the nonce on every script and style, and loads nothing from outside', () => {
    const tags = html.match(/<(script|style)\b[^>]*>/g) ?? [];
    expect(tags.length).toBe(2);
    for (const t of tags) expect(t).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/<(link|img|iframe)\b|src=|https?:\/\//);
    expect(html).not.toMatch(/\son[a-z]+=/); // no inline event handlers
  });

  it('escapes all card text', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Your &lt;script&gt;alert(1)&lt;/script&gt; app');
    expect(html).toContain('return &quot;&lt;/script&gt;&quot;;');
    expect(html).toContain('<code>&lt;b&gt;code&lt;/b&gt;</code>');
  });

  it('takes its colours from the editor theme', () => {
    for (const v of ['--vscode-editor-background', '--vscode-foreground', '--vscode-textLink-foreground', '--vscode-textCodeBlock-background', '--vscode-testing-iconPassed', '--vscode-testing-iconFailed']) {
      expect(html).toContain(`var(${v})`);
    }
    expect(html).not.toContain('prefers-color-scheme');
  });

  it('refuses an unsafe nonce', () => {
    expect(() => renderCardHtml(card, { webview: { nonce: 'x" onload="alert(1)' } })).toThrow();
  });

  it('keeps the browser preview free of a CSP and editor colours', () => {
    const page = renderCardHtml(card);
    expect(page).not.toContain('Content-Security-Policy');
    expect(page).toContain('prefers-color-scheme');
  });
});

describe('askServer', () => {
  const answer = (status: number, body: object) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('sends only the filtered diff, with the GitHub token, and returns the lesson', async () => {
    let sent: { url: string; auth: string; body: { diff: string; title: string } } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      sent = { url, auth: (init.headers as Record<string, string>).authorization ?? '', body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ outcome: 'nothing-to-teach', card: null, report: ['outcome: nothing-to-teach'] }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await askServer('https://lucid.example/', 'gho_token', RLS_DIFF, 'Add RLS', fake);
    expect(r).toEqual({ kind: 'done', outcome: 'nothing-to-teach', card: null, report: ['outcome: nothing-to-teach'] });
    expect(sent!.url).toBe('https://lucid.example/lesson');
    expect(sent!.auth).toBe('Bearer gho_token');
    expect(sent!.body.title).toBe('Add RLS');
    expect(sent!.body.diff).toContain('using (auth.uid() = user_id);');
    for (const never of ['sk-live', 'SUPABASE_SERVICE_ROLE_KEY', '.env.local', 'package-lock.json', 'logo.png']) expect(sent!.body.diff).not.toContain(never);
  });

  it('asks for warnings and lessons, or warnings only when lessons are off', async () => {
    const kinds: unknown[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      kinds.push(JSON.parse(String(init.body)).kinds);
      return new Response(JSON.stringify({ outcome: 'nothing-to-teach', card: null, report: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await askServer('https://x', 't', RLS_DIFF, null, fake);
    await askServer('https://x', 't', RLS_DIFF, null, fake, ['risk']);
    expect(kinds).toEqual([['risk', 'lesson'], ['risk']]);
  });

  it('sends nothing when filtering leaves nothing', async () => {
    const lockOnly = 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-1\n+2\n';
    const never = (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch;
    expect(await askServer('https://x', 't', lockOnly, null, never)).toEqual({ kind: 'nothing-to-send' });
  });

  it('turns every refusal into one plain sentence', async () => {
    const ask = (status: number, body: object) => askServer('https://x', 't', RLS_DIFF, null, answer(status, body));
    expect(await ask(401, { error: 'bad-token' })).toEqual({ kind: 'problem', message: 'Lucid needs you to sign in with GitHub again.', action: 'sign-in' });
    expect(await ask(429, { error: 'user-limit' })).toMatchObject({ message: "You've used today's 20 Lucid lessons. More tomorrow." });
    expect(await ask(429, { error: 'daily-cap' })).toMatchObject({ message: 'Lucid has reached its limit for everyone today. Try again tomorrow.' });
    expect(await ask(503, { error: 'paused' })).toMatchObject({ message: 'Lucid is paused right now. Try again later.' });
    // The server's own key failing is not the builder's problem: no "Set keys".
    expect(await ask(502, { error: 'model-error', kind: 'AuthenticationError', status: 401 })).toEqual({ kind: 'problem', message: 'Lucid had a problem on its side. Try again later.', action: null });
    expect(await ask(502, { error: 'model-error', kind: 'RateLimitError', status: 429 })).toMatchObject({ message: 'The model service is busy right now. Try again in a minute.' });
  });

  it('says plainly when the server cannot be reached', async () => {
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await askServer('https://x', 't', RLS_DIFF, null, offline)).toEqual({
      kind: 'problem',
      message: "Lucid couldn't reach its server. Check your internet connection.",
      action: null,
    });
  });
});
