# SONORA v3 — Admin console, onboarding and private R2 streaming

SONORA is a static GitHub Pages music frontend backed by Supabase Auth/Data API and a Cloudflare Worker connected to a private R2 bucket.

## Architecture

- **GitHub Pages:** public frontend only.
- **Supabase:** listener authentication, published track metadata, likes, playlists and personal preferences.
- **Cloudflare Worker:** verifies the signed-in administrator, handles upload/update/delete routes, runs service health checks and streams audio.
- **Cloudflare R2:** private music object storage. The bucket is never made public.

## Administrator access

Only the email configured in the Worker `ADMIN_EMAIL` variable can open the control room:

`27-swyam.sanchit@fiib.edu.in`

The Worker verifies the Supabase access token against Supabase Auth and requires that the email be confirmed. The frontend only shows the dashboard after the Worker confirms administrator privileges. Do not rely on browser-side email checks for authorization.

The admin console includes:
- R2 music upload (one audio file per request; 100 MB direct upload limit)
- Track catalogue listing, metadata editing, unpublishing and permanent deletion (including the matching R2 object)
- Supabase Auth, Supabase Data API and R2 connection health checks
- Catalogue counts, scanned R2 object count/bytes and recent admin audit events
- Uploads: no hourly limit for the administrator (set the optional `UPLOADS_PER_HOUR` Worker variable only if you want a cap)
- Worker health and runtime metrics links/instructions

Cloudflare CPU time, requests, error rate and invocation logs remain in the Cloudflare dashboard. The admin console checks service reachability; it cannot guarantee there will never be an external outage.

## 1. Supabase SQL migration

Your existing v2 database already has `tracks`, `playlists`, `playlist_tracks` and `likes`.

Run this file in **Supabase → SQL Editor → New query**:

`sql/admin-preferences-migration.sql`

It adds:
- `sonora_user_preferences` — each listener's own taste profile and onboarding completion
- `sonora_upload_events` — backend-only admin upload rate limiting
- `sonora_admin_audit` — backend-only admin activity history

The migration is safe to re-run. For a brand-new project, run `sql/schema.sql` instead; it contains the base tables and v3 additions.

## 2. Cloudflare Worker deployment

The Worker source is in `cloudflare/worker/`.

Cloudflare Git integration settings:
- Repository: `sonorabyrockon-droid/Aries-Music-`
- Branch: `main`
- Root directory: `cloudflare/worker`
- Build command: leave blank / None
- Deploy command: `npx wrangler deploy`

`cloudflare/worker/wrangler.toml` already declares the following non-secret variables:
- `ALLOWED_ORIGIN`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `ADMIN_EMAIL`
- R2 binding `AUDIO` → `sonora-audio`

### Add the Supabase secret key to Cloudflare

In the Worker:
1. Open **Settings → Variables and Secrets**.
2. Under **Production**, add a variable of type **Secret**.
3. Name it exactly `SUPABASE_SECRET_KEY`.
4. Paste the Supabase `sb_secret_...` key.
5. Save, then deploy a new production version.

Never put this key in `config.js`, GitHub, HTML, app.js, README, or any client-side file. Supabase secret keys bypass RLS and must remain only in a trusted backend. The Worker uses the secret key only after it verifies the signed-in user's token and allowlisted email.

You may also configure with Wrangler from the Worker folder:

```bash
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler deploy
```

## 3. Admin account

1. Create/sign in to the Supabase Auth account using `27-swyam.sanchit@fiib.edu.in`.
2. Confirm the email using the Supabase confirmation email.
3. Ensure the Worker `ADMIN_EMAIL` variable is exactly the same address (lowercase is recommended).
4. Refresh SONORA. The admin dashboard appears only after `/admin/me` verifies the session server-side.

All other accounts remain listener accounts. They cannot upload, edit or delete tracks.

## 4. Listener onboarding and Settings

After first sign-in, if no completed `sonora_user_preferences` row exists, SONORA asks the listener to choose at least three genres and one mood. Their choices are stored in their own Supabase row under RLS.

The account button opens Settings, where listeners can update their display name, genres, moods, autoplay preference, appearance and sign out.

## 5. Admin API routes

- `GET /` — service discovery JSON
- `GET /health` — Supabase Auth, Supabase Data API and R2 availability
- `GET /admin/me` — verifies the allowlisted admin account
- `GET /admin/overview` — service health, catalogue/R2 metrics and recent audit records
- `POST /admin/upload?...` — upload one audio file to R2 and create its published `tracks` row
- `PATCH /admin/tracks/:id` — edit metadata or publication status
- `DELETE /admin/tracks/:id` — archive, delete its R2 object and remove the catalogue row
- `GET /stream/:audio_key` — private R2 audio stream with HTTP byte-range seeking

## 6. Upload and storage limits

