# Lucid red-team evaluation

2026-10-31, commit `ba440f5`. On Modal, in the server's image. Models: meta-models/muse-spark-open-1026 (pick, fact check, judge), muse-spark-1.3 (write, attack). 4 commits at a time.

**⚠️ MISSED risky commits: held-team-join**

## Summary

| Measure | Result |
|---|---|
| Commits | 43 (21 risky, 22 safe) |
| Warnings on risky commits | **20 of 21** (95%) |
| False warnings on safe commits | **0 of 22** (0%) |
| Proofs among data-exposure cases, in the product | **10 of 10** (100%) |
| Proofs among data-exposure cases, prover alone | 10 of 10 (4 by the standard probes, 6 by the attacker model) |
| False proofs on safe commits | **0 in the product, 0 by the prover alone** (must be 0) |
| Time to the card | median 16.0 s, p90 52.8 s |
| Time for a proof | median 58.6 s, p90 79.4 s |
| Time for a commit, card and proof | median 21.5 s, p90 53.5 s |
| Tokens | 956,021 in all, 22,233 per commit |
| Rough cost | $2.42 in all, $0.0563 per commit |

By source: hand-written: 14 of 14 risky caught, 0 of 15 safe warned. Written by Muse Spark: 4 of 4 risky caught, 0 of 4 safe warned. Held out: 2 of 3 risky caught, 0 of 3 safe warned.

"In the product" means what a builder gets: a proof runs only after a data-exposure warning. "Prover alone" forces the prover on every commit with database setup, warned or not. Rough cost: both models at $1.25 per million input tokens and $4.25 per million output, the rate price trackers list (not taken from Meta's or Baseten's own price pages), and sandboxes at Modal's per-second rate. Treat it as an order of magnitude.

## Every commit

