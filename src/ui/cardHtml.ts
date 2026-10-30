/**
 * The card (a lesson or a warning) as one self-contained HTML page: inline
 * CSS, a tiny inline script for the quick check and the Copy button, no
 * external resources. Used by the browser
 * preview and by the editor side panel.
 *
 * In webview mode the page carries a strict Content Security Policy (only
 * the nonce-tagged style and script may run) and takes its colours from the
 * editor theme instead of its own light/dark palette.
 *
 * Every piece of card text is escaped. Text in `backticks` is shown as code.
 */
import type { Card, CardQuote, LessonCard, ProofView, WarningCard } from '../engine/card';
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

/** Drop the indent the lines share, so quoted code starts at the box's left edge. */
export const dedent = (code: string): string => {
  const lines = code.replace(/\t/g, '  ').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(common)).join('\n');
};

const codeBox = (q: CardQuote): string => `<pre class="code"><code>${escapeHtml(dedent(q.code))}</code></pre>`;

/** Colours for the browser preview: its own palette, light and dark. */
const PAGE_TOKENS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --surface: #f6f8fa; --text: #1f2328; --muted: #59636e; --border: #d1d9e0;
  --accent: #0969da; --right: #1a7f37; --right-bg: #dafbe1; --wrong: #cf222e; --wrong-bg: #ffebe9;
  --amber: #9a6700; --amber-bg: #fff8c5; --red: #cf222e; --red-bg: #ffebe9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --surface: #151b23; --text: #e6edf3; --muted: #9198a1; --border: #3d444d;
    --accent: #4493f8; --right: #3fb950; --right-bg: rgba(46, 160, 67, 0.15); --wrong: #f85149; --wrong-bg: rgba(248, 81, 73, 0.15);
    --amber: #d29922; --amber-bg: rgba(187, 128, 9, 0.15); --red: #f85149; --red-bg: rgba(248, 81, 73, 0.15);
  }
}
`;

/** Colours for the editor panel: whatever theme the editor uses. */
const WEBVIEW_TOKENS = `
:root {
  --bg: var(--vscode-editor-background); --surface: var(--vscode-textCodeBlock-background);
  --text: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground);
  --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  --accent: var(--vscode-textLink-foreground);
  --right: var(--vscode-testing-iconPassed); --right-bg: color-mix(in srgb, var(--vscode-testing-iconPassed) 15%, transparent);
  --wrong: var(--vscode-testing-iconFailed); --wrong-bg: color-mix(in srgb, var(--vscode-testing-iconFailed) 15%, transparent);
  --amber: var(--vscode-editorWarning-foreground); --amber-bg: color-mix(in srgb, var(--vscode-editorWarning-foreground) 15%, transparent);
  --red: var(--vscode-editorError-foreground); --red-bg: color-mix(in srgb, var(--vscode-editorError-foreground) 15%, transparent);
}
body { font-family: var(--vscode-font-family); }
code, pre.code code { font-family: var(--vscode-editor-font-family); }
`;

const CSS = `
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
pre.code {
  margin: 0 0 12px; padding: 12px 14px; max-width: 100%; overflow-x: auto; text-align: left;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
}
pre.code code { display: block; width: max-content; min-width: 100%; background: none; border: 0; padding: 0; font-size: 14px; white-space: pre; }
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
/* Warning cards: amber, red when the severity is high. */
main.warning { --sev: var(--amber); --sev-bg: var(--amber-bg); border-left: 4px solid var(--sev); padding-left: 16px; }
main.warning.sev-high { --sev: var(--red); --sev-bg: var(--red-bg); }
main.warning .plain { border-left-color: var(--sev); }
.head { display: flex; gap: 8px; align-items: center; }
.badge { padding: 2px 8px; border-radius: 999px; color: var(--sev); background: var(--sev-bg); border: 1px solid var(--sev); }
.severity { color: var(--sev); }
.detected { margin: 0 0 6px; font-size: 14px; color: var(--muted); }
main.proven .badge { color: var(--bg); background: var(--sev); }
.evidence { margin: 0 0 8px; padding: 4px 14px 2px; border: 1px solid var(--sev); border-radius: 8px; background: var(--sev-bg); }
.evidence h2 { margin-top: 10px; }
.statement { font-size: 13px; color: var(--muted); }
.proof-note { font-size: 14px; color: var(--muted); }
pre.fix code { white-space: pre-wrap; width: auto; }
.copy-row { display: flex; gap: 10px; align-items: center; }
.copy { font: inherit; font-size: 14px; padding: 6px 14px; cursor: pointer; color: var(--bg); background: var(--sev, var(--accent)); border: 0; border-radius: 6px; }
.copy:focus-visible { outline: 2px solid var(--sev); outline-offset: 2px; }
.copied { font-size: 14px; color: var(--muted); }
`;

// Copy: in the editor the panel asks the extension (which copies its own copy
// of the fix prompt and answers "copied"); in a browser it uses the clipboard.
const SCRIPT = `
var editor = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
var showCopied = function () {
  document.querySelectorAll('.copied').forEach(function (s) {
    s.textContent = 'Copied';
    setTimeout(function () { s.textContent = ''; }, 2500);
  });
};
document.querySelectorAll('[data-copy]').forEach(function (button) {
  button.addEventListener('click', function () {
    if (editor) return editor.postMessage({ type: 'copy-fix' });
    var text = document.getElementById(button.getAttribute('data-copy')).textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(showCopied);
  });
});
window.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'copied') showCopied();
});
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

