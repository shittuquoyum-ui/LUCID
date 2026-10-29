import { describe, expect, it } from 'vitest';
import { toCard } from '../src/engine/card';
import type { LucidReport } from '../src/engine/lucid';
import { renderComment } from '../src/engine/render';
import { timeLine } from '../src/terminal';
import { dedent, renderCardHtml } from '../src/ui/cardHtml';

const quote = {
  file: 'src/app.ts',
  line: 12,
  endLine: 12,
  role: 'shows' as const,
  code: 'return a < b && "<script>";',
  note: 'Compares two things.',
  link: 'https://github.com/o/r/blob/abc/src/app.ts#L12',
  changes: true,
};

const lesson = {
  title: 'Your <b>app</b> & you',
  story: ['First paragraph with `code<x>`.', 'Second paragraph.'],
  quotes: [quote],
  plainWords: 'compare the two "things".',
  question: 'What happens <next>?',
  options: { A: 'One', B: 'Two', C: 'Three' },
  answer: 'B' as const,
  feedback: { A: 'Not quite. One.', B: 'Right. Two.', C: 'Not quite. Three.' },
};

const report = {
  outcome: 'lesson',
  lesson,
  pick: { teach: true, concept: 'error-handling', why: 'x', evidence: [] },
  check: { verified: [quote], failed: [{ item: quote, reason: 'x' }] },
  plain: { passed: false, problems: ['x'] },
  review: { passed: true, claimsTrue: true, quizOk: true, problems: [] },
  timing: { pickMs: 8200, writeMs: 21500, reviewMs: 6000, totalMs: 36100 },
} as unknown as LucidReport;

describe('lesson card', () => {
  it('builds the card from a report', () => {
    const card = toCard(report)!;
    expect(card.keyLine).toEqual({ file: 'src/app.ts', line: 12, endLine: 12, code: quote.code, link: quote.link, plainWords: lesson.plainWords });
    expect(card.extraQuote).toBeUndefined();
    expect(card.checks).toEqual({
      quotesVerified: 1,
      quotesTotal: 2,
      plainEnglish: 'failed',
      review: 'passed',
      timeMs: { pick: 8200, write: 21500, review: 6000, total: 36100 },
    });
  });

  it('shows step times in the report, leaving out steps that did not run', () => {
    expect(timeLine(report.timing)).toBe('time: pick 8.2s, write 21.5s, review 6.0s, total 36.1s');
    expect(timeLine({ pickMs: 940, writeMs: null, reviewMs: null, totalMs: 1000 })).toBe('time: pick 0.9s, total 1.0s');
  });

  it('shows tokens next to each step time', () => {
    const usage = {
      pick: { calls: 1, input: 5200, output: 400, reasoning: 300 },
      write: { calls: 2, input: 14000, output: 9100, reasoning: 7000 },
      review: null,
    };
    expect(timeLine({ pickMs: 3500, writeMs: 50000, reviewMs: null, totalMs: 53500 }, usage)).toBe(
      'time: pick 3.5s (5.2k in, 400 out, 300 reasoning), write 50.0s (14.0k in, 9.1k out, 7.0k reasoning), total 53.5s (19.2k in, 9.5k out, 7.3k reasoning)',
    );
  });

  it('has no card without a lesson', () => {
    expect(toCard({ ...report, lesson: null })).toBeNull();
  });

  it('escapes all card text in the HTML page', () => {
    const html = renderCardHtml(toCard(report)!);
    expect(html).not.toContain('<b>app</b>');
    expect(html).not.toContain('"<script>"');
    expect(html).toContain('Your &lt;b&gt;app&lt;/b&gt; &amp; you');
    expect(html).toContain('<code>code&lt;x&gt;</code>');
    expect(html).toContain('data-answer="B"');
    expect(html).not.toMatch(/<(link|img)\b|src="http/);
  });

  it('starts quoted code at the left edge of the box', () => {
    expect(dedent('        if (a) {\n          b();\n        }')).toBe('if (a) {\n  b();\n}');
  });

  it('renders the GitHub comment with the right answer marked', () => {
    const comment = renderComment(lesson, { concept: 'error-handling', lessonId: 'abc-error-handling' });
    expect(comment).toContain('**The line that does it** · [`src/app.ts` line 12]');
    expect(comment).toContain('✅ **B.** Right. Two.');
  });
});
