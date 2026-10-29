import { describe, expect, it } from 'vitest';
import { checkPlainEnglish } from '../src/engine/plainCheck';
import type { Lesson } from '../src/engine/schemas';

/** The target example from the writeLesson prompt (commit fe424de). */
const GOLD: Lesson = {
  title: 'Your form notes now have a backup message',
  story: [
    'When people fill in a form wrong, your app shows them a short note telling them what to fix.',
    'Sometimes that note came through empty. People saw `email:` and nothing after it, so they had no idea what to fix.',
    "Now there's a backup. If the note is empty, your app shows `Validation failed` instead. Like a phone's voicemail: if you never recorded a greeting, it plays a default one.",
  ],
  quotes: [
    {
      file: 'apps/web/src/utils/effect-bridge.ts',
      line: 112,
      role: 'shows',
      code: "return `${error.field}: ${error.message || 'Validation failed'}`;",
      note: 'Uses a backup note when the real one is empty.',
    },
  ],
  plainWords: "Show the box's name and its note. If the note is empty, show 'Validation failed' instead.",
  question: 'Someone types a password that\'s too short. The message is "Too short". What do they see?',
  options: { A: 'password: Too short', B: 'password: Validation failed', C: 'password: (nothing)' },
  answer: 'A',
  feedback: {
    A: 'Right. The backup only kicks in when the message is empty.',
    B: 'Not quite. "Too short" isn\'t empty, so the backup isn\'t used.',
    C: 'Not quite. That was the old bug, and only for empty messages.',
  },
};

/** The changed lines of commit fe424de's diff that matter here. */
const CHANGED = [
  "        return `${error.field}: ${error.message || 'Validation failed'}`;",
  "    getErrorMessage(new ValidationError({ field: 'email', message: '' }))",
  "  ).toBe('email: Validation failed');",
];

const problemsFor = (change: Partial<Lesson>, changed = CHANGED): string[] => checkPlainEnglish({ ...GOLD, ...change }, changed).problems;

describe('checkPlainEnglish', () => {
  it('passes the gold example', () => {
    expect(checkPlainEnglish(GOLD, CHANGED)).toEqual({ passed: true, problems: [] });
  });

  it('flags developer words, whole word and any case, naming the field', () => {
    const story = [GOLD.story[0]!, 'Your app passed an Object to the next step.', GOLD.story[2]!];
    expect(problemsFor({ story })).toEqual(['story paragraph 2 uses "Object", say it in everyday words']);
    expect(problemsFor({ question: 'What does the API send back?' })).toEqual(['question uses "API", say it in everyday words']);
    expect(problemsFor({ title: 'Your app has better error handling now' })).toEqual(['title uses "error handling", say it in everyday words']);
  });

  it('flags "field" and suggests "box"', () => {
    expect(problemsFor({ question: 'Someone leaves the email field empty. What do they see?' })).toEqual([
      'question uses "field", say it in everyday words (try "box")',
    ]);
  });

  it('flags plainWords over 25 words', () => {
    const plainWords = 'Show the name of the box and the note that goes with it. When that note has nothing in it at all, show a backup note instead.';
    expect(problemsFor({ plainWords })).toEqual(['plainWords has 27 words; say it in 25 words or fewer']);
  });

  it('flags plainWords with more than two sentences', () => {
    expect(problemsFor({ plainWords: 'Show the name. Then the note. Or a backup.' })).toEqual([
      'plainWords has 3 sentences; use one or two normal sentences',
    ]);
  });

  it('flags words glued with hyphens in plainWords, but not ordinary pairs', () => {
    expect(problemsFor({ plainWords: "Show the note, or-if-empty use 'Validation failed'." })).toEqual([
      'plainWords glues words with hyphens ("or-if-empty"); write them as a normal sentence',
    ]);
    expect(problemsFor({ plainWords: 'Show the note on the sign-in page.' })).toEqual([]);
  });

  it('does not flag words that only contain a developer word', () => {
    expect(problemsFor({ question: 'Someone types a short password. What do they see?' })).toEqual([]);
  });

  it('ignores anything inside backticks', () => {
    expect(problemsFor({ plainWords: 'the `function` part runs the `getErrorMessage` step, then shows the note.' })).toEqual([]);
  });

  it('allows words the app itself shows on screen, when the change contains them', () => {
    // 'Validation failed' is quoted text in the changed lines, so it is what users see.
    expect(problemsFor({ options: { ...GOLD.options, C: 'Validation failed' } })).toEqual([]);
    expect(problemsFor({ question: 'The note says "validation failed". What went wrong?' })).toEqual([]);
  });

  it('still flags jargon in quotes when the change does not contain that text', () => {
    expect(problemsFor({ plainWords: "show the 'object' that came back, or a backup note." })).toEqual([
      'plainWords uses "object", say it in everyday words',
    ]);
    expect(problemsFor({ question: 'The note says "object missing". What do they see?' })).toEqual([
      'question uses "object", say it in everyday words',
    ]);
  });

  it('gives no on-screen exemption without the changed lines', () => {
    expect(problemsFor({}, [])).toContain('option B uses "Validation", say it in everyday words');
  });

  it('flags camelCase and PascalCase code names outside backticks', () => {
    expect(problemsFor({ feedback: { ...GOLD.feedback, B: 'Not quite. getErrorMessage keeps the box name.' } })).toEqual([
      'feedback B uses the code name "getErrorMessage"; put it in backticks and say what it does in everyday words',
    ]);
    expect(problemsFor({ options: { ...GOLD.options, C: 'A ValidationError appears' } })).toEqual([
      'option C uses the code name "ValidationError"; put it in backticks and say what it does in everyday words',
    ]);
  });

  it('flags sentences over 20 words', () => {
    const long = 'When someone fills in a form wrong your app now shows a short and friendly note that tells them exactly what they need to fix.';
    const problems = problemsFor({ story: [long, GOLD.story[1]!] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^story paragraph 1 has a sentence of 25 words \("When someone fills in a form…"\)/);
  });

  it('flags a story with more than 4 paragraphs', () => {
    const story = ['One.', 'Two.', 'Three.', 'Four.', 'Five.'];
    expect(problemsFor({ story })).toEqual(['story has 5 paragraphs; use 2 to 4']);
  });

  it('flags a paragraph with more than 3 sentences', () => {
    const story = [GOLD.story[0]!, 'It was empty. People were lost. They gave up. Now it is fixed.'];
    expect(problemsFor({ story })).toEqual(['story paragraph 2 has 4 sentences; use 3 or fewer']);
  });

  it('flags a title over 60 characters', () => {
    const title = 'Your app never shows a blank note when someone fills in a form wrong';
    expect(problemsFor({ title })).toEqual([`title is ${title.length} characters; make it 60 or fewer`]);
  });

  it('flags a quiz whose right answer is printed in the story', () => {
    const question = 'What do people see now when the note is empty?';
    const options = { A: 'a short note telling them what to fix', B: 'nothing', C: 'an empty page' };
    expect(problemsFor({ question, options })).toEqual([
      'the right answer (A) appears word for word in the story; ask about a new situation the story does not already answer',
    ]);
  });

  it('flags "that\'s called" and "this is called"', () => {
    expect(problemsFor({ plainWords: "use a backup note (that's called a fallback)." })).toEqual([
      'plainWords says "that\'s called"; drop the name and just explain the idea',
    ]);
    expect(problemsFor({ feedback: { ...GOLD.feedback, A: 'Right. This is called a default.' } })).toEqual([
      'feedback A says "This is called"; drop the name and just explain the idea',
    ]);
  });
});