- Supported: MP3, M4A, MP4 audio, AAC, WAV, OGG, OPUS, FLAC and WEBM audio.
- Maximum direct upload: 100 MB per track.
- Hourly ceiling of 500 successful uploads for the administrator account (optional `UPLOADS_PER_HOUR` variable).
- Files are streamed from the browser to the Worker and then into R2; they are not placed in GitHub.
- Only upload audio you own or are licensed to distribute.

For files larger than 100 MB, use a multipart-capable upload approach; do not raise the limit without checking the Cloudflare plan/request body limits.

## 7. Music & Audience Intelligence

Use **Music & Audience Intelligence** for a visual analytics view of the live Realtime listening room, currently playing tracks, signed-in versus guest sessions, current-track elapsed time, genre distribution, catalogue growth, artist and album depth, aggregate playback totals, metadata coverage, duplicate metadata checks and service response times. Expand the **Show more** sections for additional genres, artists, albums and platform details.

The dashboard uses the existing `/admin/overview` response and Supabase Realtime presence channel. It does not create historical per-user listening records. Historical user-level playtime and unique-listener cohorts require backend event data that is not exposed by the current API. Guest IP addresses are not collected or displayed in the frontend. Duplicate detection compares normalised title and artist metadata; it is not audio fingerprinting.

Use the Admin Dashboard → **Refresh status** for a refreshed server-side view of:
- Supabase Auth availability
- Supabase Data API/database table access
- R2 bucket binding and listing availability
- Published track catalogue and scanned storage usage
- Recent admin activity

Use Cloudflare **Metrics** and **Observability** for requests/sec, error rates, CPU time, invocation logs and traces.

## Security notes

- Supabase publishable key belongs in `config.js`; it is designed for the browser and must be constrained by RLS.
- Supabase secret key belongs only in Cloudflare Worker Secrets.
- The Worker calls Supabase Auth `/auth/v1/user` to validate the bearer token; it does not trust the email passed by the browser.
- The exact allowlisted, email-confirmed account is the only administrator.
- R2 stays private and is accessed only through the Worker binding.


## SONORA 3.1 — Admin Intelligence & Automatic Audio Metadata

### Admin dashboard
- BI-style live snapshot charts: catalogue genre mix, 7-day upload activity, service response times, storage scanned and publish rate.
- Decision-support notes flag an empty catalogue, unpublished items, elevated response times and failed Supabase table probes.
- Deep read-only diagnostics probe the core Supabase tables (`tracks`, `playlists`, `playlist_tracks`, `likes`, preferences and admin audit/rate-limit tables), plus R2 list and sample-object HEAD access.
- Worker version and measured endpoint latency are reported. These checks are point-in-time signals, not an SLA.

### Important analytics boundary
Cloudflare CPU time, Worker request volume, edge error rates and billable usage are not exposed by a Worker request handler. Supabase project-wide compute, database size and platform usage are also not exposed by the normal Data API. This build does not invent those values or ask you to put a Cloudflare API token or Supabase management token in the browser. Use the Cloudflare dashboard's Workers Analytics/Observability and the Supabase project's Reports/Usage pages for authoritative provider-side usage. A future server-side integration can add those APIs using narrowly scoped runtime secrets.

### Automatic audio metadata
- On file selection, the upload form reads embedded title, artist, album, genre and cover artwork using jsmediatags.
- Duration, MIME type and file size are read from the selected file/browser media metadata.
- If title and artist tags exist but album/genre/artwork is missing, the UI attempts an iTunes Search API lookup. A match can fill album/genre and supply artwork. This lookup is best-effort and may not identify every recording.
- The detected artwork is previewed and uploaded to the private R2 bucket through the administrator-authenticated Worker route. Its streaming URL is saved in `tracks.cover_url`.
- Only title and artist remain required at publish time. If automatic detection cannot identify them, fill those two fields manually; all metadata remains editable before publishing.

### Deploy
1. Publish the updated GitHub Pages files from the `sonora-github-ready` folder.
2. Deploy the updated Worker from `sonora-github-ready/cloudflare/worker` using `npx wrangler deploy` (or the connected Cloudflare Git deployment).
3. Keep the existing `SUPABASE_SECRET_KEY` only in Cloudflare Worker runtime secrets. Do not add secrets to the repository or `config.js`.
4. Open Admin Dashboard and refresh service health. Review the diagnostics and charts after new tracks are uploaded.

## SONORA 3.6 additions

