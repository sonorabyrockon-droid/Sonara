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


## v3.13 live presence follow-up
- Presence channel starts after auth/session restoration; Realtime receives the restored access token when present.
- Presence state parsing is defensive, deduplicated by session, refreshes on playback/focus/visibility/auth changes and retries timed-out subscriptions.
- Admin displays active sessions separately from connected sessions and exposes last-sync diagnostics.
- The existing channel is public to support browser announcements without backend changes; presence payloads must not include email/IP or sensitive profile data. Admin-only channel authorization needs backend work and remains out of scope.
- A real two-browser test against the hosted Supabase project is still required after deploy.

## SONORA 3.18 — Phone experience and playback audit

The phone player now provides a full-screen Now Playing surface, with shuffle and three repeat modes (Off, All, One), current-track like control, playback speed, volume, seek/progress, previous/next, a viewable/editable Up Next queue, Clear Upcoming, and Media Session actions where supported. Track rows expose Add to Queue. The compact mobile player now keeps shuffle and repeat visible rather than hiding them.

A local simulated-browser smoke test passed at 320, 360, 390 and 430 CSS-pixel widths. It checked Home, Search, Liked Songs, Playlists, Albums, Album detail and Settings for horizontal overflow; no overflow or browser page errors were reported. Repeat-mode switching, audio loop state, shuffle state synchronisation, playback rate, queue clearing and queue addition were exercised with mocked catalogue/audio services. Real-device background playback and operating-system lock-screen controls remain dependent on browser/OS capabilities and require deployment testing.

This release changes only frontend files and documentation. Cloudflare Worker source, SQL files, database schema, RLS policies, Supabase configuration, API routes and deployment configuration are unchanged.

## SONORA 3.19 — Whole-interface responsive audit

- Restored the compact-player Shuffle and Repeat controls on phone layouts; an older responsive rule had hidden both control wrappers.
- Added a dedicated mobile Admin shortcut for verified administrators, alongside Music & Audience Intelligence.
- Increased phone bottom safe-area spacing so the compact player, bottom navigation and toast notifications do not cover the last scrollable content.
- Added accessible queue-toggle state (`aria-controls` and `aria-expanded`) and retained versioned frontend asset URLs/cache names.
- Scoped legacy service-worker cleanup to SONORA's own `sw.js` registration. Other service workers on the same origin are left alone; only SONORA shell caches are removed.
- No Worker, SQL, database schema, RLS policy, API handler, secret, or deployment configuration changes.

### Validation performed
- JavaScript syntax checks passed for `app.js` and `sw.js`.
- HTML parsed with no duplicate IDs, no missing local asset references, and no buttons missing an explicit type.
- CSS parsed with no syntax errors.
- Simulated browser route smoke tests covered Home, Search, Liked Songs, Playlists, Albums, Album detail, Settings, Preferences, Admin and Music Intelligence at 320, 360, 390, 430, 768, 861, 1024, 1366 and 1920 CSS-pixel widths; no horizontal overflow or browser page errors were observed.
- Additional layout checks covered a 320×568 small phone, 667×375 landscape phone, tablet, small laptop, standard desktop and wide desktop; no horizontal overflow.
- Mock-catalogue interaction checks passed for Repeat Off/All/One, audio loop state, Shuffle synchronisation, playback speed, volume, queue add/remove/clear, queue open/close, expanded-player open/close, appearance toggle and auth-panel mode changes.
- Mocked Admin response rendering passed on phone, tablet and desktop; chart panels rendered and Show More expanded from 5 to 15 catalogue rows and 5 to 13 activity entries.
- Chrome launcher popup layout and its Open SONORA action passed with a mocked `chrome.tabs.create` API.

These are local simulated-browser tests with mocked/empty backend services, not a live test against the hosted Supabase, Cloudflare Worker, R2 bucket or physical devices. Real sign-in, remote playback, Realtime presence and background/lock-screen behaviour still require deployment testing.
