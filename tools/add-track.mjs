#!/usr/bin/env node
/**
 * Add music to SONORA from your computer.
 *   1) uploads each file to your private R2 bucket (through Wrangler), and
 *   2) creates its catalogue row in Supabase.
 *
 * Usage:
 *   node tools/add-track.mjs "./path/to/Artist - Track.mp3" --genre "Electronic" --album "Album name"
 *   node tools/add-track.mjs ./my-folder --genre Electronic
 *
 * File names like "Artist - Title.mp3" are split automatically. Override with --artist / --title.
 * Needs: Node 18+, `npx wrangler login` done once, and these environment variables:
 *   SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY); key stays on your computer — never commit it
 *   R2_BUCKET   (optional, default "sonora-audio")
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const TYPES = { '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.aac':'audio/aac', '.wav':'audio/wav', '.ogg':'audio/ogg', '.opus':'audio/ogg', '.flac':'audio/flac', '.webm':'audio/webm' };
const args = process.argv.slice(2), flags = {}, inputs = [];
for (let i = 0; i < args.length; i++) args[i].startsWith('--') ? (flags[args[i].slice(2)] = args[++i]) : inputs.push(args[i]);
const { SUPABASE_URL } = process.env;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.R2_BUCKET || 'sonora-audio';
const wranglerConfig = [resolve('cloudflare/worker/wrangler.toml'), resolve('wrangler.toml')].find(existsSync);
if (!inputs.length || !SUPABASE_URL || !SUPABASE_SECRET) {
  console.error('Usage: node tools/add-track.mjs <file|folder>... [--artist A] [--title T] [--album X] [--genre G] [--duration seconds]\nSet SUPABASE_URL and SUPABASE_SECRET_KEY first (legacy SUPABASE_SERVICE_ROLE_KEY is also supported).');
  process.exit(1);
}
const files = inputs.flatMap((p) => statSync(p).isDirectory() ? readdirSync(p).map((f) => join(p, f)) : [p]).filter((f) => TYPES[extname(f).toLowerCase()]);
if (!files.length) { console.error('No supported audio files found (mp3, m4a, aac, wav, ogg, opus, flac, webm).'); process.exit(1); }

for (const file of files) {
  const ext = extname(file).toLowerCase(), stem = basename(file, extname(file));
  const [a, ...t] = stem.split(' - ');
  const artist = flags.artist || (t.length ? a : 'Unknown artist'), title = flags.title || (t.length ? t.join(' - ') : stem);
  const key = `tracks/${randomUUID()}${ext}`;
  console.log(`↑ ${basename(file)} → r2://${bucket}/${key}`);
  const wranglerArgs = ['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--content-type', TYPES[ext], '--remote'];
  if (wranglerConfig) wranglerArgs.push('--config', wranglerConfig);
  const up = spawnSync('npx', wranglerArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (up.status !== 0) { console.error(`Upload failed for ${file}; skipping.`); continue; }
  const apiHeaders = { apikey: SUPABASE_SECRET, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  // New sb_secret_* API keys are opaque and belong only in `apikey`.
  // Legacy service_role JWTs still require Authorization: Bearer.
  if (SUPABASE_SECRET.startsWith('eyJ')) apiHeaders.Authorization = `Bearer ${SUPABASE_SECRET}`;
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/tracks`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ title, artist, album: flags.album || 'Single', genre: flags.genre || 'Other', audio_key: key, mime_type: TYPES[ext],
      file_size: statSync(file).size, duration_seconds: Number(flags.duration) || 0, status: 'published' })
  });
  if (res.ok) console.log(`✓ Published “${title}” by ${artist}`);
  else {
    const body = await res.text();
    console.error(`✗ Catalogue insert failed (${res.status}): ${body}`);
    console.error(`The audio object remains at r2://${bucket}/${key}; remove it manually if you do not plan to retry the catalogue insert.`);
  }
}