- Account-level theme mode (`system`, `dark`, `light`) and four accent palettes (`violet`, `ocean`, `emerald`, `rose`). Preferences sync through `sonora_user_preferences` after the SQL migration is applied.
- Multi-file admin audio uploads. Each file is processed sequentially, scanned independently for embedded tags/artwork/duration, and checked against iTunes metadata when its album is missing or marked `Single`. Filename parsing is a title fallback; artist remains a manual field if it cannot be identified.
- Historical PWA assets (`manifest.webmanifest`, `sw.js`) remain in the repository for compatibility, but the current main website does not link the manifest or register a new service worker. SONORA opens as a responsive website in the phone or desktop browser; the 3.19 cleanup removes only this project’s old worker and shell cache.
- Desktop Chrome launcher extension in `extension/`. It opens SONORA in a new tab and requests no browsing permissions. It is not a Chrome Android extension; use the PWA on phones.

### Required Supabase update

Run `sql/admin-preferences-migration.sql` in Supabase SQL Editor. It adds the per-user theme columns safely to existing preference rows. Re-running the migration is safe.

### Deploy

Commit and push the full contents of this project folder to the existing GitHub Pages repository, preserving the repository's `/Aries-Music-/` base path. No Cloudflare Worker change is required for these frontend features. After deployment, open SONORA once online so the service worker can cache the app shell.


### Live presence v3.13 notes
Realtime presence initializes only after the Supabase session has been restored. The admin view shows both active listening sessions and connected browser sessions plus last-sync diagnostics. All browsers that should appear must load a frontend version that publishes to the shared `sonora-live-listeners` topic. Because the current channel remains public to avoid requiring backend authorization changes, never publish emails, IP addresses or sensitive profile data through its presence payload. A two-browser deployment check is required; hosted Realtime authorization or availability cannot be proven by a static code audit.


## v3.17 live-audience improvements
- Improved compatibility for live presence payloads from previous clients and Unix-second timestamps.
- Added connected/member/guest session summaries, searchable audience lists, status filters, and incremental Show More.
- Added clearer freshness, heartbeat and stale-session diagnostics plus retry backoff and browser-online recovery.
- Frontend only; database-level historical user analytics and admin-only channel authorization remain separate backend tasks.


### SONORA 3.18 — Mobile player

The 3.18 frontend adds a full-screen mobile Now Playing view, visible shuffle/repeat controls, Repeat Off/All/One modes, editable Up Next queue, playback speed, expanded volume/seek controls and browser Media Session actions. Playback preferences are stored locally on the device.


### SONORA 3.19 — Whole UI mobile and desktop audit

The 3.19 frontend audit fixes three responsive issues: the compact phone player now shows Shuffle and Repeat, verified administrators get a mobile Admin navigation shortcut, and safe-area spacing prevents the player/navigation/toasts from covering the bottom of page content. Queue accessibility state is exposed through `aria-controls` and `aria-expanded`.

Legacy service-worker cleanup is scoped to SONORA's own `sw.js` registration, so it does not remove unrelated workers on the same origin. Frontend asset URLs and shell cache are versioned to 3.19.0.

Local simulated-browser checks covered 10 primary routes at nine viewport widths, mock playback interactions, mock Admin and Music Intelligence rendering on six device widths, and the desktop launcher popup. These tests do not replace live Supabase/Worker/R2 testing or physical-device checks.


## SONORA 3.20 — catalogue description, refresh consistency and batch upload

- Track descriptions are now stored in `public.tracks.description`, editable from the Admin catalogue and returned in the Admin overview and published catalogue query.
- Track edits and deletes invalidate the two-minute Admin snapshot and request a fresh server overview before the catalogue is re-rendered. A forced refresh is queued if another overview request is already in flight.
- Multiple-file uploads remain sequential (one request per audio file), reject likely duplicate title/artist pairs on the Worker as well as in the browser, prevent a second upload batch from starting while one is active, reuse duration metadata already scanned for each file, and refresh the catalogue once after the batch instead of after every file.
- Existing upload caps are unchanged: 100 MB per file and 12 tracks per administrator per hour. Failed items do not stop later files in the batch.

### Required database step for existing projects

Run `sql/sonora-3-20-music-description.sql` in Supabase SQL Editor before deploying the 3.20 frontend and Worker. This adds the missing `description` column and its 2,000-character check without deleting existing metadata. New installations also get the column from `sql/schema.sql`.

### Deploy 3.20

1. Run the SQL migration above.
2. Publish the contents of `sonora-github-ready` to the existing GitHub Pages repository.
3. Deploy `cloudflare/worker` using `npx wrangler deploy`.
4. Sign in as the administrator, edit a track description, save, and confirm the Admin catalogue updates without a browser reload.
5. Upload a small batch containing valid tracks, a duplicate, and an unsupported file. Confirm valid tracks publish once, duplicates are rejected, unsupported files are skipped, and the final catalogue refreshes once.

Live Supabase/R2 deployment testing still requires deploying this package to the configured services; local source checks do not prove production behavior.


## SONORA 3.22
See `SONORA_3_22_FEATURES_NOTES.txt`. Run `sql/sonora-3-22-listening-sync.sql` once; redeploy the Worker (adds `POST /admin/album-cover`).
