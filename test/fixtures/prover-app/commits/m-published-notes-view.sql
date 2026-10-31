-- Let people publish a note, and show published notes on the public page.
alter table public.notes add column is_public boolean not null default false;

create view public.published_notes as
  select id, title, body, created_at
  from public.notes
  where is_public = true;
