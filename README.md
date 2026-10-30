# Lucid

**Lucid proves database leaks before you ship them, and teaches you why they happen.**

Lucid is for people who build apps with AI tools ("vibe coders") and have never read code. When you commit, Lucid reads the change in the background:

- **A risky change gets a warning card**: what could happen, who is affected, the line that does it, a fix you can paste into your AI tool, and the idea behind the risk. Risks always come first.
- **A safe but interesting change gets a lesson card**: what the change does in your app, the one line that does it, and a quick A/B/C check.

For a warning about database rules, Lucid then tries the leak for real: it builds your database setup in a disposable sandbox, adds two fake users, and attacks as a signed-out visitor and as the other user. If the attack gets through, the card switches from **Warning** to **Proven** ([Lucid Proves It](#lucid-proves-it)). If it doesn't, the card stays a warning: Lucid never says a change is safe.

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
  → filter        drop .env files, lockfiles, build output, binaries; mask secret values (sk_live••••)
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

Every warning card says **Potential risk detected** under its label. Amber for medium and low, red for high. `evidence` stays `warning` until the prover reproduces the leak; only the prover's result can set `proven`, and the schema rejects it from any model.

**Severity follows rules, not moods** (`src/engine/severity.ts`):

| Severity | Risks |
|---|---|
| high | data exposure (RLS off, rules that let every row through, owner checks taken out of a rule, public buckets), secrets or the service key in browser code |
| medium | a missing owner check on an update or delete, an admin route without a role check, a webhook without a signature check |
| low | CORS `*`, anything else |

The picker may move a risk one level, and only with a reason. The fact check accepts or rejects the reason, and a rejected one leaves the rule's level.

## Lucid Proves It

For a warning about database rules (Supabase/Postgres row level security), Lucid doesn't stop at reading the change. While the warning card is already on screen, it tries the leak for real, in a sandbox, against fake users:

```
PROVEN  ·  HIGH
Reproduced with fake users in a disposable sandbox
This change turns off the lock on notes

WHAT LUCID REPRODUCED
  In a disposable sandbox with fake users, a signed-out visitor read Alice's private row
  from `notes`. Before your commit: blocked. After: leaked.
    select * from public."notes";
  Reproduced unauthorized access against fake users, using your database rules, in a disposable sandbox.
```

A second toast says **⚠️ Lucid proved it: …**. If the attack doesn't get through, the card stays a **Warning**, with one quiet line: *Lucid couldn't reproduce this in its sandbox. That doesn't mean it's safe.*

**What is sent (setup files only).** The extension sends the `.sql` files in migrations folders (`supabase/migrations`, `db/migrations`, …), or `supabase/schemas`, or a `schema.sql`, as they were in the parent commit and in this commit, plus the names of the tables and policies the commit touched. Secret values are masked first, and each version is capped at 1 MB. Never seed files or any other data, never other code. The server checks all of this again. Only after a data-exposure warning, only when you're signed in with GitHub, and the `lucid.prove` setting turns it off.

**The sandbox.** A fresh [Modal Sandbox](https://modal.com/docs/guide/sandbox) for every proof, running Postgres 16 with just enough of Supabase for your rules to behave as they do in your project: the `anon`, `authenticated` and `service_role` roles, `auth.users`, and `auth.uid()` / `auth.role()` / `auth.jwt()` reading the request's JWT claims like Supabase does.
- No network at all. 1 CPU, 1 GiB. 3 seconds per statement, about 90 seconds per proof (2 minutes at the most), then the sandbox is destroyed, every time. Nothing is kept.
- Your setup runs inside it only. psql commands (`\copy`, `\!`, `\i` …) are stripped; anything that reads or writes files, runs programs or reaches other servers (`COPY … PROGRAM`, `pg_read_file`, `dblink`, `http`, `pg_net`) stops the proof; only a short list of extensions is installed.
- The attack runs as a signed-out visitor (`anon`) or as Bob, never as the database superuser, and may not change who it is (roles, JWT claims) or the schema.

**Fake users.** Two made-up users, `alice@example.test` and `bob@example.test`, with fresh ids. Every table with an owner column (a link to `auth.users`, `user_id`, `owner_id` …) gets one row for each; Alice's values carry a random marker (`CANARY-ALICE-…`) so her data can't be mistaken for anything else. Unusual tables are filled by the model, as the superuser, before the attack starts.

**The attack.** First, standard probes written by code: on the tables the commit touched, then the rest, read, change and delete Alice's rows as a signed-out visitor and as Bob. If none of them gets through, the attacker model (Muse Spark 1.3) reads the tables and rules and tries its own queries: at most 12 tool calls and about 60 seconds, every call logged.

**Ground truth decides, never the model.** A read counts only when Alice's marker came back to the visitor or Bob. A change or delete counts only when Alice's rows, fingerprinted by the superuser, changed or vanished. Then:
- **The privacy judge** (Muse Spark Open) looks at the table's columns and rules. A read of data clearly meant for everyone (published posts, a product list) is no proof.
- **Before vs after.** The exact query runs again on the database as it was before the commit. Lucid keeps looking until it finds something this commit opened ("Before your commit: blocked. After: leaked."). If everything it reached was already open before, the card says so ("Before your commit: also open.").

**What "Proven" means, and doesn't.** *Reproduced unauthorized access against fake users, using your database rules, in a disposable sandbox.* It does not mean real people's data was exposed, and the sandbox is a close copy of Supabase, not your project: no storage, no real auth server, only some extensions. "Not reproduced" is never a safety claim. **A safety net, not a security audit.**

**Limits.** 5 proofs per GitHub user per day, a cap for everyone (`LUCID_PROVE_CAP`, 100 a day), and a switch that pauses only the prover (`LUCID_PROVE_ENABLED=false`).

**Tested on** `test/fixtures/prover-app/` (profiles and notes with owner-only rules), five commits on top. `npm run -s prove:fixtures` runs them locally; `modal run deploy/modal_app.py::prove_fixtures` runs them on Modal the way the server does:

| Commit | Expected | Result (two runs on Modal, October 30) | Time per proof |
|---|---|---|---|
| a. turns row level security off on `notes` | proven | proven both times: a signed-out visitor read Alice's note. Before: blocked | 3.7–4.3 s |
| b. `notes` read rule changed to `using (true)` | proven | proven both times: a signed-out visitor read it. Before: blocked | 4.4–5.6 s |
| c. owner check removed (any signed-in user reads) | proven | proven both times: Bob read it. Before: blocked | 3.2–4.4 s |
| d. new `invoices` table with owner-only rules | not proven | not reproduced both times: 18 probes and 12 attacker calls reached nothing | 66–68 s |
| e. public blog posts (`using (true)`, meant for everyone) | not proven | not reproduced both times: the read worked, the judge called the data public, nothing else got through | 66 s |

Three earlier full runs (two from a laptop, one on Modal) gave the same 15 results. A sandbox costs about $0.000015 a second (1 CPU, 1 GiB), so about $0.0001 for a proof and $0.001 for a long miss, plus the model calls: about 1,000 tokens for the judge, and up to about 17,000 when the attacker model runs.

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

- **Filters on your machine first:** before anything leaves your computer, the extension drops `.env` files, key files, lockfiles, build output and binaries, and masks any value that looks like a key or token (`sk_live_abc…` becomes `sk_live••••`, at most 7 characters of a known prefix and nothing of anything else). The real value never leaves your machine; a card can still point at the line. Only that filtered diff (the changed lines of up to 5 files) is sent.
- **Passes through our server:** the filtered diff goes to the Lucid server, which filters it again and sends it to Meta and Baseten to write and check the lesson.
- **Keeps nothing:** the server stores no diffs, no lessons and no accounts. It only counts lessons per GitHub user per day in memory (20 each), and logs status codes and timings, never your code.
- **Your own keys instead:** with your own Meta and Baseten keys set in the extension, the filtered diff goes straight to Meta and Baseten and never touches our server.
- **For a data-exposure warning only:** the database setup files (see [Lucid Proves It](#lucid-proves-it)), so the prover can test the warning in a disposable sandbox. Never data, never other code. The prover needs Lucid's server, so it doesn't run with your own keys.
- **Models:** Meta's standard mode only, never Contributor mode, so your code is not used for training.
- Secret filtering is a precaution, not a guarantee. Don't commit secrets.
- Lucid explains what your change says. It doesn't run your app, so it can't tell you whether the code works. The prover runs only your database setup files, in a sandbox, against fake users.

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
npm test         # diff parsing, secret filter, risk signals, quote checker, plain-English checker, cards, retries, prover
npm run typecheck
npm run -s prove:fixtures   # the prover for real: Modal sandboxes, the attacker and the judge, on fixtures a–e
```

`test/fixtures/risky-commits/` holds 10 small risky commits and 8 safe look-alikes (an owner policy, a server-only key, a verified webhook…). The signals must fire on every risky one and stay quiet on every safe one.

## Status

- [x] Engine: diff reader, filter, quote checker, schemas, prompts, retries, CLI
- [x] Plain-English lesson card: new lesson shape, plain-English checker, card JSON
- [x] Card page (HTML) with a clickable quick check, and `npm run preview`
- [x] VS Code extension (smallest version): lesson after each new commit, toast, card panel, keys in secret storage (VS Code and Cursor)
- [x] Backend on Modal: POST /lesson with GitHub sign-in, 20 lessons per user per day, global cap and kill switch; the extension filters locally and uses it by default
- [x] Safety net: risk signals, the picker decides risk / lesson / nothing, warning cards with a fix prompt, fact-checked
- [x] Sandbox prover (database rules only): POST /prove, a Modal sandbox per proof, fake users with canaries, standard probes plus an attacker model, ground truth and a privacy judge, before vs after; the card switches to "Proven"
- [ ] Repo context: before writing, search the repository for related code (e.g. other mentions of the same table) so lessons can say what a change backs up
- [ ] GitHub comment bot (renderer kept working with the new card layout)
- [ ] Quality testing with real builders
