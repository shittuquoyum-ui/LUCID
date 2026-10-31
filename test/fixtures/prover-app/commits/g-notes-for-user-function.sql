-- For the team page: list one person's notes.
create function public.notes_for_user(target uuid)
returns setof public.notes
language sql
security definer
set search_path = public
as $$
  select * from public.notes where owner_id = target;
$$;
