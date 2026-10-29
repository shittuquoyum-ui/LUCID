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
const { RECREATED_RULE_DIFF, RLS_DIFF } = await import('./fixtures');

const { files } = filterDiff(parseDiff(RLS_DIFF));

const goodPick = {
  teach: true,
  concept: 'row-level-security',
  why: 'Adds a policy so people only read their own notes.',
  evidence: [{ file: 'supabase/migrations/002_notes_rls.sql', line: 5, status: 'added', code: 'using (auth.uid() = user_id);' }],
};

const lesson = (quotes: object[], story = ['Before this change, anyone signed in could read every note in your app.', 'Now your database checks who owns each note first. Like a locker that only opens with its owner’s key.']) => ({
  title: 'Only the owner can read a note now',
  story,
  quotes,
  plainWords: 'only hand back notes whose owner is the person signed in.',
  question: 'A friend signs in and opens a link to your note. What do they see?',
  options: { A: 'Nothing, the note stays hidden', B: 'Your whole note', C: 'Only the note’s title' },
  answer: 'A',
  feedback: {
    A: 'Right. The note isn’t theirs, so it stays hidden.',
    B: 'Not quite. That was how it worked before.',
    C: 'Not quite. The whole note is hidden, title too.',
  },
});

const jargonStory = ['Your app now checks each object before showing it.', 'Like a bouncer at a door, it only lets the owner in.'];

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

describe('pickConcept with moved lines', () => {
  const moved = filterDiff(parseDiff(RECREATED_RULE_DIFF)).files;
  const recreated = {
    teach: true,
    concept: 'row-level-security',
    why: 'Anyone can now read every item.',
    evidence: [{ file: 'supabase/migrations/003_items.sql', line: 5, status: 'added', code: 'using (true);' }],
  };

  it('refuses a re-created rule as evidence of new behaviour', async () => {
    answers.push(JSON.stringify(recreated), JSON.stringify(recreated));
    const r = await pickConcept(moved, null, 'baseten');
    expect(r.pick).toBeNull();
    expect(r.attempts[0]!.problems.join(' ')).toMatch(/Quote at least one '\+' or '-' line/);
  });
});

/** A fact-check answer. */
const verdict = (over: object = {}) =>
  JSON.stringify({ claimsTrue: true, wrongClaims: [], quizAnsweredByStory: false, quizProblem: '', ...over });
const falseClaim = verdict({ claimsTrue: false, wrongClaims: ['The title says only the owner can read a note now, but that was already true before'] });
const quizGiveaway = verdict({ quizAnsweredByStory: true, quizProblem: 'Story paragraph 2 states the answer.' });

describe('writeLesson', () => {
  const pick = goodPick as Parameters<typeof writeLesson>[2];

  it('keeps verified quotes and drops invented ones', async () => {
    answers.push(JSON.stringify(lesson([realQuote, madeUpQuote])), verdict());
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson?.quotes).toHaveLength(1);
    expect(r.check?.failed).toHaveLength(1);
  });

  it('retries when every quote fails, telling the model why', async () => {
    answers.push(JSON.stringify(lesson([madeUpQuote])), JSON.stringify(lesson([realQuote])), verdict());
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson).not.toBeNull();
    expect(r.attempts[0]!.problems[0]).toMatch(/not in src\/lib\/notes.ts/);
  });

  it('returns no lesson rather than a wrong one', async () => {
    answers.push(JSON.stringify(lesson([madeUpQuote])), JSON.stringify(lesson([madeUpQuote])));
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson).toBeNull();
    expect(r.review).toBeNull();
  });

  it('passes a plain, fact-checked lesson on the first try', async () => {
    answers.push(JSON.stringify(lesson([realQuote])), verdict());
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.plain?.passed).toBe(true);
    expect(r.review?.passed).toBe(true);
    expect(r.attempts.map((a) => [a.step, a.provider])).toEqual([['write', 'meta'], ['review', 'baseten']]);
  });

  it('sends plain-English problems back once, then accepts the fix', async () => {
    answers.push(JSON.stringify(lesson([realQuote], jargonStory)), JSON.stringify(lesson([realQuote])), verdict());
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.attempts[0]!.problems).toContain('story paragraph 1 uses "object", say it in everyday words');
    expect(r.plain?.passed).toBe(true);
  });

  it('keeps a true lesson whose wording still fails after the retry, marked as failed', async () => {
    answers.push(JSON.stringify(lesson([realQuote], jargonStory)), JSON.stringify(lesson([realQuote], jargonStory)), verdict());
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson).not.toBeNull();
    expect(r.plain?.passed).toBe(false);
    expect(r.review?.passed).toBe(true);
  });

  it('needs at least one quote of a line the change added or removed', async () => {
    const context = { file: 'src/lib/notes.ts', line: 6, role: 'shows', code: 'return data;', note: 'Hands back the notes.' };
    answers.push(JSON.stringify(lesson([context])), JSON.stringify(lesson([context])));
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson).toBeNull();
    expect(r.attempts[0]!.problems.join(' ')).toMatch(/no quote includes a line this change added/);
  });

  it('sends false claims back to the writer, then accepts a true lesson', async () => {
    answers.push(JSON.stringify(lesson([realQuote])), falseClaim, JSON.stringify(lesson([realQuote])), verdict());
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson).not.toBeNull();
    expect(r.review?.passed).toBe(true);
    expect(r.attempts[1]).toMatchObject({ step: 'review', problems: [expect.stringMatching(/^fact check found a false claim: The title says/)] });
  });

  it('returns no lesson when the claims are still false after the retry', async () => {
    answers.push(JSON.stringify(lesson([realQuote])), falseClaim, JSON.stringify(lesson([realQuote])), falseClaim);
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson).toBeNull();
    expect(r.review?.claimsTrue).toBe(false);
  });

  it('keeps a true lesson whose quiz the story still answers, marked as failed', async () => {
    answers.push(JSON.stringify(lesson([realQuote])), quizGiveaway, JSON.stringify(lesson([realQuote])), quizGiveaway);
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson).not.toBeNull();
    expect(r.review).toMatchObject({ passed: false, claimsTrue: true, quizOk: false });
  });

  it('does not trust a "true" verdict that lists wrong claims', async () => {
    const mixed = verdict({ claimsTrue: true, wrongClaims: ['The story invents a sign-in step'] });
    answers.push(JSON.stringify(lesson([realQuote])), mixed, JSON.stringify(lesson([realQuote])), mixed);
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson).toBeNull();
  });

  it('asks the fact checker again when its answer is not valid JSON', async () => {
    answers.push(JSON.stringify(lesson([realQuote])), 'Looks good to me!', verdict());
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.review?.passed).toBe(true);
    expect(r.attempts.filter((a) => a.step === 'review')).toHaveLength(2);
  });

  it('counts a fact checker that never answers properly as a failed check', async () => {
    answers.push(JSON.stringify(lesson([realQuote])), 'nope', 'still nope', JSON.stringify(lesson([realQuote])), 'nope', 'nope');
    const r = await writeLesson(files, null, pick, null, 'meta', 'baseten');
    expect(r.lesson).toBeNull();
  });
});
