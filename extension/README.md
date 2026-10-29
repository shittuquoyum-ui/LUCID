# Lucid

**You shipped it. Now see it.**

Lucid is for people who build apps with AI and have never read code. Every time you commit, Lucid reads your change in the background and, when it's ready, shows you a short lesson card beside your code:

- **What this change does**, in plain words, about *your* app
- **The line that does it**, quoted from your change, with what it means in everyday words
- **A quick check**: one A/B/C question you can click

You never have to ask. Commit, keep working, and the card comes to you.

## Getting started

1. Install Lucid.
2. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Lucid: Sign in with GitHub**.
3. Open any project that uses git, change something, and commit.
4. Keep working. When the lesson is ready, a message appears: **Lucid: …** → **Show me**.

The **👁 Lucid** button in the status bar reopens your last lesson. While Lucid is reading, it spins and shows which step it's on.

## Honest by design

- **Every quote is checked against your code.** If the writer quotes a line that isn't in your change, the line is dropped. If nothing can be verified, you get no lesson rather than a wrong one.
- **A second model fact-checks every lesson** against what your change actually did before and after, and anything it can't prove is sent back to be rewritten.
- **Lucid explains what your change says.** It doesn't run your code, so it can't tell you whether the code works.

## What Lucid sends, and what it keeps

- **Filtered on your computer first.** Before anything leaves your machine, Lucid drops `.env` files, key files, lockfiles, build output and images, and hides any line that looks like a password, key or token. Only that filtered change is sent.
- **Through Lucid's server to the AI models.** The filtered change goes to Lucid's server, which filters it again and asks Meta's and Baseten's models to write and check the lesson.
- **Nothing is kept.** The server stores no code, no lessons and no accounts. GitHub sign-in is only used to count lessons (20 per person per day).
- Secret filtering is a precaution, not a guarantee. Don't commit secrets.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `lucid.autoExplain` | on | Explain each new commit automatically. Turn off to only use **Lucid: Explain my last commit**. |
| `lucid.useOwnKeys` | off | Use your own Meta and Baseten keys (**Lucid: Set API keys**) instead of Lucid's server. Your filtered change then goes straight to Meta and Baseten. |
| `lucid.serverUrl` | Lucid's server | Where lessons are written when you're signed in with GitHub. |

If your editor has no GitHub sign-in, Lucid uses your own keys automatically.

## Commands

- **Lucid: Sign in with GitHub**
- **Lucid: Explain my last commit**: run Lucid by hand on your latest commit
- **Lucid: Show last lesson**
- **Lucid: Set API keys**: keys are kept in your editor's secret storage, never in settings or files

Lucid only reacts to commits you make. Switching branches, pulling or rebasing doesn't trigger it.
