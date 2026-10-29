import { beforeEach, describe, expect, it, vi } from 'vitest';

// Script the model's answers so retries can be tested without any API.
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
const { pickConcept, writeLesson } = await import('../src/engine/steps');
const { RLS_DIFF } = await import('./fixtures');

const { files } = filterDiff(parseDiff(RLS_DIFF));

const goodPick = {
  teach: true,
  concept: 'row-level-security',
  why: 'Adds a policy so people only read their own notes.',
  evidence: [{ file: 'supabase/migrations/002_notes_rls.sql', line: 5, status: 'added', code: 'using (auth.uid() = user_id);' }],
};

const lesson = (quotes: object[]) => ({
  title: 'You just stopped strangers reading other people’s notes',
  explanation: 'Before this change any signed-in user could read every note. Now the database itself checks who owns each row.',
  quotes,
  breaksIf: 'Without it, anyone with your public key could read every note.',
  question: 'If you deleted line 5, who could read a note?',
  options: { A: 'Only its owner', B: 'No one', C: 'Anyone signed in' },
  answer: 'B',
  answerWhy: 'Row-level security is still on, and with no policy it allows nothing.',
});

const realQuote = { file: 'supabase/migrations/002_notes_rls.sql', line: 5, role: 'shows', code: 'using (auth.uid() = user_id);', note: 'Only the owner matches.' };
const madeUpQuote = { file: 'src/lib/notes.ts', line: 3, role: 'shows', code: 'await checkOwnership(user);', note: 'Invented.' };

beforeEach(() => {
  answers.length = 0;
});

describe('pickConcept', () => {
  it('accepts a valid pick on the first try', async () => {
    answers.push(JSON.stringify(goodPick));
    const r = await pickConcept(files, null, 'meta');
    expect(r.pick?.concept).toBe('row-level-security');
    expect(r.attempts).toHaveLength(1);
  });

  it('retries once after invalid JSON, then succeeds', async () => {
    answers.push('Sure! Here is my answer: {not json', '```json\n' + JSON.stringify(goodPick) + '\n```');
    const r = await pickConcept(files, null, 'meta');
    expect(r.pick?.concept).toBe('row-level-security');
    expect(r.attempts[0]!.problems[0]).toMatch(/Invalid JSON/);
  });

  it('rejects invented concept ids', async () => {
    answers.push(JSON.stringify({ ...goodPick, concept: 'blockchain' }), JSON.stringify({ ...goodPick, concept: 'blockchain' }));
    const r = await pickConcept(files, null, 'meta');
    expect(r.pick).toBeNull();
  });

  it('respects "nothing to teach"', async () => {
    answers.push(JSON.stringify({ teach: false, concept: 'none', why: 'Only a version bump.', evidence: [] }));
    const r = await pickConcept(files, null, 'meta');
    expect(r.pick?.teach).toBe(false);
  });

  it('gives up after two answers with evidence that is not in the diff', async () => {
    const bad = { ...goodPick, evidence: [{ ...goodPick.evidence[0], code: 'grant all on notes to anon;' }] };
    answers.push(JSON.stringify(bad), JSON.stringify(bad));
    const r = await pickConcept(files, null, 'meta');
    expect(r.pick).toBeNull();
    expect(r.attempts).toHaveLength(2);
  });
});

describe('writeLesson', () => {
  const pick = goodPick as Parameters<typeof writeLesson>[2];

  it('keeps verified quotes and drops invented ones', async () => {
    answers.push(JSON.stringify(lesson([realQuote, madeUpQuote])));
    const r = await writeLesson(files, null, pick, null, 'meta');
    expect(r.lesson?.quotes).toHaveLength(1);
    expect(r.check?.failed).toHaveLength(1);
  });

  it('retries when every quote fails, telling the model why', async () => {
    answers.push(JSON.stringify(lesson([madeUpQuote])), JSON.stringify(lesson([realQuote])));
    const r = await writeLesson(files, null, pick, null, 'meta');
    expect(r.lesson).not.toBeNull();
    expect(r.attempts[0]!.problems[0]).toMatch(/not in src\/lib\/notes.ts/);
  });

  it('returns no lesson rather than a wrong one', async () => {
    answers.push(JSON.stringify(lesson([madeUpQuote])), JSON.stringify(lesson([madeUpQuote])));
    const r = await writeLesson(files, null, pick, null, 'meta');
    expect(r.lesson).toBeNull();
  });
});
