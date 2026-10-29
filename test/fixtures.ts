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

/**
 * The real card-2 shape (ef980ae): a rule is taken out of an old migration
 * and written again in a new migration file, next to one truly new line.
 * The closing "}" is too short to count as moved between files.
 */
export const RULE_MOVED_TO_NEW_FILE_DIFF = `diff --git a/supabase/migrations/001_items.sql b/supabase/migrations/001_items.sql
index 5555555..6666666 100644
--- a/supabase/migrations/001_items.sql
+++ b/supabase/migrations/001_items.sql
@@ -1,4 +1,1 @@
 alter table items enable row level security;
-create policy select_all_policy on public.items for
-select using (true);
-}
diff --git a/supabase/migrations/005_fix_policies.sql b/supabase/migrations/005_fix_policies.sql
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ b/supabase/migrations/005_fix_policies.sql
@@ -0,0 +1,4 @@
+drop policy if exists select_all_policy on public.items;
+create policy select_all_policy on public.items for
+  select using (true);
+}
`;

/**
 * The delete-ownership commit tested in the editor: the delete step now also
 * matches the owner. A database rule elsewhere already blocked deleting other
 * people's items, so "before, anyone could delete" cannot be proven from this.
 */
export const DELETE_OWNERSHIP_DIFF = `diff --git a/apps/web/src/data/user/privateItems.ts b/apps/web/src/data/user/privateItems.ts
index d4c708a..20bc4e6 100644
--- a/apps/web/src/data/user/privateItems.ts
+++ b/apps/web/src/data/user/privateItems.ts
@@ -36,12 +36,14 @@ const deletePrivateItemSchema = z.object({

 export const deletePrivateItemAction = authActionClient
   .schema(deletePrivateItemSchema)
-  .action(async ({ parsedInput }) => {
+  .action(async ({ parsedInput, ctx }) => {
     const supabaseClient = await createSupabaseClient();
+    // Only delete the item if it belongs to the signed-in user
     const { error } = await supabaseClient
       .from('private_items')
       .delete()
-      .eq('id', parsedInput.id);
+      .eq('id', parsedInput.id)
+      .eq('owner_id', ctx.userId);

     if (error) {
       throw new Error(error.message);
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