export interface CardHtmlOptions {
  /** Render for an editor webview: strict CSP and theme colours. The nonce must be fresh per render. */
  webview?: { nonce: string };
}

const extraBox = (card: Card): string =>
  card.extraQuote
    ? `
    <h2>Also in this change</h2>
    <div class="where">${where(card.extraQuote)}${card.extraQuote.removed ? ' (taken out)' : ''}</div>
    ${codeBox(card.extraQuote)}
    <p>${prose(card.extraQuote.note)}</p>`
    : '';

export const renderCardHtml = (card: Card, options: CardHtmlOptions = {}): string => {
  const nonce = options.webview?.nonce;
  if (nonce !== undefined && !/^[A-Za-z0-9_-]{16,}$/.test(nonce)) throw new Error('the webview nonce must be 16+ letters, digits, "-" or "_"');
  const tag = nonce ? ` nonce="${nonce}"` : '';
  const csp = nonce
    ? `\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">${csp}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lucid · ${escapeHtml(card.title)}</title>
<style${tag}>${CSS}${nonce ? WEBVIEW_TOKENS : PAGE_TOKENS}</style>
</head>
<body>
${card.kind === 'risk' ? warningBody(card) : lessonBody(card)}
<script${tag}>${SCRIPT}</script>
</body>
</html>
`;
};

const SEVERITY_LABEL: Record<WarningCard['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' };

/**
 * The warning card. The head holds one label per kind of evidence:
 * "Warning", or "Proven" once the sandbox prover reproduced the leak (only
 * applyProof sets that). A proven card adds an evidence block under the
 * title: what happened to the fake users, the exact query, and what a proof
 * means. A warning the prover could not reproduce gets one quiet line.
 */
const warningBody = (card: WarningCard): string => {
  const proven = card.evidence === 'proven' && card.proof;
  return `<main class="warning sev-${card.severity}${proven ? ' proven' : ''}" data-evidence="${escapeHtml(card.evidence)}">
  <p class="label head"><span class="badge">${proven ? 'Proven' : 'Warning'}</span> <span class="severity">${SEVERITY_LABEL[card.severity]}</span></p>
  <p class="detected">${proven ? 'Reproduced with fake users in a disposable sandbox' : 'Potential risk detected'}</p>
  <h1>${prose(card.title)}</h1>
  ${proven ? evidenceBlock(card.proof!) : ''}${card.proofNote ? `<p class="proof-note">${prose(card.proofNote)}</p>` : ''}

  <h2>What could happen</h2>
  <p>${prose(card.whatCouldHappen)}</p>

  <h2>Who’s affected</h2>
  <p>${prose(card.whoIsAffected)}</p>

  <h2>The line</h2>
  <div class="where">${where(card.keyLine)}</div>
  ${codeBox(card.keyLine)}
  <p class="plain"><strong>In plain words:</strong> ${prose(card.keyLine.plainWords)}</p>
  ${extraBox(card)}

  <h2>Fix it with your AI</h2>
  <p>Paste this into Cursor, Claude Code, Lovable or whichever AI tool you build with.</p>
  <pre class="code fix"><code id="fix-prompt">${escapeHtml(card.fixPrompt)}</code></pre>
  <p class="copy-row"><button type="button" class="copy" data-copy="fix-prompt">Copy</button> <span class="copied" aria-live="polite"></span></p>

  <h2>The idea behind it</h2>
  <p>${prose(card.ideaBehindIt)}</p>

  <footer>Lucid flags risks it can see in this change. It’s a safety net, not a security audit.</footer>
</main>`;
};

/** What the prover did and saw: the plain sentence, the exact query, and what a proof means. */
const evidenceBlock = (proof: ProofView): string => `<section class="evidence">
    <h2>What Lucid reproduced</h2>
    <p>${prose(proof.sentence)}</p>
    <pre class="code"><code>${escapeHtml(proof.query)}</code></pre>
    <p class="statement">${prose(proof.statement)}</p>
  </section>`;

const lessonBody = (card: LessonCard): string => `<main>
  <p class="label">What this change does</p>
  <h1>${prose(card.title)}</h1>
  ${card.story.map((p) => `<p>${prose(p)}</p>`).join('\n  ')}

  <h2>The line that does it</h2>
  <div class="where">${where(card.keyLine)}</div>
  ${codeBox(card.keyLine)}
  <p class="plain"><strong>In plain words:</strong> ${prose(card.keyLine.plainWords)}</p>
  ${extraBox(card)}

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
</main>`;
