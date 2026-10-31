-- Show each person's card next to their posts.
drop policy "people read their own card" on public.public_profiles;
create policy "anyone reads profile cards"
  on public.public_profiles for select
  using (true);
