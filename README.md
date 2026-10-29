# Lucid

**You shipped it. Now see it.**

Lucid is for people who build apps with AI tools ("vibe coders") and have never read code. When you commit, a lesson card pops up beside your code. It explains, in plain words, what that change does in your app, shows you the one line that does it, and ends with a quick A/B/C check you can click.

Lucid is becoming a VS Code extension (it also works in Cursor and Windsurf). This repository holds the engine that writes and checks the cards. The extension comes next.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). Everything in this repository was written during the event.

## How it works

```
a commit or pull request diff
  → filter        drop .env files, lockfiles, build output, binaries; hide secret-looking lines
  → pick          Muse Spark Open (Baseten): is this worth a lesson? which ONE idea?
  → write         Muse Spark 1.3 (Meta Model API): a plain-English lesson card + one A/B/C question
  → check quotes  plain code: every quote must exist in the diff, with the right status
  → check words   plain code: no developer words, no code names, short sentences, a quiz that doesn't give itself away
  → card          title, story, the line that does it, "in plain words", quick check
```

**The quote checker is the core.** A quote about how the app works *now* may only use added or unchanged lines; a removed line can never prove current behaviour. Quotes that fail are dropped, the model gets one retry with the exact problems, and if nothing can be verified there is no lesson. No lesson beats a wrong one.

**The plain-English checker keeps it readable.** It flags words like "function", "object" or "validation", code names like `getErrorMessage`, sentences over 20 words, long stories, and quiz answers copied from the story. Its problems join the same single retry. If the quotes are true but the wording still fails, the lesson is kept and marked as failed in the report.

## The lesson card

```
WHAT THIS CHANGE DOES
Your app never shows a blank error now

  2–4 short paragraphs about what changed for the people using your app

THE LINE THAT DOES IT  ·  apps/web/src/utils/effect-bridge.ts line 112
  return `${error.field}: ${error.message || 'Validation failed'}`;
In plain words: use the message, or if it's empty, use 'Validation failed'.

QUICK CHECK  ·  [A] [B] [C]  → green or red, with one line of feedback

Every quote is checked against your code · Lucid stores nothing
```

## What Lucid sends, and what it keeps

- **Sends:** the changed lines of up to 5 files from the change, after the filter above.
- **Never sends:** `.env` files, key files, lockfiles, build output, binaries, or lines that look like keys or tokens.
- **Keeps:** nothing. No database.
- **Models:** Meta's standard mode only, never Contributor mode, so your code is not used for training.
- Secret filtering is a precaution, not a guarantee. Don't commit secrets.
- Lucid explains what your change says. It doesn't run your code, so it can't tell you whether the code works.

## Run it locally

```bash
npm install
cp .env.example .env          # add your keys; .env is git-ignored

# Fake model: no keys, no cost. Tests the whole pipeline.
npm run -s lesson -- path/to/change.diff --provider fake
git diff main | npm run -s lesson -- - --provider fake

# Real models
npm run -s lesson -- https://github.com/owner/repo/pull/12 --pick baseten --write meta

# The card as JSON (what the extension will show)
npm run -s lesson -- https://github.com/owner/repo/commit/abc1234 --pick baseten --write meta --card

# The card as a page in your browser: writes samples/preview.html and prints its path
npm run -s preview -- https://github.com/owner/repo/commit/abc1234 --pick baseten --write meta
```

The lesson (or card) prints to stdout; a report of what was sent, skipped and checked prints to stderr. Use `-s` so npm's own banner stays out of the output.

## Run the extension

Works in VS Code and Cursor.

```bash
cd extension
npm install
npm run build        # bundles the extension and the engine into extension/dist
```

1. Open this repository in VS Code and press **F5** ("Run Lucid extension"). A second window opens: the Extension Development Host.
2. In that window, open the command palette and run **Lucid: Set API keys** (Meta, then Baseten). Keys go to the editor's secret storage, never to settings or files.
3. Open any git repository there, change something, and commit.
4. Keep working. When the lesson is ready, a toast appears: **Lucid: …** with **Show me**. The status bar shows what Lucid is doing.

`lucid.autoExplain` (default on) turns the automatic run off. **Lucid: Explain my last commit** runs it by hand. F5 rebuilds the extension first ("Build Lucid extension" task).

## Tests

```bash
npm test         # diff parsing, secret filter, quote checker, plain-English checker, card, retries
npm run typecheck
```

## Status

- [x] Engine: diff reader, filter, quote checker, schemas, prompts, retries, CLI
- [x] Plain-English lesson card: new lesson shape, plain-English checker, card JSON
- [x] Card page (HTML) with a clickable quick check, and `npm run preview`
- [x] VS Code extension (smallest version): lesson after each new commit, toast, card panel, keys in secret storage (VS Code and Cursor)
- [ ] Backend for the extension (model calls without keys on the builder's machine)
- [ ] Repo context: before writing, search the repository for related code (e.g. other mentions of the same table) so lessons can say what a change backs up
- [ ] GitHub comment bot (renderer kept working with the new card layout)
- [ ] Quality testing with real builders
