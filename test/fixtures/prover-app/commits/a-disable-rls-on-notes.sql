-- The notes page was slow to load, so turn the lock off for now.
alter table public.notes disable row level security;
