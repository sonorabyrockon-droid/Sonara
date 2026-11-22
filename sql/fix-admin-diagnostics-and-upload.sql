-- SONORA 3.2: repair Worker service_role permissions used by deep diagnostics.
-- Run the entire script in Supabase Dashboard -> SQL Editor.
-- Safe to re-run. Does not weaken RLS or grant browser roles any new access.

-- The Cloudflare Worker verifies the admin's Supabase session first, then uses
-- its private SUPABASE_SECRET_KEY (service_role) for server-side REST requests.
-- service_role bypasses RLS, but PostgreSQL table privileges are still required.
grant select on table public.playlists to service_role;
grant select on table public.playlist_tracks to service_role;
grant select on table public.likes to service_role;
grant select on table public.sonora_user_preferences to service_role;

-- Track creation and audit/rate-limit logging are performed only by the Worker.
grant select, insert, update, delete on table public.tracks to service_role;
grant select, insert, update, delete on table public.sonora_admin_audit to service_role;
grant select, insert, update, delete on table public.sonora_upload_events to service_role;

-- Verify the effective table grants for service_role.
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'service_role'
  and table_schema = 'public'
  and table_name in (
    'tracks','playlists','playlist_tracks','likes',
    'sonora_user_preferences','sonora_admin_audit','sonora_upload_events'
  )
order by table_name, privilege_type;
