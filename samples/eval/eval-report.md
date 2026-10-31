# Lucid red-team evaluation

2026-10-31, commit `f5b49e7`. On Modal, in the server's image. Models: meta-models/muse-spark-open-1026 (pick, fact check, judge), muse-spark-1.3 (write, attack). 4 commits at a time.

**⚠️ MISSED risky commits: held-team-join**

## Summary

| Measure | Result |
|---|---|
| Commits | 46 (22 risky, 24 safe) |
| Warnings on risky commits | **21 of 22** (95%) |
| False warnings on safe commits | **0 of 24** (0%) |
| Proofs among data-exposure cases, in the product | **11 of 11** (100%) |
| Proofs among data-exposure cases, prover alone | 11 of 11 (5 by the standard probes, 6 by the attacker model) |
| False proofs on safe commits | **0 in the product, 0 by the prover alone** (must be 0) |
| Time to the card | median 16.2 s, p90 52.5 s |
| Time for a proof | median 64.1 s, p90 78.6 s |
| Time for a commit, card and proof | median 19.4 s, p90 56.7 s |
| Tokens | 990,134 in all, 21,525 per commit |
| Rough cost | $2.47 in all, $0.0537 per commit |

By source: hand-written: 15 of 15 risky caught, 0 of 17 safe warned. Written by Muse Spark: 4 of 4 risky caught, 0 of 4 safe warned. Held out: 2 of 3 risky caught, 0 of 3 safe warned.

"In the product" means what a builder gets: a proof runs only after a data-exposure warning. "Prover alone" forces the prover on every commit with database setup, warned or not. Rough cost: both models at $1.25 per million input tokens and $4.25 per million output, the rate price trackers list (not taken from Meta's or Baseten's own price pages), and sandboxes at Modal's per-second rate. Treat it as an order of magnitude.

## Every commit

