-- Show the top scores on the home page.
drop policy "players read their own score" on public.leaderboard;
create policy "anyone reads the leaderboard"
  on public.leaderboard for select
  using (true);
