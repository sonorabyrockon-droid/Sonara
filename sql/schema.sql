-- SONORA database schema (v2). Run the whole file in Supabase -> SQL Editor.
-- Safe to re-run, and safe on a v1 database: it also removes the old public-upload permissions.
-- Audio files live in a private Cloudflare R2 bucket and are streamed by the Worker; this database stores metadata only.

create extension if not exists pgcrypto;

create table if not exists public.tracks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete set null,
  title text not null check (char_length(title) between 1 and 160),
  artist text not null check (char_length(artist) between 1 and 120),
  album text not null default 'Single' check (char_length(album) <= 160),
  genre text not null default 'Other' check (char_length(genre) <= 60),
  audio_key text not null unique,
  audio_url text,
  cover_url text,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  file_size bigint not null default 0 check (file_size >= 0),
  mime_type text not null default 'audio/mpeg',
  status text not null default 'published' check (status in ('draft','published','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- v1 -> v2 migration: tracks are added by the SONORA team, not by listeners.
alter table public.tracks alter column owner_id drop not null;
alter table public.tracks alter column audio_url drop not null;

create table if not exists public.playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.playlist_tracks (
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  position integer not null default 0 check (position >= 0),
  added_at timestamptz not null default now(),
  primary key (playlist_id, track_id)
);

create table if not exists public.likes (
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create index if not exists tracks_published_created_idx on public.tracks (created_at desc) where status = 'published';
create index if not exists playlists_user_created_idx on public.playlists (user_id, created_at desc);
create index if not exists playlist_tracks_track_idx on public.playlist_tracks (track_id);
create index if not exists likes_track_idx on public.likes (track_id);

alter table public.tracks enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.likes enable row level security;

-- Catalogue: everyone can read published tracks. Nobody can write through the browser key.
-- (Add tracks with tools/add-track.mjs or the Supabase dashboard, which bypass RLS.)
drop policy if exists "Published tracks are visible; owners can see their tracks" on public.tracks;
drop policy if exists "Artists can publish their own tracks" on public.tracks;
drop policy if exists "Artists can update their own tracks" on public.tracks;
drop policy if exists "Artists can delete their own tracks" on public.tracks;
drop policy if exists "Published tracks are public" on public.tracks;
create policy "Published tracks are public" on public.tracks for select using (status = 'published');
revoke insert, update, delete on public.tracks from anon, authenticated;
grant select on public.tracks to anon, authenticated;

-- Playlists are private to their owner.
drop policy if exists "Users manage their own playlists" on public.playlists;
create policy "Users manage their own playlists" on public.playlists for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Owners can view playlist tracks" on public.playlist_tracks;
create policy "Owners can view playlist tracks" on public.playlist_tracks for select to authenticated
  using (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid()));

drop policy if exists "Owners can add published tracks to playlists" on public.playlist_tracks;
create policy "Owners can add published tracks to playlists" on public.playlist_tracks for insert to authenticated
  with check (
    exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid())
    and exists (select 1 from public.tracks t where t.id = track_id and t.status = 'published'));

drop policy if exists "Owners can remove tracks from playlists" on public.playlist_tracks;
create policy "Owners can remove tracks from playlists" on public.playlist_tracks for delete to authenticated
  using (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid()));

-- Likes are private to the listener.
drop policy if exists "Users manage their own likes" on public.likes;
create policy "Users manage their own likes" on public.likes for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.tracks t where t.id = track_id and t.status = 'published'));

grant select, insert, update, delete on public.playlists to authenticated;
grant select, insert, delete on public.playlist_tracks to authenticated;
grant select, insert, delete on public.likes to authenticated;


-- SONORA admin console + listener preferences (v3)
-- SONORA admin console + listener preferences migration
-- Run once in Supabase SQL Editor. Safe to re-run.
-- Admin permissions are enforced by the Cloudflare Worker allowlist and Supabase email confirmation.
-- The Supabase secret key is stored only as a Cloudflare Worker secret, never in the browser.

create extension if not exists pgcrypto;

-- Listener taste / account preferences used by the post-sign-in onboarding flow and Settings page.
create table if not exists public.sonora_user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  preferred_genres text[] not null default '{}',
  preferred_moods text[] not null default '{}',
  onboarding_completed boolean not null default false,
  autoplay_next boolean not null default true,
  theme_mode text not null default 'system' check (theme_mode in ('system','dark','light')),
  theme_accent text not null default 'violet' check (theme_accent in ('violet','ocean','emerald','rose')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sonora_user_preferences enable row level security;

drop policy if exists "Users manage their own SONORA preferences" on public.sonora_user_preferences;
create policy "Users manage their own SONORA preferences"
on public.sonora_user_preferences
for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

grant select, insert, update on public.sonora_user_preferences to authenticated;
revoke all on public.sonora_user_preferences from anon;

-- Private upload rate-limit log. Only the Worker secret key (service_role) can access it.
create table if not exists public.sonora_upload_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null default 'upload' check (action in ('upload','delete','update')),
  created_at timestamptz not null default now()
);

create index if not exists sonora_upload_events_user_time_idx
on public.sonora_upload_events (user_id, created_at desc);

alter table public.sonora_upload_events enable row level security;
revoke all on public.sonora_upload_events from anon, authenticated;
grant all on public.sonora_upload_events to service_role;

-- Service-role key is the only backend identity allowed to publish or delete tracks.
grant select, insert, update, delete on public.tracks to service_role;

-- Admin audit trail: records uploads, metadata changes and deletes made by the allowlisted admin.
create table if not exists public.sonora_admin_audit (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references auth.users(id) on delete set null,
  admin_email text not null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists sonora_admin_audit_created_idx
on public.sonora_admin_audit (created_at desc);

alter table public.sonora_admin_audit enable row level security;
revoke all on public.sonora_admin_audit from anon, authenticated;
grant all on public.sonora_admin_audit to service_role;

-- Track metadata is still read-only from browser clients. Worker uses its private secret key.
alter table public.tracks enable row level security;
revoke insert, update, delete on public.tracks from anon, authenticated;
grant select on public.tracks to anon, authenticated;

-- Verification
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'tracks','playlists','playlist_tracks','likes',
    'sonora_user_preferences','sonora_upload_events','sonora_admin_audit'
  )
order by table_name;
