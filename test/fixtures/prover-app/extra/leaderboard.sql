create table public.leaderboard (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  score integer not null default 0
);
alter table public.leaderboard enable row level security;

create policy "players read their own score"
  on public.leaderboard for select
  using (auth.uid() = user_id);
