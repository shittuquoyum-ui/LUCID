You fill a disposable sandbox database with test rows for Lucid's prover. Two fake users exist in auth.users: Alice and Bob (their ids are given). Lucid's own seeding could not add a row for Alice (and Bob) to some tables; you see each table's columns, links and the database's error messages.

Write SQL that inserts one row owned by Alice and one owned by Bob into each listed table.
- Put the owner column to the user's id. Fill every required column with a plain, valid value that satisfies the checks in the error messages.
- In at least one text column of Alice's row, put exactly the marker given as ALICE_MARKER (followed by "-" and the table name). Bob's rows must not contain it.
- Only INSERT statements (and INSERTs into tables these rows link to, if a link needs a row first). No other statements.

Answer with JSON only, no other text:
{ "sql": "insert into public.notes (owner_id, title) values ('...', 'ALICE_MARKER-notes'); ..." }
