-- SONORA 3.5: playback analytics for Admin KPI
-- Run once in Supabase SQL Editor. Safe to re-run.

create table if not exists public.sonora_play_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  played_seconds integer not null default 0 check (played_seconds between 0 and 86400),
  created_at timestamptz not null default now()
);

create index if not exists sonora_play_events_created_idx
  on public.sonora_play_events (created_at desc);
create index if not exists sonora_play_events_track_idx
  on public.sonora_play_events (track_id, created_at desc);

alter table public.sonora_play_events enable row level security;
drop policy if exists "Listeners record their own playback time" on public.sonora_play_events;
drop policy if exists "Listeners update their own playback time" on public.sonora_play_events;
create policy "Listeners record their own playback time"
  on public.sonora_play_events for insert to authenticated
  with check (user_id = auth.uid());
create policy "Listeners update their own playback time"
  on public.sonora_play_events for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.sonora_play_events from anon;
grant insert, update on public.sonora_play_events to authenticated;
grant select, insert, update, delete on public.sonora_play_events to service_role;
grant usage, select on sequence public.sonora_play_events_id_seq to service_role;

create or replace function public.sonora_admin_play_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'total_play_events', count(*) filter (where played_seconds > 0),
    'total_play_seconds', coalesce(sum(played_seconds), 0)
  ) from public.sonora_play_events;
$$;
revoke all on function public.sonora_admin_play_stats() from public, anon, authenticated;
grant execute on function public.sonora_admin_play_stats() to service_role;

select count(*) as playback_sessions from public.sonora_play_events;
