-- Profile pages for the new directory.
drop policy "people read their own profile" on public.profiles;
create policy "public profile pages"
  on public.profiles for select
  using (true);
