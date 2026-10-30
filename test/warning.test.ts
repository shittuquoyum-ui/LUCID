import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Script the model's answers so the warning path can be tested without any API.
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

const { parseDiff } = await import('../src/engine/diff');
const { filterDiff } = await import('../src/engine/filter');
const { pickConcept, writeWarning } = await import('../src/engine/steps');
const { runLucid } = await import('../src/engine/lucid');
const { toCard } = await import('../src/engine/card');
const { checkPlainWarning } = await import('../src/engine/plainCheck');
const { renderCardHtml } = await import('../src/ui/cardHtml');
const { callModel } = await import('../src/engine/model');

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'risky-commits', name), 'utf8');
const RLS_OFF = fixture('risky-01-rls-disabled.diff');
const RLS_FILE = 'supabase/migrations/20261030090000_profiles_open.sql';
const files = filterDiff(parseDiff(RLS_OFF)).files;

const riskPick = {
  kind: 'risk',
  concept: 'row-level-security',
  category: 'data-exposure',
  severity: 'high',
  why: 'Turns row level security off for the profiles table.',
  evidence: [{ file: RLS_FILE, line: 2, status: 'added', code: 'alter table public.profiles disable row level security;' }],
};

const warning = (over: object = {}) => ({
  title: 'This change turns off the lock on your profiles table',
  whatCouldHappen: 'With the lock off, the database could stop checking who asks for each profile. Anyone using your app may be able to read every profile.',
  whoIsAffected: 'Everyone who has a profile in your app.',
  quotes: [{ file: RLS_FILE, line: 2, role: 'shows', code: 'alter table public.profiles disable row level security;', note: 'Turns the lock off.' }],
  plainWords: 'Stop checking who may see each row in the profiles table.',
  fixPrompt: `In ${RLS_FILE}, remove line 2 and add a migration that enables row level security on public.profiles with owner-only policies (auth.uid() = id).`,
  ideaBehindIt: 'Your database can check every row before it hands it over. It works like a hotel key card that opens only your own room.',
  ...over,
});

const verdict = (over: object = {}) => JSON.stringify({ riskShown: true, wrongClaims: [], severity: 'high', fixPromptOk: true, fixProblem: '', ...over });

const asPick = (p: object) => ({ ...p, teach: true }) as unknown as Parameters<typeof writeWarning>[2];

beforeEach(() => {
  answers.length = 0;
  vi.mocked(callModel).mockClear();
});

describe('the picker decides the kind', () => {
  it('accepts a risk with its category and severity, and sees the signals', async () => {
    answers.push(JSON.stringify(riskPick));
    const r = await pickConcept(files, null, 'baseten');
    expect(r.pick).toMatchObject({ kind: 'risk', teach: true, category: 'data-exposure', severity: 'high' });
    const sent = vi.mocked(callModel).mock.calls[0]![1].user;
    expect(sent).toContain('RISK HINTS');
    expect(sent).toContain(`[rls-disabled, data-exposure] ${RLS_FILE} line 2 (added)`);
  });

  it('sends a risk without severity back', async () => {
    answers.push(JSON.stringify({ ...riskPick, severity: null }), JSON.stringify(riskPick));
    const r = await pickConcept(files, null, 'baseten');
    expect(r.attempts[0]!.problems[0]).toMatch(/give its "category" and "severity"/);
    expect(r.pick?.severity).toBe('high');
  });

  it('still reads the older shape ("teach")', async () => {
    answers.push(JSON.stringify({ teach: false, concept: 'none', why: 'Nothing.', evidence: [] }));
    expect((await pickConcept(files, null, 'baseten')).pick).toMatchObject({ kind: 'none', teach: false });
  });
});

describe('writeWarning', () => {
  it('passes a real row level security removal', async () => {
    answers.push(JSON.stringify(warning()), verdict());
    const r = await writeWarning(files, null, asPick(riskPick), null, 'meta', 'baseten');
    expect(r.warning?.title).toBe('This change turns off the lock on your profiles table');
    expect(r.warning?.evidence).toBe('warning');
    expect(r.review?.passed).toBe(true);
    // The fact checker read the BEFORE/AFTER and the warning, with its own prompt.
    const review = vi.mocked(callModel).mock.calls[1]![1];
    expect(review.system).toContain('False when the warning relies on guesses about code that is not shown');
    expect(review.user).toContain('THE WARNING');
  });

  it('drops a risk that depends on code the change does not show, without a retry', async () => {
    const unseen = verdict({ riskShown: false, wrongClaims: ['The title says the profiles page has no sign-in check, but this change never touches sign-in.'] });
    answers.push(JSON.stringify(warning({ title: 'Your profiles page may skip its sign-in check' })), unseen);
    const r = await writeWarning(files, null, asPick(riskPick), null, 'meta', 'baseten');
    expect(r.warning).toBeNull();
    expect(r.review?.riskShown).toBe(false);
    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2);
  });

  it('sends a wrong fix back once, and drops the warning if it is still wrong', async () => {
    const badFix = verdict({ fixPromptOk: false, fixProblem: 'It turns off a second lock instead of fixing this one.' });
    answers.push(JSON.stringify(warning()), badFix, JSON.stringify(warning()), badFix);
    const r = await writeWarning(files, null, asPick(riskPick), null, 'meta', 'baseten');
    expect(r.warning).toBeNull();
    const retry = vi.mocked(callModel).mock.calls[2]![1].user;
    expect(retry).toContain('fact check: the fix prompt is wrong or unsafe (It turns off a second lock instead of fixing this one)');
  });

  it('takes the fact checker’s severity', async () => {
    answers.push(JSON.stringify(warning()), verdict({ severity: 'medium' }));
    expect((await writeWarning(files, null, asPick(riskPick), null, 'meta', 'baseten')).severity).toBe('medium');
  });

  it('never lets a model mark a warning as proven', async () => {
    answers.push(JSON.stringify(warning({ evidence: 'proven' })), JSON.stringify(warning({ evidence: 'proven' })));
    const r = await writeWarning(files, null, asPick(riskPick), null, 'meta', 'baseten');
    expect(r.warning).toBeNull();
    expect(r.attempts[0]!.problems.join(' ')).toMatch(/evidence/);
  });

  it('drops a warning that still calls something safe after the retry', async () => {
    const safe = warning({ fixPrompt: 'Turn the lock back on so your profiles are safe again.' });
    answers.push(JSON.stringify(safe), JSON.stringify(safe));
    const r = await writeWarning(files, null, asPick(riskPick), null, 'meta', 'baseten');
    expect(r.warning).toBeNull();
    expect(r.attempts[0]!.problems).toContain('fixPrompt says "safe"; never call anything safe, secure or proven, only say what the change could do');
    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2); // no fact check for a card that cannot be shown
  });
});

