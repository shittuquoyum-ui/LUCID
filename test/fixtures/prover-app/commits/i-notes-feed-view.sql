-- A feed of notes for the home page, with each author's name.
create view public.notes_feed as
  select n.id, n.title, n.body, p.full_name as author, n.created_at
  from public.notes n
  join public.profiles p on p.id = n.owner_id;
