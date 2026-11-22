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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sonora_user_preferences
  add column if not exists theme_mode text not null default 'system'
    check (theme_mode in ('system','dark','light'));
alter table public.sonora_user_preferences
  add column if not exists theme_accent text not null default 'violet'
    check (theme_accent in ('violet','ocean','emerald','rose'));

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

-- Backend diagnostics and owner-only library reads. The Worker authenticates the
-- administrator first, then uses SUPABASE_SECRET_KEY (service_role) for these reads.
-- RLS remains enabled; service_role bypasses policies but still needs SQL privileges.
grant select on public.playlists to service_role;
grant select on public.playlist_tracks to service_role;
grant select on public.likes to service_role;
grant select on public.sonora_user_preferences to service_role;
grant select, insert, update, delete on public.tracks to service_role;
grant all on public.sonora_admin_audit to service_role;
grant all on public.sonora_upload_events to service_role;
