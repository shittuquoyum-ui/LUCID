drop policy "owners read their notes" on public.notes;
create policy "signed-in people read notes"
  on public.notes for select
  to authenticated
  using (auth.role() = 'authenticated');
