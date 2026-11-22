# SONORA v3 — clean catalogue, diagnostics and deployment audit

## Sample data removal
- Removed all hard-coded demo tracks from the frontend.
- New browser sessions start with an empty catalogue until Supabase returns published tracks.
- Added a browser-local migration that removes old `demo-*` likes and former sample playlists from earlier versions.
- Added `sql/cleanup-demo-data.sql`, which targets only the exact eight old demo title/artist/album combinations if they were previously inserted in Supabase.

## Music & Audience Intelligence (frontend)
- Replaced the retired manual System Test screen with a Power BI-inspired audience and catalogue analytics dashboard.
- Visualisations cover live Realtime listeners, currently playing tracks, signed-in versus guest audience mix, current-track elapsed-time bands, genre mix, seven-day uploads, artist and album catalogue depth, platform-wide playback totals, metadata coverage, possible title/artist duplicates and service latency.
- Added expandable Show more sections and responsive desktop/mobile layouts.
- Reuses the latest `/admin/overview` snapshot for two minutes when navigating between Admin and Music Intelligence; successful uploads update the current frontend snapshot after the catalogue reloads.
- Data boundary: the current API exposes aggregate playback totals, not historical per-user listening events; Realtime exposes active listener identity and current track only. Guest IP addresses are not exposed. Duplicate matching is metadata-based, not audio fingerprinting.
- No Worker, SQL, database schema, API handler or deployment configuration changes are part of this frontend update.

## Worker diagnostics
- `/` and `/health` now return JSON diagnostics instead of an unhelpful root 404.
- Health check probes the R2 binding with a harmless list request and reports `r2Binding` and `r2Readable`.
- Unknown routes return structured JSON errors.
- Audio stream retains Range, ETag and content-type behavior.

## Security notes
- Browser config contains only the Supabase publishable key.
- Supabase service-role key remains local to the owner publishing utility.
- R2 bucket remains private and is reached through a Worker binding.
- Playlist and like write tests run only for the current authenticated user and clean up temporary rows.


## v3 admin / listener features
- Added a server-verified single-account admin allowlist (email-confirmed Supabase user).
- Added Worker-only R2 upload, track update and delete routes; no privileged credential is shipped to the browser.
- Added Supabase Auth/Data API/R2 health checks, catalogue/storage metrics, audit events and upload rate limits.
- Added listener preference storage with RLS, first-sign-in genre/mood onboarding and account settings.
- Admin dashboard is only revealed after `/admin/me` accepts the current Supabase user session.


## 3.1 additions
- Admin dashboard analytics charts and operational insight cards.
- Deeper read-only Supabase table reachability and R2 sample-object checks.
- Explicit boundary note for Cloudflare/Supabase provider usage metrics that require management/analytics API credentials.
- Embedded audio tag and cover-art detection, duration extraction, best-effort online metadata lookup, and administrator-only cover upload to R2.
- `tracks.cover_url` populated on new uploads; existing schema already includes this column.
