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
| Time to the card | median 18.4 s, p90 44.7 s |
| Time for a proof | median 64.1 s, p90 87.5 s |
| Time for a commit, card and proof | median 21.3 s, p90 50.7 s |
| Tokens | 979,365 in all, 22,776 per commit |
| Rough cost | $2.49 in all, $0.0580 per commit |

By source: hand-written: 14 of 14 risky caught, 0 of 15 safe warned. Written by Muse Spark: 4 of 4 risky caught, 0 of 4 safe warned. Held out: 2 of 3 risky caught, 0 of 3 safe warned.

"In the product" means what a builder gets: a proof runs only after a data-exposure warning. "Prover alone" forces the prover on every commit with database setup, warned or not. Rough cost: both models at $1.25 per million input tokens and $4.25 per million output, the rate price trackers list (not taken from Meta's or Baseten's own price pages), and sandboxes at Modal's per-second rate. Treat it as an order of magnitude.

## Every commit

| Commit | Truth | Source | Warned | Category | Severity | Proved | Fact check | Time | Tokens | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| rls-off | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 12.5 s | 9,534 | $0.0191 |
| using-true | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 16.0 s | 10,725 | $0.0237 |
| owner-check-removed | risky | authored | yes | data-exposure | high | yes (probe, in product) | passed | 15.9 s | 10,565 | $0.0230 |
| hard-f-related-table | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 28.0 s | 18,899 | $0.0372 |
| hard-g-definer-function | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 21.3 s | 13,456 | $0.0281 |
| hard-h-insert-wrong-column | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 24.9 s | 14,939 | $0.0340 |
| hard-i-view | risky | authored | yes | data-exposure | high | yes (attacker, in product) | passed | 17.7 s | 12,922 | $0.0259 |
| safe-invoices-owner-rules | safe | authored | no | - | - | no | passed | 17.7 s | 40,439 | $0.1077 |
| safe-public-blog | safe | authored | no | - | - | no | passed | 18.8 s | 42,706 | $0.1120 |
| safe-invoker-view | safe | authored | no | - | - | no | passed | 52.3 s | 53,268 | $0.1441 |
| safe-checked-function | safe | authored | no | - | - | no | passed | 18.4 s | 39,840 | $0.1073 |
| safe-versions-owner | safe | authored | no | - | - | no | passed | 54.4 s | 57,202 | $0.1573 |
| safe-published-view | safe | authored | no | - | - | no | passed | 44.7 s | 47,135 | $0.1286 |
| safe-insert-right-column | safe | authored | no | - | - | no | passed | 25.5 s | 38,852 | $0.0986 |
| risky-04-service-role-in-client | risky | authored | yes | secrets | high | - | passed | 11.4 s | 9,235 | $0.0184 |
| risky-05-public-env-secret | risky | authored | yes | secrets | high | - | passed | 32.0 s | 16,604 | $0.0462 |
| risky-06-admin-route-no-role | risky | authored | yes | auth | medium | - | passed | 13.3 s | 9,707 | $0.0213 |
| risky-07-delete-without-owner | risky | authored | yes | ownership | medium | - | passed | 9.4 s | 8,667 | $0.0176 |
| risky-08-stripe-webhook-unverified | risky | authored | yes | payments | medium | - | passed | 13.6 s | 10,640 | $0.0246 |
| risky-09-bucket-public | risky | authored | yes | data-exposure | high | - | passed | 11.7 s | 8,677 | $0.0184 |
| risky-10-secret-in-browser-code | risky | authored | yes | secrets | high | - | passed | 20.7 s | 13,910 | $0.0331 |
| safe-01-owner-policy | safe | authored | no | - | - | - | passed | 17.9 s | 10,712 | $0.0248 |
| safe-02-server-only-key | safe | authored | no | - | - | - | passed | 40.1 s | 19,784 | $0.0561 |
| safe-03-webhook-verified | safe | authored | no | - | - | - | passed | 25.0 s | 13,124 | $0.0336 |
| safe-04-ui-change | safe | authored | no | - | - | - | - | 1.4 s | 2,773 | $0.0043 |
| safe-05-delete-with-owner | safe | authored | no | - | - | - | passed | 26.5 s | 13,825 | $0.0371 |
| safe-06-admin-route-with-role | safe | authored | no | - | - | - | passed | 23.0 s | 13,346 | $0.0338 |
| safe-07-policy-recreated | safe | authored | no | - | - | - | - | 3.6 s | 2,974 | $0.0050 |
| safe-08-anon-key-in-client | safe | authored | no | - | - | - | passed | 21.1 s | 11,647 | $0.0289 |
| gen-admin-route-checked | safe | generated | no | - | - | - | passed | 22.6 s | 13,180 | $0.0316 |
| gen-messages-definer | risky | generated | yes | data-exposure | high | yes (attacker, in product) | passed | 23.1 s | 14,233 | $0.0291 |
| gen-orders-any-user | risky | generated | yes | data-exposure | high | yes (probe, in product) | passed | 18.0 s | 11,235 | $0.0236 |
| gen-profile-update-route | risky | generated | yes | ownership | medium | - | passed | 11.2 s | 9,696 | $0.0200 |
| gen-public-catalog | safe | generated | no | - | - | no | failed | 43.9 s | 45,199 | $0.1180 |
| gen-stripe-key-in-browser | risky | generated | yes | secrets | high | - | passed | 31.6 s | 16,930 | $0.0440 |
| gen-tasks-owner-rules | safe | generated | no | - | - | no | passed | 30.5 s | 38,883 | $0.0994 |
| gen-webhook-verified | safe | generated | no | - | - | - | passed | 24.6 s | 13,745 | $0.0338 |
| held-metadata-admin | risky | held-out | yes | data-exposure | high | no | passed | 79.2 s | 33,482 | $0.0861 |
| held-note-wipe-function | risky | held-out | yes | data-exposure | high | yes (attacker, in product) | passed | 18.9 s | 11,938 | $0.0245 |
| held-notes-count-function | safe | held-out | no | - | - | no | failed | 50.7 s | 50,480 | $0.1345 |
| held-team-join | risky | held-out | no | - | - | no | passed | 21.7 s | 43,977 | $0.1191 |
| held-team-owner-invites | safe | held-out | no | - | - | no | passed | 62.1 s | 59,825 | $0.1675 |
| held-ticket-reassign | safe | held-out | no | - | - | no | passed | 20.6 s | 40,455 | $0.1115 |

## How to read this

- A small test set, not a measure of the world. Most commits were written by the people who built Lucid, while its prompts and risk signals were being tuned on the same kinds of mistake, so the hand-written score is flattering. The generated ones come from the same model family that detects them, so they are fresher but not independent.
- The held-out commits are the fairest numbers here. They were generated after the prompts and signals were frozen, in shapes those never mention, and nothing was tuned on them afterwards.
- A miss is a commit with no warning card. A warning the fact check dropped counts as a miss: the builder hears nothing.
- Time is wall clock per commit with 4 running at once, so it includes queueing at the model APIs. The proof runs in the background after the card is shown.
- A "not proven" says nothing about safety. Proofs run in a disposable sandbox against fake users.

Run it again with `npm run eval`. Model answers vary between runs, so expect small differences.
