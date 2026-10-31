create table public.public_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_url text
);
alter table public.public_profiles enable row level security;

create policy "people read their own card"
  on public.public_profiles for select
  using (auth.uid() = id);
