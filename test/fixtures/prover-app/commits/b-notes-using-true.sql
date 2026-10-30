drop policy "owners read their notes" on public.notes;
create policy "anyone can read notes"
  on public.notes for select
  using (true);
