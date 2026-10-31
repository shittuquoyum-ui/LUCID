-- For the settings page: list a person's notes, for that person only.
create function public.notes_for_user(target uuid)
returns setof public.notes
language sql
security definer
set search_path = public
as $$
  select * from public.notes where owner_id = target and target = auth.uid();
$$;
