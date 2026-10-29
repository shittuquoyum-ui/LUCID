/**
 * The lesson card as one self-contained HTML page: inline CSS, a tiny inline
 * script for the quick check, no external resources. Used by the preview now
 * and by the editor side panel later.
 *
 * Every piece of card text is escaped. Text in `backticks` is shown as code.
 */
import type { CardQuote, LessonCard } from '../engine/card';
import { lineLabel } from '../engine/render';

const LETTERS = ['A', 'B', 'C'] as const;

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/** Escape, then show `backticked` bits as inline code. */
const prose = (s: string): string => escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const where = (q: CardQuote): string => {
  const label = `${escapeHtml(q.file)} · ${lineLabel(q)}`;
  return q.link?.startsWith('https://')
    ? `<a href="${escapeHtml(q.link)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : `<span>${label}</span>`;
};

const codeBox = (q: CardQuote): string => `<pre class="code"><code>${escapeHtml(q.code)}</code></pre>`;

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --surface: #f6f8fa; --text: #1f2328; --muted: #59636e; --border: #d1d9e0;
  --accent: #0969da; --right: #1a7f37; --right-bg: #dafbe1; --wrong: #cf222e; --wrong-bg: #ffebe9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --surface: #151b23; --text: #e6edf3; --muted: #9198a1; --border: #3d444d;
    --accent: #4493f8; --right: #3fb950; --right-bg: rgba(46, 160, 67, 0.15); --wrong: #f85149; --wrong-bg: rgba(248, 81, 73, 0.15);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 640px; margin: 0 auto; }
.label { margin: 0 0 4px; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
h1 { margin: 0 0 16px; font-size: 24px; line-height: 1.3; }
h2 { margin: 28px 0 8px; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
p { margin: 0 0 12px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.where { font-size: 14px; margin-bottom: 6px; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
pre.code { margin: 0 0 12px; padding: 12px 14px; overflow-x: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
pre.code code { background: none; border: 0; padding: 0; font-size: 14px; white-space: pre; }
.plain { padding: 10px 14px; border-left: 3px solid var(--accent); background: var(--surface); border-radius: 0 8px 8px 0; }
.options { display: grid; gap: 8px; margin: 12px 0; }
.opt {
  display: flex; gap: 10px; align-items: baseline; width: 100%; padding: 10px 14px; text-align: left; cursor: pointer;
  font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
}
.opt:hover { border-color: var(--accent); }
.opt:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.opt b { flex: none; }
.opt.right { border-color: var(--right); background: var(--right-bg); }
.opt.wrong { border-color: var(--wrong); background: var(--wrong-bg); }
.fb { margin: 0; font-weight: 500; }
.fb.right { color: var(--right); }
.fb.wrong { color: var(--wrong); }
footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); }
`;

const SCRIPT = `
document.querySelectorAll('.quiz').forEach(function (quiz) {
  var answer = quiz.getAttribute('data-answer');
  quiz.querySelectorAll('.opt').forEach(function (button) {
    button.addEventListener('click', function () {
      var letter = button.getAttribute('data-letter');
      var right = letter === answer;
      quiz.querySelectorAll('.opt').forEach(function (b) { b.classList.remove('right', 'wrong'); b.setAttribute('aria-pressed', 'false'); });
      button.classList.add(right ? 'right' : 'wrong');
      button.setAttribute('aria-pressed', 'true');
      quiz.querySelectorAll('.fb').forEach(function (f) {
        f.hidden = f.getAttribute('data-letter') !== letter;
        f.className = 'fb ' + (right ? 'right' : 'wrong');
      });
    });
  });
});
`;

export const renderCardHtml = (card: LessonCard): string => {
  const extra = card.extraQuote
    ? `
    <h2>Also in this change</h2>
    <div class="where">${where(card.extraQuote)}${card.extraQuote.removed ? ' (taken out)' : ''}</div>
    ${codeBox(card.extraQuote)}
    <p>${prose(card.extraQuote.note)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lucid · ${escapeHtml(card.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <p class="label">What this change does</p>
  <h1>${prose(card.title)}</h1>
  ${card.story.map((p) => `<p>${prose(p)}</p>`).join('\n  ')}

  <h2>The line that does it</h2>
  <div class="where">${where(card.keyLine)}</div>
  ${codeBox(card.keyLine)}
  <p class="plain"><strong>In plain words:</strong> ${prose(card.keyLine.plainWords)}</p>
  ${extra}

  <h2>Quick check</h2>
  <section class="quiz" data-answer="${escapeHtml(card.answer)}">
    <p>${prose(card.question)}</p>
    <div class="options">
      ${LETTERS.map((l) => `<button type="button" class="opt" data-letter="${l}" aria-pressed="false"><b>${l}</b><span>${prose(card.options[l])}</span></button>`).join('\n      ')}
    </div>
    <div aria-live="polite">
      ${LETTERS.map((l) => `<p class="fb" data-letter="${l}" hidden>${prose(card.feedback[l])}</p>`).join('\n      ')}
    </div>
  </section>

  <footer>Every quote is checked against your code · Lucid stores nothing</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
};