| Commit | Truth | Source | Warned | Category | Severity | Proved | Fact check | Time | Tokens | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| rls-off | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 18.1 s | 10,025 | $0.0212 |
| using-true | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 15.0 s | 9,923 | $0.0204 |
| owner-check-removed | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 16.5 s | 10,509 | $0.0227 |
| hard-f-related-table | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 29.4 s | 18,571 | $0.0358 |
| hard-g-definer-function | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 20.2 s | 13,262 | $0.0274 |
| hard-h-insert-wrong-column | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 31.5 s | 16,421 | $0.0369 |
| hard-i-view | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 20.6 s | 13,011 | $0.0263 |
| safe-invoices-owner-rules | safe | authored | no | - | - | no | passed | 21.4 s | 39,606 | $0.1039 |
| safe-public-blog | safe | authored | no | - | - | no | passed | 53.5 s | 53,560 | $0.1503 |
| safe-invoker-view | safe | authored | no | - | - | no | passed | 52.8 s | 53,677 | $0.1462 |
| safe-checked-function | safe | authored | no | - | - | no | passed | 62.8 s | 55,120 | $0.1578 |
| safe-versions-owner | safe | authored | no | - | - | no | passed | 23.2 s | 38,407 | $0.1003 |
| safe-published-view | safe | authored | no | - | - | no | passed | 21.5 s | 36,650 | $0.0982 |
| safe-insert-right-column | safe | authored | no | - | - | no | passed | 45.2 s | 51,310 | $0.1404 |
| risky-04-service-role-in-client | risky | authored | yes | secrets | high | - | passed | 27.1 s | 15,519 | $0.0387 |
| risky-05-public-env-secret | risky | authored | yes | secrets | high | - | passed | 16.0 s | 9,502 | $0.0217 |
| risky-06-admin-route-no-role | risky | authored | yes | auth | medium | - | passed | 13.9 s | 9,810 | $0.0218 |
| risky-07-delete-without-owner | risky | authored | yes | ownership | medium | - | passed | 12.8 s | 9,626 | $0.0215 |
| risky-08-stripe-webhook-unverified | risky | authored | yes | payments | medium | - | passed | 13.3 s | 10,175 | $0.0226 |
| risky-09-bucket-public | risky | authored | yes | data-exposure | high | - | passed | 9.4 s | 8,504 | $0.0177 |
| risky-10-secret-in-browser-code | risky | authored | yes | secrets | high | - | passed | 27.5 s | 16,141 | $0.0422 |
| safe-01-owner-policy | safe | authored | no | - | - | - | passed | 12.5 s | 9,837 | $0.0212 |
| safe-02-server-only-key | safe | authored | no | - | - | - | passed | 21.6 s | 12,113 | $0.0309 |
| safe-03-webhook-verified | safe | authored | no | - | - | - | passed | 58.7 s | 25,406 | $0.0714 |
| safe-04-ui-change | safe | authored | no | - | - | - | - | 1.8 s | 2,799 | $0.0044 |
| safe-05-delete-with-owner | safe | authored | no | - | - | - | passed | 81.8 s | 30,901 | $0.0951 |
| safe-06-admin-route-with-role | safe | authored | no | - | - | - | passed | 21.8 s | 11,946 | $0.0279 |
| safe-07-policy-recreated | safe | authored | no | - | - | - | - | 4.7 s | 6,219 | $0.0111 |
| safe-08-anon-key-in-client | safe | authored | no | - | - | - | passed | 27.3 s | 13,060 | $0.0349 |
| gen-admin-route-checked | safe | generated | no | - | - | - | passed | 24.7 s | 13,629 | $0.0336 |
| gen-messages-definer | risky | generated | yes | data-exposure | high | yes (attacker, in product) | passed | 26.5 s | 15,848 | $0.0325 |
| gen-orders-any-user | risky | generated | yes | data-exposure | high | yes (probe, in product) | passed | 15.5 s | 11,244 | $0.0237 |
| gen-profile-update-route | risky | generated | yes | ownership | medium | - | passed | 12.5 s | 9,959 | $0.0211 |
| gen-public-catalog | safe | generated | no | - | - | no | - | 7.0 s | 30,439 | $0.0771 |
| gen-stripe-key-in-browser | risky | generated | yes | secrets | high | - | passed | 18.4 s | 10,660 | $0.0238 |
| gen-tasks-owner-rules | safe | generated | no | - | - | no | passed | 21.6 s | 38,629 | $0.0921 |
| gen-webhook-verified | safe | generated | no | - | - | - | passed | 23.2 s | 13,136 | $0.0314 |
| held-metadata-admin | risky | held-out | yes | data-exposure | high | no | passed | 82.0 s | 36,303 | $0.0900 |
| held-note-wipe-function | risky | held-out | yes | data-exposure | high | yes (attacker, in product) | passed | 23.1 s | 13,848 | $0.0291 |
| held-notes-count-function | safe | held-out | no | - | - | no | passed | 21.4 s | 34,212 | $0.0875 |
| held-team-join | risky | held-out | no | - | - | no | passed | 21.3 s | 42,083 | $0.1105 |
| held-team-owner-invites | safe | held-out | no | - | - | no | passed | 28.3 s | 41,785 | $0.1105 |
| held-ticket-reassign | safe | held-out | no | - | - | no | passed | 15.2 s | 32,636 | $0.0866 |

## How to read this

- A small test set, not a measure of the world. Most commits were written by the people who built Lucid, while its prompts and risk signals were being tuned on the same kinds of mistake, so the hand-written score is flattering. The generated ones come from the same model family that detects them, so they are fresher but not independent.
- The held-out commits are the fairest numbers here. They were generated after the prompts and signals were frozen, in shapes those never mention, and nothing was tuned on them afterwards.
- A miss is a commit with no warning card. A warning the fact check dropped counts as a miss: the builder hears nothing.
- Time is wall clock per commit with 4 running at once, so it includes queueing at the model APIs. The proof runs in the background after the card is shown.
- A "not proven" says nothing about safety. Proofs run in a disposable sandbox against fake users.

Run it again with `npm run eval`. Model answers vary between runs, so expect small differences.
