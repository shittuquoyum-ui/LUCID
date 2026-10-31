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
| Time to the card | median 15.6 s, p90 44.4 s |
| Time for a proof | median 57.8 s, p90 76.9 s |
| Time for a commit, card and proof | median 19.7 s, p90 51.9 s |
| Tokens | 1,057,110 in all, 22,981 per commit |
| Rough cost | $2.65 in all, $0.0575 per commit |

By source: hand-written: 15 of 15 risky caught, 0 of 17 safe warned. Written by Muse Spark: 4 of 4 risky caught, 0 of 4 safe warned. Held out: 2 of 3 risky caught, 0 of 3 safe warned.

"In the product" means what a builder gets: a proof runs only after a data-exposure warning. "Prover alone" forces the prover on every commit with database setup, warned or not. Rough cost: both models at $1.25 per million input tokens and $4.25 per million output, the rate price trackers list (not taken from Meta's or Baseten's own price pages), and sandboxes at Modal's per-second rate. Treat it as an order of magnitude.

## Every commit

| Commit | Truth | Source | Warned | Category | Severity | Proved | Fact check | Time | Tokens | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| rls-off | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 13.4 s | 8,557 | $0.0176 |
| using-true | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 14.4 s | 9,016 | $0.0191 |
| owner-check-removed | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 13.9 s | 8,827 | $0.0182 |
| hard-f-related-table | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 29.7 s | 19,637 | $0.0385 |
| hard-g-definer-function | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 19.7 s | 13,210 | $0.0263 |
| hard-h-insert-wrong-column | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 30.4 s | 16,519 | $0.0368 |
| hard-i-view | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 22.2 s | 12,117 | $0.0255 |
| profiles-emails-opened | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 18.2 s | 9,965 | $0.0228 |
| safe-invoices-owner-rules | safe | authored | no | - | - | no | passed | 19.6 s | 41,213 | $0.1053 |
| safe-public-blog | safe | authored | no | - | - | no (looks meant to be public) | passed | 19.2 s | 36,023 | $0.0902 |
| safe-invoker-view | safe | authored | no | - | - | no | passed | 15.5 s | 39,535 | $0.0988 |
| safe-checked-function | safe | authored | no | - | - | no | passed | 22.6 s | 37,972 | $0.1021 |
| safe-versions-owner | safe | authored | no | - | - | no | passed | 22.9 s | 39,016 | $0.0995 |
| safe-published-view | safe | authored | no | - | - | no | passed | 23.2 s | 38,796 | $0.1010 |
| safe-insert-right-column | safe | authored | no | - | - | no | passed | 54.0 s | 50,701 | $0.1347 |
| safe-leaderboard-opened | safe | authored | no | - | - | no (looks meant to be public) | passed | 21.9 s | 39,068 | $0.1009 |
| safe-public-profiles-opened | safe | authored | no | - | - | no (looks meant to be public) | passed | 22.6 s | 38,896 | $0.0956 |
| risky-04-service-role-in-client | risky | authored | yes | secrets | high | - | passed | 22.1 s | 14,782 | $0.0353 |
| risky-05-public-env-secret | risky | authored | yes | secrets | high | - | passed | 24.5 s | 15,190 | $0.0398 |
| risky-06-admin-route-no-role | risky | authored | yes | auth | medium | - | passed | 13.3 s | 9,786 | $0.0214 |
| risky-07-delete-without-owner | risky | authored | yes | ownership | medium | - | passed | 12.0 s | 9,593 | $0.0212 |
| risky-08-stripe-webhook-unverified | risky | authored | yes | payments | medium | - | passed | 13.7 s | 10,315 | $0.0227 |
| risky-09-bucket-public | risky | authored | yes | data-exposure | high | - | passed | 12.6 s | 9,010 | $0.0197 |
| risky-10-secret-in-browser-code | risky | authored | yes | secrets | high | - | passed | 12.8 s | 9,752 | $0.0211 |
| safe-01-owner-policy | safe | authored | no | - | - | - | passed | 20.1 s | 11,317 | $0.0271 |
| safe-02-server-only-key | safe | authored | no | - | - | - | passed | 19.4 s | 11,797 | $0.0289 |
| safe-03-webhook-verified | safe | authored | no | - | - | - | passed | 22.6 s | 12,798 | $0.0319 |
| safe-04-ui-change | safe | authored | no | - | - | - | - | 1.0 s | 2,720 | $0.0039 |
| safe-05-delete-with-owner | safe | authored | no | - | - | - | passed | 52.0 s | 26,473 | $0.0760 |
| safe-06-admin-route-with-role | safe | authored | no | - | - | - | passed | 17.8 s | 12,198 | $0.0285 |
| safe-07-policy-recreated | safe | authored | no | - | - | - | - | 1.3 s | 2,834 | $0.0043 |
| safe-08-anon-key-in-client | safe | authored | no | - | - | - | - | 5.1 s | 3,684 | $0.0081 |
| gen-admin-route-checked | safe | generated | no | - | - | - | passed | 17.6 s | 12,631 | $0.0286 |
| gen-messages-definer | risky | generated | yes | data-exposure | high | yes (attacker, in product) | passed | 18.2 s | 12,907 | $0.0260 |
| gen-orders-any-user | risky | generated | yes | data-exposure | high | yes (probe, in product) | passed | 12.6 s | 10,185 | $0.0215 |
| gen-profile-update-route | risky | generated | yes | ownership | medium | - | passed | 12.1 s | 10,213 | $0.0220 |
| gen-public-catalog | safe | generated | no | - | - | no | passed | 22.3 s | 39,584 | $0.1009 |
| gen-stripe-key-in-browser | risky | generated | yes | secrets | high | - | passed | 11.0 s | 9,679 | $0.0194 |
| gen-tasks-owner-rules | safe | generated | no | - | - | no | passed | 42.4 s | 51,907 | $0.1321 |
| gen-webhook-verified | safe | generated | no | - | - | - | passed | 22.5 s | 14,106 | $0.0349 |
| held-metadata-admin | risky | held-out | yes | data-exposure | high | no | passed | 76.0 s | 36,947 | $0.0915 |
| held-note-wipe-function | risky | held-out | yes | data-exposure | high | yes (attacker, in product) | passed | 20.7 s | 12,645 | $0.0271 |
| held-notes-count-function | safe | held-out | no | - | - | no | failed | 62.0 s | 55,200 | $0.1525 |
| held-team-join | risky | held-out | no | - | - | no | passed | 44.4 s | 53,655 | $0.1447 |
| held-team-owner-invites | safe | held-out | no | - | - | no | passed | 51.9 s | 61,885 | $0.1739 |
| held-ticket-reassign | safe | held-out | no | - | - | no | passed | 43.0 s | 54,249 | $0.1482 |

## How to read this

- A small test set, not a measure of the world. Most commits were written by the people who built Lucid, while its prompts and risk signals were being tuned on the same kinds of mistake, so the hand-written score is flattering. The generated ones come from the same model family that detects them, so they are fresher but not independent.
- The held-out commits are the fairest numbers here. They were generated after the prompts and signals were frozen, in shapes those never mention, and nothing was tuned on them afterwards.
- A miss is a commit with no warning card. A warning the fact check dropped counts as a miss: the builder hears nothing.
- Time is wall clock per commit with 4 running at once, so it includes queueing at the model APIs. The proof runs in the background after the card is shown.
- A "not proven" says nothing about safety. Proofs run in a disposable sandbox against fake users.

Run it again with `npm run eval`. Model answers vary between runs, so expect small differences.
