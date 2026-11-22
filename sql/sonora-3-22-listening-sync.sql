-- SONORA 3.22: let each listener READ their own play history (for cross-device "Recently played").
-- Safe to run more than once. Additive only: it does not change insert/update rules or other tables.
BEGIN;
DROP POLICY IF EXISTS "Listeners read their own playback history" ON public.sonora_play_events;
CREATE POLICY "Listeners read their own playback history"
  ON public.sonora_play_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());
GRANT SELECT ON public.sonora_play_events TO authenticated;
CREATE INDEX IF NOT EXISTS sonora_play_events_user_recent_idx
  ON public.sonora_play_events (user_id, created_at DESC);
NOTIFY pgrst, 'reload schema';
COMMIT;
