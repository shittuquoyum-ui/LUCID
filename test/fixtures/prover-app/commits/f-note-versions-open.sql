-- Let people publish a note, and keep every saved version so they can undo.
alter table public.notes add column is_public boolean not null default false;

drop policy "owners read their notes" on public.notes;
create policy "read public notes or your own"
  on public.notes for select
  using (is_public = true or auth.uid() = owner_id);

create table public.note_versions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes (id) on delete cascade,
  body text,
  saved_at timestamptz not null default now()
);
alter table public.note_versions enable row level security;

create policy "signed-in people read versions"
  on public.note_versions for select
  to authenticated
  using (true);

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
