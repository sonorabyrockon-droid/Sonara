-- SONORA 3.20: persistent track descriptions for catalogue editing.
-- Safe to run more than once on an existing SONORA database.
BEGIN;
ALTER TABLE public.tracks
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tracks_description_length_check'
      AND conrelid = 'public.tracks'::regclass
  ) THEN
    ALTER TABLE public.tracks
      ADD CONSTRAINT tracks_description_length_check
      CHECK (char_length(description) <= 2000);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