| Commit | Truth | Source | Warned | Category | Severity | Proved | Fact check | Time | Tokens | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| rls-off | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 16.1 s | 8,884 | $0.0192 |
| using-true | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 16.2 s | 9,387 | $0.0207 |
| owner-check-removed | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 18.1 s | 9,707 | $0.0219 |
| hard-f-related-table | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 36.8 s | 21,113 | $0.0454 |
| hard-g-definer-function | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 20.2 s | 12,360 | $0.0262 |
| hard-h-insert-wrong-column | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 30.9 s | 16,900 | $0.0385 |
| hard-i-view | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 21.3 s | 12,667 | $0.0276 |
| profiles-emails-opened | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 17.2 s | 10,093 | $0.0235 |
| safe-invoices-owner-rules | safe | authored | no | - | - | no | passed | 25.0 s | 38,754 | $0.0995 |
| safe-public-blog | safe | authored | no | - | - | no (looks meant to be public) | - | 4.3 s | 29,419 | $0.0731 |
| safe-invoker-view | safe | authored | no | - | - | no | passed | 18.7 s | 39,764 | $0.0995 |
| safe-checked-function | safe | authored | no | - | - | no | - | 6.9 s | 25,696 | $0.0677 |
| safe-versions-owner | safe | authored | no | - | - | no | passed | 21.9 s | 39,176 | $0.1057 |
| safe-published-view | safe | authored | no | - | - | no | passed | 24.9 s | 40,370 | $0.1042 |
| safe-insert-right-column | safe | authored | no | - | - | no | passed | 56.7 s | 48,423 | $0.1338 |
| safe-leaderboard-opened | safe | authored | no | - | - | no (looks meant to be public) | passed | 23.8 s | 39,694 | $0.0984 |
| safe-public-profiles-opened | safe | authored | no | - | - | no (looks meant to be public) | passed | 19.1 s | 37,046 | $0.0929 |
| risky-04-service-role-in-client | risky | authored | yes | secrets | high | - | passed | 13.4 s | 9,877 | $0.0209 |
| risky-05-public-env-secret | risky | authored | yes | secrets | high | - | passed | 15.5 s | 9,759 | $0.0227 |
| risky-06-admin-route-no-role | risky | authored | yes | auth | medium | - | passed | 12.6 s | 9,552 | $0.0205 |
| risky-07-delete-without-owner | risky | authored | yes | ownership | medium | - | passed | 16.2 s | 10,151 | $0.0238 |
| risky-08-stripe-webhook-unverified | risky | authored | yes | payments | medium | - | passed | 13.3 s | 9,863 | $0.0211 |
| risky-09-bucket-public | risky | authored | yes | data-exposure | high | - | passed | 12.7 s | 8,279 | $0.0165 |
| risky-10-secret-in-browser-code | risky | authored | yes | secrets | high | - | passed | 13.3 s | 9,880 | $0.0217 |
| safe-01-owner-policy | safe | authored | no | - | - | - | passed | 19.1 s | 11,111 | $0.0262 |
| safe-02-server-only-key | safe | authored | no | - | - | - | passed | 52.5 s | 19,721 | $0.0552 |
| safe-03-webhook-verified | safe | authored | no | - | - | - | passed | 56.7 s | 24,659 | $0.0673 |
| safe-04-ui-change | safe | authored | no | - | - | - | - | 1.1 s | 2,738 | $0.0040 |
| safe-05-delete-with-owner | safe | authored | no | - | - | - | passed | 66.9 s | 24,955 | $0.0693 |
| safe-06-admin-route-with-role | safe | authored | no | - | - | - | passed | 23.6 s | 12,650 | $0.0305 |
| safe-07-policy-recreated | safe | authored | no | - | - | - | - | 3.8 s | 5,755 | $0.0088 |
| safe-08-anon-key-in-client | safe | authored | no | - | - | - | - | 2.9 s | 3,063 | $0.0055 |
| gen-admin-route-checked | safe | generated | no | - | - | - | passed | 30.3 s | 14,264 | $0.0355 |
| gen-messages-definer | risky | generated | yes | data-exposure | high | yes (attacker, in product) | passed | 22.8 s | 13,316 | $0.0277 |
| gen-orders-any-user | risky | generated | yes | data-exposure | high | yes (probe, in product) | passed | 15.3 s | 9,990 | $0.0208 |
| gen-profile-update-route | risky | generated | yes | ownership | medium | - | passed | 15.1 s | 10,692 | $0.0240 |
| gen-public-catalog | safe | generated | no | - | - | no | passed | 23.5 s | 37,099 | $0.0902 |
| gen-stripe-key-in-browser | risky | generated | yes | secrets | high | - | passed | 28.6 s | 16,291 | $0.0410 |
| gen-tasks-owner-rules | safe | generated | no | - | - | no | passed | 19.4 s | 35,493 | $0.0886 |
| gen-webhook-verified | safe | generated | no | - | - | - | passed | 20.9 s | 13,086 | $0.0307 |
| held-metadata-admin | risky | held-out | yes | data-exposure | high | no | passed | 84.5 s | 35,129 | $0.0881 |
| held-note-wipe-function | risky | held-out | yes | data-exposure | high | yes (attacker, in product) | passed | 27.5 s | 13,129 | $0.0290 |
| held-notes-count-function | safe | held-out | no | - | - | no | failed | 72.7 s | 53,499 | $0.1494 |
| held-team-join | risky | held-out | no | - | - | no | passed | 16.7 s | 41,061 | $0.1049 |
| held-team-owner-invites | safe | held-out | no | - | - | no | passed | 23.8 s | 48,142 | $0.1323 |
| held-ticket-reassign | safe | held-out | no | - | - | no | passed | 20.2 s | 37,477 | $0.0974 |

## How to read this

- A small test set, not a measure of the world. Most commits were written by the people who built Lucid, while its prompts and risk signals were being tuned on the same kinds of mistake, so the hand-written score is flattering. The generated ones come from the same model family that detects them, so they are fresher but not independent.
- The held-out commits are the fairest numbers here. They were generated after the prompts and signals were frozen, in shapes those never mention, and nothing was tuned on them afterwards.
- A miss is a commit with no warning card. A warning the fact check dropped counts as a miss: the builder hears nothing.
- Time is wall clock per commit with 4 running at once, so it includes queueing at the model APIs. The proof runs in the background after the card is shown.
- A "not proven" says nothing about safety. Proofs run in a disposable sandbox against fake users.

Run it again with `npm run eval`. Model answers vary between runs, so expect small differences.
