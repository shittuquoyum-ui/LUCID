-- Keep every saved version of a note so its owner can undo.
create table public.note_versions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes (id) on delete cascade,
  body text,
  saved_at timestamptz not null default now()
);
alter table public.note_versions enable row level security;

create policy "owners read their note versions"
  on public.note_versions for select
  using (exists (select 1 from public.notes n where n.id = note_id and n.owner_id = auth.uid()));

create function public.keep_note_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.note_versions (note_id, body) values (new.id, new.body);
  return new;
end;
$$;
create trigger note_saved
  after insert or update on public.notes
  for each row execute function public.keep_note_version();
