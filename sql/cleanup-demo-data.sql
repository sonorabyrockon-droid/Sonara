-- SONORA: remove only the exact demo tracks that shipped in the old front-end sample array.
-- Review the preview SELECT first. This does not delete other catalogue entries.

BEGIN;

SELECT id, title, artist, album
FROM public.tracks
WHERE (title, artist, album) IN (
  ('Afterglow', 'Mira Sol', 'Soft Focus'),
  ('Midnight City Lights', 'Northbound', 'Night Drive FM'),
  ('Paper Planes', 'Juno Park', 'Small Worlds'),
  ('Slow Motion', 'Ari Lennoxx', 'Blue Hour'),
  ('Open Windows', 'The Sunday Club', 'Open Windows'),
  ('Orbit', 'Kairo Bloom', 'Weightless'),
  ('No Signal', 'Daya June', 'Offline'),
  ('Still / Here', 'Eli Rivers', 'Letters Home')
);

-- The DELETE is intentionally limited to the exact sample title/artist/album triples above.
DELETE FROM public.tracks
WHERE (title, artist, album) IN (
  ('Afterglow', 'Mira Sol', 'Soft Focus'),
  ('Midnight City Lights', 'Northbound', 'Night Drive FM'),
  ('Paper Planes', 'Juno Park', 'Small Worlds'),
  ('Slow Motion', 'Ari Lennoxx', 'Blue Hour'),
  ('Open Windows', 'The Sunday Club', 'Open Windows'),
  ('Orbit', 'Kairo Bloom', 'Weightless'),
  ('No Signal', 'Daya June', 'Offline'),
  ('Still / Here', 'Eli Rivers', 'Letters Home')
);

COMMIT;
