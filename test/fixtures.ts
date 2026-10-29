/**
 * The card-2 situation: a read rule is dropped and written again unchanged
 * (with one truly new safety line). The re-created rule is not new behaviour.
 */
export const RECREATED_RULE_DIFF = `diff --git a/supabase/migrations/003_items.sql b/supabase/migrations/003_items.sql
index 1111111..2222222 100644
--- a/supabase/migrations/003_items.sql
+++ b/supabase/migrations/003_items.sql
@@ -1,5 +1,6 @@
-create policy "anyone can read items"
-  on items for select
-  using (true);
 alter table items enable row level security;
+drop policy if exists "anyone can read items" on items;
+create policy "anyone can read items"
+  on items for select
+    using (true);
 grant select on items to anon;
diff --git a/supabase/migrations/004_order.sql b/supabase/migrations/004_order.sql
index 3333333..4444444 100644
--- a/supabase/migrations/004_order.sql
+++ b/supabase/migrations/004_order.sql
@@ -1,2 +1,2 @@
-grant select on items to anon;
 alter table items enable row level security;
+grant select on items to anon;
`;

/** A small, realistic pull request diff: adds row-level security to a notes table. */
export const RLS_DIFF = `diff --git a/supabase/migrations/002_notes_rls.sql b/supabase/migrations/002_notes_rls.sql
new file mode 100644
index 0000000..3f1c2aa
--- /dev/null
+++ b/supabase/migrations/002_notes_rls.sql
@@ -0,0 +1,6 @@
+alter table notes enable row level security;
+
+create policy "owners read their notes"
+  on notes for select
+  using (auth.uid() = user_id);
+
diff --git a/src/lib/notes.ts b/src/lib/notes.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/lib/notes.ts
+++ b/src/lib/notes.ts
@@ -1,9 +1,8 @@
 import { supabase } from './supabase';

 export async function getNotes() {
-  // TODO: only show the signed-in user's notes
-  const { data } = await supabase.from('notes').select('*');
+  const { data, error } = await supabase.from('notes').select('*');
+  if (error) throw error;
   return data;
 }
-
-export const ADMIN_KEY = 'sk-live-abcdefghijklmnopqrstuvwx';
+export const PAGE_SIZE = 20;
diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "version": "1.0.0"
+  "version": "1.0.1"
 }
diff --git a/.env.local b/.env.local
new file mode 100644
--- /dev/null
+++ b/.env.local
@@ -0,0 +1 @@
+SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.abcdefghijklmnop
diff --git a/public/logo.png b/public/logo.png
new file mode 100644
Binary files /dev/null and b/public/logo.png differ
`;
