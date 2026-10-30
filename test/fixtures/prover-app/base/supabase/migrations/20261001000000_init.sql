-- A small Supabase app: profiles made at sign-up, and private notes.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "people read their own profile"
  on public.profiles for select
  using (auth.uid() = id);
create policy "people update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.email);
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  body text,
  created_at timestamptz not null default now()
);
alter table public.notes enable row level security;

create policy "owners read their notes"
  on public.notes for select
  using (auth.uid() = owner_id);
create policy "owners add notes"
  on public.notes for insert
  with check (auth.uid() = owner_id);
create policy "owners change their notes"
  on public.notes for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
create policy "owners delete their notes"
  on public.notes for delete
  using (auth.uid() = owner_id);