describe('plain English on a warning', () => {
  it('wants possibilities, not facts', () => {
    const p = checkPlainWarning(warning({ whatCouldHappen: 'Everyone can read every profile now.' }) as never);
    expect(p.problems).toContain('whatCouldHappen says "Everyone can read every profile now." as a fact; phrase it as a possibility ("could", "may")');
  });

  it('lets the fix prompt use code words, but not the rest', () => {
    expect(checkPlainWarning(warning({ fixPrompt: 'Change the query in this function and the schema.' }) as never).passed).toBe(true);
    expect(checkPlainWarning(warning({ whoIsAffected: 'Anyone who calls this function.' }) as never).problems.join(' ')).toMatch(/whoIsAffected uses "function"/);
  });

  it('flags "secure" anywhere', () => {
    expect(checkPlainWarning(warning({ ideaBehindIt: 'This keeps your data secure. Like a lock.' }) as never).problems.join(' ')).toMatch(/ideaBehindIt says "secure"/);
  });
});

describe('the whole run', () => {
  it('turns a risky commit into a warning card', async () => {
    answers.push(JSON.stringify(riskPick), JSON.stringify(warning()), verdict());
    const report = await runLucid({ diffText: RLS_OFF, source: null, title: 'Fix dashboard', providers: { pick: 'baseten', write: 'meta' } });
    expect(report.outcome).toBe('warning');
    const card = toCard(report)!;
    expect(card).toMatchObject({ kind: 'risk', category: 'data-exposure', severity: 'high', evidence: 'warning', concept: 'row-level-security' });
    expect(card.keyLine).toMatchObject({ file: RLS_FILE, line: 2 });
  });

  it('does not write a card kind the caller cannot show', async () => {
    answers.push(JSON.stringify(riskPick));
    const report = await runLucid({ diffText: RLS_OFF, source: null, title: null, providers: { pick: 'baseten', write: 'meta' }, kinds: ['lesson'] });
    expect(report.outcome).toBe('not-wanted');
    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(1);
  });

  it('skips the writer for a lesson when lessons are off', async () => {
    const lessonPick = { kind: 'lesson', concept: 'row-level-security', why: 'x', evidence: riskPick.evidence };
    answers.push(JSON.stringify(lessonPick));
    const report = await runLucid({ diffText: RLS_OFF, source: null, title: null, providers: { pick: 'baseten', write: 'meta' }, kinds: ['risk'] });
    expect(report.outcome).toBe('not-wanted');
    expect(toCard(report)).toBeNull();
  });
});

describe('the warning card page', () => {
  const card = () => {
    answers.push(JSON.stringify(riskPick), JSON.stringify(warning({ title: 'This change turns off <b>the lock</b>' })), verdict());
    return runLucid({ diffText: RLS_OFF, source: null, title: null, providers: { pick: 'baseten', write: 'meta' } }).then((r) => toCard(r)!);
  };

  it('shows the warning label, severity, sections, Copy and the safety-net footer', async () => {
    const html = renderCardHtml(await card());
    expect(html).toContain('<span class="badge">Warning</span> <span class="severity">High</span>');
    expect(html).toContain('<main class="warning sev-high" data-evidence="warning">');
    for (const h of ['What could happen', 'Who’s affected', 'The line', 'Fix it with your AI', 'The idea behind it']) expect(html).toContain(`<h2>${h}</h2>`);
    expect(html).toContain('<button type="button" class="copy" data-copy="fix-prompt">Copy</button>');
    expect(html).toContain('Lucid flags risks it can see in this change. It’s a safety net, not a security audit.');
    expect(html).toContain('This change turns off &lt;b&gt;the lock&lt;/b&gt;');
    expect(html).not.toMatch(/Proven|Quick check/);
  });

  it('runs its Copy script under the webview policy', async () => {
    const html = renderCardHtml(await card(), { webview: { nonce: 'abcdef0123456789abcdef0123456789' } });
    expect(html).toContain("editor.postMessage({ type: 'copy-fix' })");
    expect(html).toMatch(/<script nonce="abcdef0123456789abcdef0123456789">/);
  });
});
