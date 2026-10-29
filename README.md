# Lucid

**You shipped it. Now see it.**

Lucid is an agent for people who build apps with AI tools ("vibe coders"). On a pull request, it picks the one change that matters most, explains it in plain English using the builder's own code, links every quote to the exact line, and ends with one quick check question.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). Everything in this repository was written during the event.

## How it works

```
pull request diff
  → filter      drop .env files, lockfiles, build output, binaries; hide secret-looking lines
  → pick        Muse Spark Open (Baseten): is this worth a lesson? which ONE concept?
  → write       Muse Spark 1.3 (Meta Model API): plain-English lesson + one A/B/C question
  → verify      plain code: every quote must exist in the diff, with the right status
  → comment     lesson posted on the PR, each quote linked to its exact line
```

**The quote checker is the core.** A quote about how the app works *now* may only use added or unchanged lines; a removed line can never prove current behaviour. Quotes that fail are dropped, the model gets one retry with the exact problems, and if nothing can be verified the PR gets no lesson. No lesson beats a wrong one.

## What Lucid sends, and what it keeps

- **Sends:** the changed lines of up to 5 files from the pull request, after the filter above.
- **Never sends:** `.env` files, key files, lockfiles, build output, binaries, or lines that look like keys or tokens.
- **Keeps:** nothing. No database. The lesson lives only in the PR comment.
- **Models:** Meta's standard mode only, never Contributor mode, so your code is not used for training.
- Secret filtering is a precaution, not a guarantee. Don't commit secrets.

## Run it locally

```bash
npm install
cp .env.example .env          # add your keys; .env is git-ignored

# Fake model: no keys, no cost. Tests the whole pipeline.
npm run lesson -- path/to/change.diff --provider fake
git diff main | npm run lesson -- - --provider fake

# Real models
npm run lesson -- https://github.com/owner/repo/pull/12 --pick baseten --write meta
```

The comment prints to stdout; a report of what was sent, skipped and verified prints to stderr.

## Tests

```bash
npm test         # diff parsing, secret filter, quote checker, quick check, retries
npm run typecheck
```

## Status

- [x] Engine: diff reader, filter, quote checker, schemas, prompts, retries, CLI
- [ ] GitHub bot: lesson on new PRs or on `/lucid`, quick-check replies
- [ ] Repo setting: `mode: auto | on-request`
- [ ] Quality testing with real builders
