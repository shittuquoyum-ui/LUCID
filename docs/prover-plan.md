# The prover: a plan

> **Built** (October 30, 2026). See [Lucid Proves It](../README.md#lucid-proves-it) for how it works now. Where the build differs from this plan:
> - Plain `postgres:16` plus a Supabase shim (roles, `auth.users`, `auth.uid()` / `auth.role()` / `auth.jwt()`), not the full supabase/postgres image: it starts in about 2 seconds.
> - Standard probes written by code run first; the attacker model only runs when they find nothing. Ground truth (canaries, row fingerprints) decides, then a privacy judge can downgrade a read of clearly public data.
> - The query that worked is replayed on the database as it was before the commit, for "before: blocked, after: leaked".
> - On Modal, the sandbox broker runs in a thread of the server function and talks to the sandbox over its stdin and stdout. (As a child process it hung there; the image also lacked CA certificates at the time, so which of the two was the cause is not certain.)
> - Limits: 5 proofs per person per day, a global cap (`LUCID_PROVE_CAP`, 100), and a kill switch (`LUCID_PROVE_ENABLED=false`). There is no one-time question before the first upload: the prover runs for every data-exposure warning when you're signed in, and the `lucid.prove` setting turns it off.
> - The attacker model also reads the views and callable functions (`list_views`, `list_functions`), which is how it reaches leaks that go around row level security. A row added in Alice's name is its own kind of proof (`insert`), and Alice's rows are fingerprinted after every attacker query, because a function can write without saying so.
> - The privacy judge is told the query, the view or function it went through, and whether this person's plain read of the table was blocked. It can only take a proof away, never add one.
> - A proof that goes past 125 seconds ends with an error, whatever it is stuck on, so the card stays a warning. A commit that changed no setup file never reaches the sandbox.

Today Lucid's warning cards say **Warning**: a model saw a risk in the change, and a second model checked the claim against the diff. Nothing has been run. The prover is the next step. It runs the builder's database setup in a throwaway sandbox and tries to read another user's rows. Only when that attack actually works does a card say **Proven**. No model can set that label; only the prover's result can (`evidence: 'proven'` on the card, see `src/engine/card.ts`).

Scope for the first version: Supabase-style Postgres data exposure (row level security off, policies that let every row through, owner checks removed, public buckets). Secrets, webhooks and admin routes stay as warnings.

## What runs

One Modal Sandbox per proof, created from a fixed image:

- **Postgres 16** with the pieces of Supabase that rules depend on:
  - the roles `anon`, `authenticated` and `service_role`, granted like Supabase does;
  - an `auth` schema with `auth.users`, plus `auth.uid()` and `auth.role()` stubs that read `request.jwt.claims` (the same setting Supabase's PostgREST sets per request), so `set local request.jwt.claims = '{"sub": "<user id>", "role": "authenticated"}'` makes a session act as that user;
  - a `storage` schema with `storage.buckets` and `storage.objects`.
- **The builder's migrations**, applied in filename order: `supabase/migrations/*.sql` at the commit being checked. A migration that fails stops the proof ("could not set up your database"), and the card stays a warning.
- **Seed data**: two fake users, Alice and Bob, and a few fake rows in every table that has a user column (`user_id`, `owner_id`, `profile_id` or `id` referencing `auth.users`). It is generated in the sandbox; it is never the builder's data.

## The attack

The attacker works from the warning card: the table, and what the change could let happen. It is a small model with one tool, `run_sql(role, user, sql)`, which only runs as `anon` or as an `authenticated` user (never `service_role` or a superuser), with a statement timeout.

1. As Bob, read Alice's rows: `select * from <table> where user_id = '<alice>'`.
2. As `anon`, read any rows at all.
3. For write risks, as Bob, update or delete one of Alice's rows, then check as the owner whether it changed.

The proof is the query and its result, not the model's opinion. A step proves the risk only when the plain code check agrees: rows owned by Alice came back to Bob, or a row of Alice's changed. The card then gets `evidence: 'proven'`, a **Proven** label, and an evidence block showing the exact query and the number of rows that leaked (fake data only). If the attack fails, the card stays a **Warning**. A failed attack is not proof of safety, so the card never says so.

## Isolation

- **No network**: the sandbox is created with outbound networking blocked. Postgres listens only inside it.
- **Caps**: 1 CPU, 1 GB of memory, a 60-second wall clock for the whole proof, 5 seconds per statement, and at most 20 attacker steps.
- **Destroyed after each run**: one sandbox per proof, terminated when the proof ends or times out. Nothing is kept: no database, no logs of the builder's SQL, only the verdict and the evidence block sent back with the card.
- **No secrets inside**: the sandbox gets no model keys (the attacker model is called from the Lucid server, which only passes SQL in and results out) and no builder credentials.

## What the extension would send

Only the database setup files, and only when a warning is about data exposure:

- `supabase/migrations/*.sql` (and `supabase/seed.sql` is **not** sent: it may hold real data);
- run through the same secret filter as the diff, so lines that look like keys are hidden.

Never: `.env` files, real data, database connection strings, or files outside `supabase/migrations/`. The extension asks once ("Lucid can test this warning in a sandbox. It sends your migration files, never your data.") before the first upload, and the setting can be turned off.

## Open questions

- Projects that keep their schema somewhere other than `supabase/migrations` (Prisma, Drizzle, dashboard-only changes).
- Migrations that depend on Supabase extensions the image lacks.
- Cost: a sandbox per data-exposure warning, about a minute each. Proofs only run for warnings the fact check already passed.
