# Lucid

**Lucid proves database leaks before you ship them, and teaches you why they happen.**

Lucid is for people who build apps with AI tools ("vibe coders") and have never read code. When you commit, Lucid reads the change in the background:

- **A risky change gets a warning card**: what could happen, who is affected, the line that does it, a fix you can paste into your AI tool, and the idea behind the risk. Risks always come first.
- **A safe but interesting change gets a lesson card**: what the change does in your app, the one line that does it, and a quick A/B/C check.

Today warnings come from reading the change; the sandbox prover that tries the leak for real comes next (see [docs/prover-plan.md](docs/prover-plan.md)). Until then no card says "proven", and Lucid never says a change is safe.

Lucid is a VS Code extension (built for Cursor too). This repository holds the extension, the engine that writes and checks the cards, and the small server that runs it.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). Everything in this repository was written during the event.

## Install

1. Download **`lucid.vsix`** from the [latest release](https://github.com/shittuquoyum-ui/LUCID/releases/latest).
2. In VS Code: open the Extensions view, click the **`…`** menu, choose **Install from VSIX…** and pick the file. (Or run `code --install-extension lucid.vsix`.)
3. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Lucid: Sign in with GitHub**.
4. Open any project that uses git, change something, commit, and keep working. In about 20–60 seconds a notification appears: **⚠️ Lucid: …** for a risky change, **Lucid: …** for a lesson → **Show me**.

No API keys needed: lessons are written on Lucid's server, 20 per GitHub user per day. Only a filtered copy of your change is sent (see [what Lucid sends](#what-lucid-sends-and-what-it-keeps)). In Cursor, if GitHub sign-in isn't available, run **Lucid: Set API keys** to use your own Meta and Baseten keys.

## How it works

```
a commit or pull request diff
  → filter        drop .env files, lockfiles, build output, binaries; hide secret-looking lines
  → signals       plain code: pattern checks for risks (RLS off, using (true), owner checks removed,
                  service_role or secrets in browser code, admin routes without a role check,
                  writes without an owner filter, unsigned webhooks, CORS *, dropped tables…)
  → pick          Muse Spark Open (Baseten): a risk, a lesson, or nothing? It confirms or rejects
                  each signal, and a risk must be visible in the diff itself
  → write         Muse Spark 1.3 (Meta Model API): a warning card, or a lesson card + A/B/C question
  → check quotes  plain code: every quote must exist in the diff, with the right status
  → check words   plain code: no developer words, short sentences; warnings say "could", never "safe"
  → fact check    Muse Spark Open: BEFORE vs AFTER. Warnings: is the risk really in the change,
                  is the severity fair, is the fix correct? An unprovable risk is no warning
  → card          warning (what could happen, who's affected, the line, fix prompt, the idea)
                  or lesson (story, the line, "in plain words", quick check)
```

**False alarms are worse than silence.** A warning the fact check can't stand behind after one retry is dropped, and the builder hears nothing. Silence is not a safety claim, so no card ever says a change is safe or secure.

**The quote checker is the core.** A quote about how the app works *now* may only use added or unchanged lines; a removed line can never prove current behaviour. Quotes that fail are dropped, the model gets one retry with the exact problems, and if nothing can be verified there is no lesson. No lesson beats a wrong one.

**The plain-English checker keeps it readable.** It flags words like "function", "object" or "validation", code names like `getErrorMessage`, sentences over 20 words, long stories, and quiz answers copied from the story. Its problems join the same single retry. If the quotes are true but the wording still fails, the lesson is kept and marked as failed in the report.

## The warning card

```
WARNING  ·  HIGH
This change turns off the lock on profiles

WHAT COULD HAPPEN   People using your app may be able to read or change profiles that are not theirs.
WHO'S AFFECTED      People who have a profile in your app.
THE LINE            supabase/migrations/…_profiles_open.sql line 2
  alter table public.profiles disable row level security;
In plain words: stop checking who is allowed to see or change each row in the profiles table.
FIX IT WITH YOUR AI [Copy]  a ready-to-paste instruction naming the file, the line and the change
THE IDEA BEHIND IT  2–3 sentences, with one everyday comparison

Lucid flags risks it can see in this change. It's a safety net, not a security audit.
```

Amber for medium and low, red for high. `evidence` is always `warning` for now; `proven` is reserved for the prover, and the schema rejects it from any model.

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

- **Filters on your machine first:** before anything leaves your computer, the extension drops `.env` files, key files, lockfiles, build output and binaries, and hides lines that look like keys or tokens. Only that filtered diff (the changed lines of up to 5 files) is sent.
- **Passes through our server:** the filtered diff goes to the Lucid server, which filters it again and sends it to Meta and Baseten to write and check the lesson.
- **Keeps nothing:** the server stores no diffs, no lessons and no accounts. It only counts lessons per GitHub user per day in memory (20 each), and logs status codes and timings, never your code.
- **Your own keys instead:** with your own Meta and Baseten keys set in the extension, the filtered diff goes straight to Meta and Baseten and never touches our server.
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

## Run the extension from source

Works in VS Code and Cursor.

```bash
cd extension
npm install
npm run build        # bundles the extension and the engine into extension/dist
```

1. Open this repository in VS Code and press **F5** ("Run Lucid extension"). A second window opens: the Extension Development Host.
2. In that window, open the command palette and run **Lucid: Sign in with GitHub**. Lessons are then written on Lucid's server (20 a day). To use your own Meta and Baseten keys instead, run **Lucid: Set API keys** and turn on `lucid.useOwnKeys`; editors without GitHub sign-in use your own keys automatically.
3. Open any git repository there, change something, and commit.
4. Keep working. When the lesson is ready, a toast appears: **Lucid: …** with **Show me**. The status bar shows what Lucid is doing.

`lucid.lessons` (`on` by default; `off` leaves only warnings) controls lesson cards; warnings always pop up. `lucid.autoExplain` (default on) turns the automatic run off. **Lucid: Explain my last commit** runs it by hand. F5 rebuilds the extension first ("Build Lucid extension" task).

## Tests

```bash
npm test         # diff parsing, secret filter, risk signals, quote checker, plain-English checker, cards, retries
npm run typecheck
```

`test/fixtures/risky-commits/` holds 9 small risky commits and 8 safe look-alikes (an owner policy, a server-only key, a verified webhook…). The signals must fire on every risky one and stay quiet on every safe one.

## Status

- [x] Engine: diff reader, filter, quote checker, schemas, prompts, retries, CLI
- [x] Plain-English lesson card: new lesson shape, plain-English checker, card JSON
- [x] Card page (HTML) with a clickable quick check, and `npm run preview`
- [x] VS Code extension (smallest version): lesson after each new commit, toast, card panel, keys in secret storage (VS Code and Cursor)
- [x] Backend on Modal: POST /lesson with GitHub sign-in, 20 lessons per user per day, global cap and kill switch; the extension filters locally and uses it by default
- [x] Safety net: risk signals, the picker decides risk / lesson / nothing, warning cards with a fix prompt, fact-checked
- [ ] Sandbox prover: run the migrations in a Modal sandbox and try to read another user's rows ([plan](docs/prover-plan.md))
- [ ] Repo context: before writing, search the repository for related code (e.g. other mentions of the same table) so lessons can say what a change backs up
- [ ] GitHub comment bot (renderer kept working with the new card layout)
- [ ] Quality testing with real builders
