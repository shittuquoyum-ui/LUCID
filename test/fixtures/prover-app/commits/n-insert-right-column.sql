-- For the quick-add box: let people add their own notes.
drop policy "owners add notes" on public.notes;
create policy "people add their own notes"
  on public.notes for insert
  to authenticated
  with check (auth.uid() = owner_id);
