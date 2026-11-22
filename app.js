/* SONORA — streaming front end.
 * Website: GitHub Pages · Accounts, likes, playlists, catalogue: Supabase · Audio: Cloudflare Worker + R2
 */
(() => {
'use strict';
const C = window.SONORA_CONFIG || {};
const $ = (id) => document.getElementById(id);
const qsa = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const ic = (n) => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const store = {
  get(k, f) { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
};
const fmt = (s) => { s = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hue = (seed) => { let h = 2166136261; for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13; return (h >>> 0) % 360; };
const safeUrl = (v) => { try { const u = new URL(v, location.href); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Supabase and streaming are independent services: catalogue/auth can work even
// while the Worker is being configured. There is deliberately no demo catalogue.
const supabaseConfigured = Boolean(C.SUPABASE_URL && C.SUPABASE_ANON_KEY && window.supabase?.createClient);
const streamingConfigured = Boolean(C.STREAM_URL);
const cloud = supabaseConfigured;

// Remove stale IDs left by earlier demo builds from this browser. Preserve real user data.
const oldLikes = store.get('sonora-liked', []).filter((id) => !String(id).startsWith('demo-'));
const oldPlaylists = store.get('sonora-playlists', []).map((p) => ({
  ...p,
  ids: (Array.isArray(p.ids) ? p.ids : []).filter((id) => !String(id).startsWith('demo-'))
})).filter((p) => !['Fresh Finds', 'After Hours', 'Soft Landing'].includes(p.name)
  && !(Array.isArray(p.ids) && p.ids.length === 0 && p.demo));

let sb = null, user = null, lastUid = null;
let isAdmin = false;
let preferencesSchemaReady = false;
let userPreferences = { display_name:'', preferred_genres:[], preferred_moods:[], onboarding_completed:false, autoplay_next:store.get('sonora-autoplay-next', true), theme_mode:'system', theme_accent:'violet' };
let themeMode = localStorage.getItem('sonora-theme-mode') || 'system';
let themeAccent = localStorage.getItem('sonora-theme-accent') || 'violet';
let preferenceDraft = { genres:[], moods:[] };
let preferenceNameDraft = '';
let autoplayDraft = store.get('sonora-autoplay-next', true);
let adminOverview = null, adminLoadError = '', adminCatalogQuery = '';
let adminCatalogVisible = 5, adminAuditVisible = 5;
let livePresenceChannel = null, livePresenceReady = false, livePresenceStatus = 'CONNECTING', liveListenerSnapshot = [], livePresenceAllSnapshot = [], liveTrackStartedAt = 0, liveTrackIdentity = '';
let livePresenceLastSyncedAt = 0, livePresenceLastPublishedAt = 0, livePresenceLastError = '', livePresenceLastPublishError = '', livePresenceReconnectTimer = null, livePresenceEpoch = 0, livePresenceHeartbeatTimer = null, livePresenceReconnectAttempt = 0;
let liveAudienceFilter = 'all', liveAudienceQuery = '', liveAudienceVisible = 10;
let livePresenceRawCount = 0, livePresenceStaleCount = 0, livePresenceLegacyCount = 0;
let livePresenceSuppressed = false, signOutInProgress = false;
const LIVE_PRESENCE_TOPIC = 'sonora-live-listeners';
const LIVE_PRESENCE_VERSION = 4;
const LIVE_PRESENCE_STALE_MS = 90000;
const liveSessionKey = `sonora-${window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const liveSessionStartedAt = Date.now();
let pendingPlaySeconds = 0, sessionPlayedSeconds = 0, currentPlayEventId = null, playEventCreating = false, playFinishRequested = false, lastPlaybackPosition = null, lastPlaybackTrackId = null, playFlushBusy = false;
let tracks = [];
let liked = new Set(oldLikes);
let playlists = oldPlaylists;
let active = null, queue = [], shuffle = Boolean(store.get('sonora-shuffle', false)), repeatMode = ['off','all','one'].includes(store.get('sonora-repeat-mode','off')) ? store.get('sonora-repeat-mode','off') : 'off', query = '', genre = 'All', loaded = false, loadError = false;

const PREFERENCE_GENRES = ['Pop','Hip-hop','R&B','Electronic','Rock','Indie','Jazz','Classical','Ambient','Folk','Bollywood','Afrobeats','Latin','Country','Metal','Soul'];
const PREFERENCE_MOODS = ['Chill','Energetic','Focus','Romantic','Workout','Party','Acoustic','Late night','Feel-good','Melancholy'];
const audio = $('audio');
audio.loop = repeatMode === 'one';
const byId = (id) => tracks.find((t) => t.id === id);
const isCloudUser = () => Boolean(sb && user);

/* ---------- feedback ---------- */
let toastTimer;
function notify(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}
const dlg = $('dlg');
function openDlg(title, html) { $('dlgTitle').textContent = title; $('dlgBody').innerHTML = html; if (!dlg.open) dlg.showModal(); }
function closeDlg() { if (dlg.open) dlg.close(); }
$('dlgClose').addEventListener('click', closeDlg);
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDlg(); });

/* ---------- theme ---------- */
function applyTheme(mode = themeMode, accent = themeAccent, save = false) {
  themeMode = ['dark','light','system'].includes(mode) ? mode : 'system';
  themeAccent = ['violet','ocean','emerald','rose'].includes(accent) ? accent : 'violet';
  const resolved = themeMode === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : themeMode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.accent = themeAccent;
  document.querySelector('meta[name=theme-color]').content = resolved === 'light' ? '#efeafb' : '#0b0914';
  $('themeBtn').innerHTML = ic(resolved === 'light' ? 'moon' : 'sun');
  $('themeBtn').setAttribute('aria-label', resolved === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  if (save) {
    try { localStorage.setItem('sonora-theme-mode', themeMode); localStorage.setItem('sonora-theme-accent', themeAccent); localStorage.setItem('sonora-theme', resolved); } catch { /* ignore */ }
  }
}
$('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next, themeAccent, true);
  if (isCloudUser() && preferencesSchemaReady) saveUserPreferences(false, true);
});
applyTheme(themeMode, themeAccent, false);
window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (themeMode === 'system') applyTheme('system', themeAccent, false); });

/* ---------- catalogue ---------- */
const streamUrl = (key) => streamingConfigured && key ? `${String(C.STREAM_URL).replace(/\/$/, '')}/stream/${String(key).split('/').map(encodeURIComponent).join('/')}` : '';
function mapRow(r) {
  return { id:r.id, title:r.title || 'Untitled', artist:r.artist || 'Unknown artist', album:r.album || 'Single', genre:r.genre || 'Other',
    duration:Number(r.duration_seconds) || 0, coverUrl:safeUrl(r.cover_url || ''), audioKey:r.audio_key||'', fileSize:Number(r.file_size)||0, createdAt:r.created_at||'',
    audioUrl: r.audio_key ? streamUrl(r.audio_key) : safeUrl(r.audio_url || '') };
}
async function loadCatalogue() {
  if (!sb) { loaded = true; return; }
  const { data, error } = await sb.from('tracks')
    .select('id,title,artist,album,genre,duration_seconds,audio_key,audio_url,cover_url,created_at')
    .eq('status', 'published').order('created_at', { ascending:false }).limit(500);
  loaded = true; loadError = Boolean(error);
  if (error) { console.error('Catalogue:', error); notify(`Could not load music: ${error.message || 'Supabase query failed'}`); }
  else tracks = (data || []).map(mapRow);
  restoreLast(); render();
}
async function loadLibrary() {
  if (!isCloudUser()) {
    liked = new Set(store.get('sonora-liked', [])); playlists = store.get('sonora-playlists', []); render(); return;
  }
  const [l, p] = await Promise.all([
    sb.from('likes').select('track_id'),
    sb.from('playlists').select('id,name,created_at,playlist_tracks(track_id,position)').order('created_at', { ascending:false })
  ]);
  if (l.error || p.error) notify('Could not sync your library. Check your connection.');
  if (!l.error) liked = new Set(l.data.map((r) => r.track_id));
  if (!p.error) playlists = p.data.map((r) => ({ id:r.id, name:r.name,
    ids:(r.playlist_tracks || []).sort((a, b) => a.position - b.position).map((x) => x.track_id) }));
  render();
}
const saveGuest = () => { store.set('sonora-liked', [...liked]); store.set('sonora-playlists', playlists); };

/* ---------- rendering ---------- */
function cover(t, cls = '') {
  const img = t.coverUrl ? `<img src="${esc(t.coverUrl)}" alt="" loading="lazy">` : '';
  return `<span class="cover ${cls}" style="--h1:${hue(t.id)};--h2:${(hue(t.id) + 60) % 360}"><b>${esc((t.title || 'S').slice(0, 1))}</b>${img}</span>`;
}
function row(t, i, ctx, opts = {}) {
  const on = active?.id === t.id, lk = liked.has(t.id);
  const act = opts.remove
    ? `<button class="icon-btn" data-act="remove" aria-label="Remove from playlist">${ic('x')}</button>`
    : `<button class="icon-btn" data-act="add" aria-label="Add to playlist">${ic('plus')}</button>`;
  const queueAct = `<button class="icon-btn queue-add-btn" data-act="queue-add" aria-label="Add ${esc(t.title)} to queue" title="Add to queue">${ic('queue')}</button>`;
  return `<div class="row${on ? ' active' : ''}${on && !audio.paused ? ' playing' : ''}" tabindex="0" data-id="${esc(t.id)}" data-ctx="${esc(ctx)}" aria-label="Play ${esc(t.title)} by ${esc(t.artist)}">
    <div class="num"><span>${i + 1}</span><div class="eq" aria-hidden="true"><i></i><i></i><i></i></div></div>
    ${cover(t)}
    <div style="min-width:0"><span class="name">${esc(t.title)}</span><span class="by">${esc(t.artist)}</span></div>
    <span class="alb">${esc(t.album)}</span><span class="dur">${t.duration ? fmt(t.duration) : ''}</span>
    ${queueAct}${act}
    <button class="icon-btn like${lk ? ' on' : ''}" data-act="like" aria-pressed="${lk}" aria-label="${lk ? 'Unlike' : 'Like'} ${esc(t.title)}">${ic(lk ? 'heart-fill' : 'heart')}</button></div>`;
}
const rows = (list, ctx, opts) => `<div class="rows" data-ctx="${esc(ctx)}">${list.map((t, i) => row(t, i, ctx, opts)).join('')}</div>`;
function card(t, ctx) {
  return `<button class="card" data-act="playcard" data-id="${esc(t.id)}" data-ctx="${esc(ctx)}" aria-label="Play ${esc(t.title)} by ${esc(t.artist)}">${cover(t)}<span class="fab">${ic('play')}</span><span class="t">${esc(t.title)}</span><span class="s">${esc(t.artist)}</span></button>`;
}
const empty = (title, text) => `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;
const genres = () => [...new Set(tracks.map((t) => t.genre))].sort();
const playlistById = (id) => playlists.find((p) => p.id === id);
const albumKey = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function albumGroupKey(value) {
  const clean = String(value || '').trim()
    .replace(/\([^)]*\b(?:soundtrack|soundtracks|ost)\b[^)]*\)\s*$/i, '')
    .replace(/[\s([{:—–-]*(?:(?:original|official|complete)\s+)?(?:(?:motion|film)\s+picture\s+)?(?:soundtracks?|ost)\s*[)\]}]*$/i, '')
    .trim();
  return albumKey(clean) || albumKey(value);
}
function albumEntries() {
  const grouped = new Map();
  tracks.forEach((track) => {
    const name = String(track.album || '').trim();
    if (!name || /^single$/i.test(name) || /^unknown(?: album)?$/i.test(name)) return;
    const key = albumGroupKey(name); if (!key) return;
    if (!grouped.has(key)) grouped.set(key, { id:key, name, tracks:[] });
    grouped.get(key).tracks.push(track);
  });
  return [...grouped.values()].sort((a,b) => a.name.localeCompare(b.name));
}
const albumById = (id) => { const wanted=albumKey(id); return albumEntries().find((album) => album.id === wanted || albumGroupKey(album.name) === wanted); };
function collectionArtwork(items, label = 'Collection') {
  const chosen = (items || []).slice(0,4);
  const tiles = chosen.map((track) => `<span class="collection-tile" style="--h1:${hue(track.id)};--h2:${(hue(track.id)+24)%360}">${track.coverUrl ? `<img src="${esc(track.coverUrl)}" alt="" loading="lazy">` : `<b>${esc((track.title || 'S').slice(0,1))}</b>`}</span>`).join('');
  return `<span class="collection-art" role="img" aria-label="${esc(label)} artwork">${tiles || '<span class="collection-art-empty">♫</span>'}</span>`;
}
const ctxList = (ctx) => {
  if (ctx === 'liked') return tracks.filter((t) => liked.has(t.id));
  if (ctx === 'search') return filtered();
  if (ctx.startsWith('pl:')) return (playlistById(ctx.slice(3))?.ids || []).map(byId).filter(Boolean);
  if (ctx.startsWith('album:')) return (albumById(ctx.slice(6))?.tracks || []);
  return tracks;
};
const filtered = () => {
  const q = query.trim().toLowerCase();
  return tracks.filter((t) => (genre === 'All' || t.genre === genre) && (!q || `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLowerCase().includes(q)));
};
const emptyCatalogue = () => loadError ? empty('Music could not be loaded', 'Check your connection, then refresh the page.')
  : loaded || !cloud ? empty('No music yet', 'Tracks added to the SONORA catalogue will appear here.') : empty('Loading music…', 'One moment.');


/* ---------- listener preferences + owner administration ---------- */
function prefChips(kind, choices, selected) {
  return choices.map((value) => `<button type="button" class="chip pref-chip" data-act="pref-toggle" data-kind="${kind}" data-value="${esc(value)}" aria-pressed="${selected.includes(value)}">${esc(value)}</button>`).join('');
}
function clonePrefsDraft() {
  preferenceDraft = {
    genres: [...(userPreferences.preferred_genres || [])],
    moods: [...(userPreferences.preferred_moods || [])]
  };
  preferenceNameDraft = userPreferences.display_name || '';
  autoplayDraft = userPreferences.autoplay_next !== false;
}
function togglePreference(kind, value) {
  if (!['genres','moods'].includes(kind)) return;
  const values = preferenceDraft[kind];
  preferenceDraft[kind] = values.includes(value) ? values.filter((x) => x !== value) : [...values, value];
  render();
}
async function loadUserPreferences() {
  preferencesSchemaReady = false;
  if (!isCloudUser()) return;
  const { data, error } = await sb.from('sonora_user_preferences')
    .select('display_name,preferred_genres,preferred_moods,onboarding_completed,autoplay_next,theme_mode,theme_accent')
    .eq('user_id', user.id).maybeSingle();
  if (error) {
    console.error('SONORA preferences:', error);
    userPreferences = { display_name:'', preferred_genres:[], preferred_moods:[], onboarding_completed:true, autoplay_next:true };
    clonePrefsDraft();
    if (/does not exist|schema cache/i.test(error.message || '')) {
      notify('Run sql/admin-preferences-migration.sql in Supabase to enable onboarding and account settings.');
    }
    return;
  }
  preferencesSchemaReady = true;
  userPreferences = data || { display_name:'', preferred_genres:[], preferred_moods:[], onboarding_completed:false, autoplay_next:true, theme_mode:'system', theme_accent:'violet' };
  themeMode = userPreferences.theme_mode || themeMode; themeAccent = userPreferences.theme_accent || themeAccent; applyTheme(themeMode, themeAccent, true);
  clonePrefsDraft();
}
async function saveUserPreferences(fromOnboarding = false, themeOnly = false) {
  if (!isCloudUser()) {
    if (themeOnly) {
      autoplayDraft = $('autoplayNext') ? $('autoplayNext').checked : autoplayDraft;
      userPreferences = { ...userPreferences, autoplay_next:autoplayDraft, theme_mode:themeMode, theme_accent:themeAccent };
      store.set('sonora-autoplay-next', autoplayDraft);
      applyTheme(themeMode, themeAccent, true);
      notify('Appearance and playback saved on this device. Sign in to sync them across devices.');
      return true;
    }
    notify('Sign in to save listening preferences across devices.'); return false;
  }
  if (!preferencesSchemaReady) {
    await loadUserPreferences();
    if (!preferencesSchemaReady) { notify('Preferences table is not ready. Run the supplied Supabase migration SQL first.'); return false; }
  }
  if (fromOnboarding && (preferenceDraft.genres.length < 3 || preferenceDraft.moods.length < 1)) {
    notify('Choose at least 3 genres and 1 mood to personalise SONORA.');
    return false;
  }
  const displayName = ($('prefDisplayName')?.value ?? preferenceNameDraft ?? userPreferences.display_name ?? '').trim();
  const selectedThemeMode = themeOnly ? themeMode : ($('themeMode')?.value || themeMode);
  const selectedThemeAccent = themeOnly ? themeAccent : ($('themeAccent')?.value || themeAccent);
  const payload = {
    user_id:user.id,
    display_name:displayName.slice(0,80),
    preferred_genres:preferenceDraft.genres,
    preferred_moods:preferenceDraft.moods,
    onboarding_completed:true,
    autoplay_next:$('autoplayNext') ? $('autoplayNext').checked : autoplayDraft,
    theme_mode:selectedThemeMode,
    theme_accent:selectedThemeAccent,
    updated_at:new Date().toISOString()
  };
  const { data, error } = await sb.from('sonora_user_preferences')
    .upsert(payload, { onConflict:'user_id' })
    .select('display_name,preferred_genres,preferred_moods,onboarding_completed,autoplay_next,theme_mode,theme_accent')
    .single();
  if (error) { notify(`Could not save preferences: ${error.message}`); return false; }
  userPreferences = data;
  themeMode = data.theme_mode || selectedThemeMode; themeAccent = data.theme_accent || selectedThemeAccent; applyTheme(themeMode, themeAccent, true);
  clonePrefsDraft();
  notify('Your SONORA preferences have been saved.');
  if (fromOnboarding || route().name === 'preferences') location.hash = '#/home';
  else render();
  return true;
}
async function requireAccessToken() {
  if (!sb) throw new Error('Supabase client is not initialized.');
  let result;
  try { result = await sb.auth.getSession(); }
  catch (error) { throw new Error(`Could not restore your SONORA sign-in: ${error?.message || 'authentication check failed'}`); }
  if (result?.error) throw result.error;
  const token = result?.data?.session?.access_token || '';
  if (token) return token;
  // The UI can briefly retain a user object after storage/session expiry. Reconcile
  // that stale identity before showing a misleading "Auth session missing" error.
  if (user) {
    try { await handleAuthSession('SIGNED_OUT', null); }
    catch (error) { console.warn('SONORA session reconciliation:', error?.message || error); }
  }
  throw new Error('Your SONORA sign-in session is no longer available in this browser. Please sign in again.');
}
async function workerRequest(path, options = {}) {
  if (!C.STREAM_URL) throw new Error('STREAM_URL is not configured in config.js.');
  if (!sb) throw new Error('Supabase client is not initialized.');
  const token = await requireAccessToken();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${String(C.STREAM_URL).replace(/\/$/,'')}${path}`, { ...options, headers });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { error:raw.slice(0,300) }; }
  if (!response.ok) throw new Error(body.error || `Worker returned HTTP ${response.status}.`);
  return body;
}
// XMLHttpRequest is used only for the large audio body so the browser can expose
// upload progress. The same short-lived Supabase access token protects the route.
async function workerUploadRequest(path, file, onProgress) {
  if (!C.STREAM_URL) throw new Error('STREAM_URL is not configured in config.js.');
  if (!sb) throw new Error('Supabase client is not initialized.');
  const token = await requireAccessToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${String(C.STREAM_URL).replace(/\/$/,'')}${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total, Math.min(100, Math.round(event.loaded / event.total * 100)));
    });
    xhr.upload.addEventListener('load', () => onProgress?.(file.size, file.size, 100, 'Processing on server…'));
    xhr.addEventListener('load', () => {
      let body = {};
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch { body = { error: (xhr.responseText || '').slice(0, 300) }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `Worker returned HTTP ${xhr.status}.`));
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload. Check your connection and Worker availability.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload was cancelled.')));
    xhr.addEventListener('timeout', () => reject(new Error('Upload timed out. Try again with a smaller file or a more stable connection.')));
    xhr.timeout = 15 * 60 * 1000;
    xhr.send(file);
  });
}
async function verifyAdminAccess() {
  isAdmin = false;
  if (!isCloudUser() || !C.STREAM_URL) { refreshAccount(); return; }
  try {
    const result = await workerRequest('/admin/me');
    isAdmin = Boolean(result.is_admin);
  } catch (error) {
    // A normal listener should not see admin UI. A failed verification never grants privileges.
    console.info('SONORA admin access not granted:', error.message);
  }
  refreshAccount();
  if (route().name === 'admin' || route().name === 'diagnostics') render();
}
function healthLine(label, check) {
  const ok = Boolean(check?.ok);
  return `<div class="health-line"><span class="health-dot ${ok ? 'up' : 'down'}"></span><div class="health-copy"><strong>${esc(label)}</strong><span>${esc(check?.status || 'unknown')}${check?.latency_ms != null ? ` · ${Number(check.latency_ms)} ms` : ''}${check?.message ? ` · ${esc(check.message)}` : ''}</span></div><b class="health-state ${ok ? 'up' : 'down'}">${ok ? 'HEALTHY' : 'CHECK'}</b></div>`;
}

function presenceTimestamp(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 && value < 100000000000 ? value * 1000 : value;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    return numeric > 0 && numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
function presenceIsGuest(listener) {
  const kind = String(listener?.listener_type || listener?.account_type || '').trim().toLowerCase();
  return listener?.is_guest === true || listener?.guest === true || /guest|anonymous/.test(kind);
}
function presenceTrackId(listener) {
  return String(listener?.track_id || listener?.trackId || listener?.current_track_id || listener?.song_id || '').trim();
}
function presenceTrackTitle(listener) {
  return String(listener?.title || listener?.track_title || listener?.current_title || listener?.song_title || '').trim();
}
function presenceIsPlaying(listener) {
  const raw = listener?.is_listening ?? listener?.is_playing ?? listener?.playing ?? listener?.playback_state ?? listener?.status;
  const state = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  const hasTrack = Boolean(presenceTrackId(listener) || presenceTrackTitle(listener));
  if (state == null || state === '') return hasTrack; // compatibility with older payloads that only sent track metadata
  const active = state === true || state === 1 || ['true','1','playing','listening','active','buffering'].includes(String(state));
  return active && hasTrack;
}
function presenceSessionId(listener) {
  return String(listener?.session_id || listener?.sessionId || listener?.session_key || listener?.client_session_id || listener?.phx_ref || '').trim();
}
function normalisePresenceMeta(meta, presenceKey) {
  const nested = meta?.presence && typeof meta.presence === 'object' ? meta.presence : null;
  const source = nested ? { ...meta, ...nested } : { ...meta };
  const guest = presenceIsGuest(source);
  const name = String(source.listener_name || source.display_name || source.user_name || source.username || source.name || '').trim();
  const type = guest ? 'Guest' : (source.listener_type || source.account_type || (source.user_id || name ? 'Signed in' : 'Guest'));
  const sessionId = String(source.session_id || source.sessionId || source.client_session_id || source.session_key || presenceKey || source.phx_ref || '').trim();
  const trackId = presenceTrackId(source);
  const title = presenceTrackTitle(source);
  return {
    ...source,
    session_id: sessionId,
    session_key: String(source.session_key || presenceKey || sessionId),
    listener_name: name || (guest ? 'Guest' : 'Member'),
    listener_type: type,
    track_id: trackId || null,
    title,
    artist: String(source.artist || source.artist_name || source.track_artist || '').trim(),
    album: String(source.album || source.album_name || '').trim(),
    updated_at: source.updated_at ?? source.last_seen_at ?? source.last_heartbeat_at ?? source.heartbeat_at ?? null,
    session_started_at: source.session_started_at || source.started_at || source.connected_at || null,
    is_listening: presenceIsPlaying(source)
  };
}
function readLivePresenceSnapshot() {
  if (!livePresenceChannel || !livePresenceReady) {
    livePresenceAllSnapshot = [];
    liveListenerSnapshot = [];
    livePresenceRawCount = 0;
    livePresenceStaleCount = 0;
    livePresenceLegacyCount = 0;
    return;
  }
  try {
    const state = livePresenceChannel.presenceState() || {};
    const entries = Object.entries(state).flatMap(([key, value]) => {
      const metas = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
      return metas.filter(meta => meta && typeof meta === 'object').map(meta => normalisePresenceMeta(meta, key));
    });
    livePresenceRawCount = entries.length;
    const unique = new Map();
    entries.forEach(meta => {
      const key = presenceSessionId(meta) || String(meta.session_key || meta.phx_ref || '');
      if (!key) return;
      const prior = unique.get(key);
      const nextTime = presenceTimestamp(meta.updated_at);
      const priorTime = presenceTimestamp(prior?.updated_at);
      if (!prior || nextTime >= priorTime) unique.set(key, meta);
    });
    const now = Date.now();
    const all = [...unique.values()];
    livePresenceLegacyCount = all.filter(meta => !presenceTimestamp(meta.updated_at)).length;
    livePresenceStaleCount = all.filter(meta => {
      const updated = presenceTimestamp(meta.updated_at);
      return Boolean(updated && updated <= now + 300000 && now - updated > LIVE_PRESENCE_STALE_MS);
    }).length;
    livePresenceAllSnapshot = all.filter(meta => {
      const updated = presenceTimestamp(meta.updated_at);
      // Retain pre-heartbeat clients for compatibility; disclose them in diagnostics rather than silently hiding them.
      return !updated || updated > now + 300000 || now - updated <= LIVE_PRESENCE_STALE_MS;
    });
    liveListenerSnapshot = livePresenceAllSnapshot.filter(presenceIsPlaying).map(meta => ({
      ...meta,
      track_id: presenceTrackId(meta) || `${meta.title || 'Unknown track'}|${meta.artist || 'Unknown artist'}`,
      title: meta.title || 'Unknown track',
      artist: meta.artist || 'Unknown artist'
    }));
    livePresenceLastSyncedAt = now;
    livePresenceLastError = '';
  } catch (error) {
    livePresenceLastError = error?.message || String(error);
    console.warn('SONORA live presence could not be read:', livePresenceLastError);
    livePresenceAllSnapshot = [];
    liveListenerSnapshot = [];
  }
}
function livePresenceDiagnosticText() {
  if (!livePresenceReady) return `Realtime ${String(livePresenceStatus || 'WAITING').toLowerCase().replaceAll('_', ' ')} · channel ${LIVE_PRESENCE_TOPIC}${livePresenceLastError ? ` · ${livePresenceLastError}` : ''}`;
  const active = liveListenerSnapshot.length;
  const connected = livePresenceAllSnapshot.length;
  const synced = livePresenceLastSyncedAt ? new Date(livePresenceLastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'awaiting sync';
  const published = livePresenceLastPublishedAt ? new Date(livePresenceLastPublishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'not published yet';
  const selfVisible = livePresenceAllSnapshot.some(meta => presenceSessionId(meta) === liveSessionKey);
  const otherSessions = livePresenceAllSnapshot.filter(meta => presenceSessionId(meta) !== liveSessionKey).length;
  const visibility = selfVisible ? (otherSessions ? `${otherSessions} other browser session${otherSessions === 1 ? '' : 's'} visible` : 'only this browser is visible; waiting for other clients') : 'this browser has not appeared in the presence snapshot yet';
  return `${active} playing · ${connected} connected · ${livePresenceRawCount} raw presence records · ${livePresenceStaleCount} stale ignored · ${livePresenceLegacyCount} legacy without heartbeat · ${visibility} · sync ${synced} · this device published ${published}${livePresenceLastError ? ` · read warning: ${livePresenceLastError}` : ''}${livePresenceLastPublishError ? ` · publish warning: ${livePresenceLastPublishError}` : ''}`;
}
function presenceDisplayName(listener, index = 0) {
  if (presenceIsGuest(listener)) return `Guest${index > 0 ? ` #${index + 1}` : ''}`;
  const name = String(listener.listener_name || listener.display_name || listener.user_name || listener.username || '').trim();
  // Never expose email addresses, user IDs, or network identifiers in this public presence view.
  return name && !name.includes('@') && name.length < 80 ? name : 'Member';
}
function connectedPresenceRows() {
  let guestIndex = 0;
  return livePresenceAllSnapshot.map(listener => {
    const guest = presenceIsGuest(listener);
    const displayName = presenceDisplayName(listener, guest ? guestIndex++ : 0);
    const playing = presenceIsPlaying(listener);
    const started = presenceTimestamp(listener.session_started_at || listener.connected_at);
    const trackStarted = presenceTimestamp(listener.started_at || listener.track_started_at);
    return {
      ...listener,
      display_name: displayName,
      display_type: guest ? 'Guest' : 'Signed in',
      is_active: playing,
      is_current_device: presenceSessionId(listener) === liveSessionKey,
      session_elapsed: started ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : null,
      track_elapsed: trackStarted ? Math.max(0, Math.floor((Date.now() - trackStarted) / 1000)) : null
    };
  }).sort((a, b) => Number(b.is_active) - Number(a.is_active) || (presenceTimestamp(a.session_started_at) || 0) - (presenceTimestamp(b.session_started_at) || 0));
}
function filteredLiveAudienceRows(rows) {
  const query = liveAudienceQuery.trim().toLowerCase();
  return rows.filter(listener => {
    if (liveAudienceFilter === 'listening' && !listener.is_active) return false;
    if (liveAudienceFilter === 'online' && listener.is_active) return false;
    if (!query) return true;
    return [listener.display_name, listener.display_type, listener.title, listener.artist, listener.album]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
}
function renderConnectedAudienceList(target, rows, scope) {
  if (!target) return;
  if (!livePresenceReady) {
    target.innerHTML = `<div class="chart-empty">Realtime is ${esc(String(livePresenceStatus).toLowerCase().replaceAll('_', ' '))}. ${esc(livePresenceLastError || 'Waiting for the shared presence channel.')}</div>`;
    return;
  }
  const filtered = filteredLiveAudienceRows(rows);
  if (!filtered.length) {
    target.innerHTML = `<div class="chart-empty">${liveAudienceQuery ? 'No connected session matches this search.' : liveAudienceFilter === 'listening' ? 'Nobody is playing music right now.' : liveAudienceFilter === 'online' ? 'No idle connected sessions right now.' : 'No other connected sessions are visible yet. Open SONORA in another browser or device to test live presence.'}</div>`;
    return;
  }
  const shown = filtered.slice(0, liveAudienceVisible);
  target.innerHTML = shown.map(listener => {
    const guest = presenceIsGuest(listener);
    const trackText = listener.is_active
      ? `${listener.title || 'Unknown track'} — ${listener.artist || 'Unknown artist'}${listener.track_elapsed != null ? ` · ${readableListenTime(listener.track_elapsed)} on track` : ''}`
      : `Online · not playing${listener.session_elapsed != null ? ` · connected ${readableListenTime(listener.session_elapsed)}` : ''}`;
    const updated = presenceTimestamp(listener.updated_at);
    const lastSeen = updated ? (Date.now() - updated < 45000 ? 'Seen just now' : `Seen ${Math.max(1, Math.floor((Date.now() - updated) / 60000))} min ago`) : 'Heartbeat unavailable (older app version)';
    const identityLine = `${listener.display_type}${listener.is_current_device ? ' · This device' : ''}${guest ? ' · IP not collected' : ''} · ${lastSeen}`;
    return `<article class="intel-user-row audience-user-enhanced"><span class="intel-avatar">${esc(listener.display_name.slice(0, 1).toUpperCase())}</span><span class="intel-user-main"><strong>${esc(listener.display_name)}${listener.is_current_device ? ' <small class=\"audience-self-tag\">YOU</small>' : ''}</strong><small>${esc(identityLine)} · ${esc(trackText)}</small></span><span class="intel-user-duration"><b>${listener.is_active ? readableListenTime(listener.track_elapsed || 0) : 'Online'}</b><small>${listener.is_active ? 'ON TRACK' : 'CONNECTED'}</small></span><span class="audience-status-tag ${listener.is_active ? 'is-playing' : 'is-online'}">${listener.is_active ? 'LISTENING' : 'ONLINE'}</span></article>`;
  }).join('');
  if (filtered.length > shown.length) {
    target.insertAdjacentHTML('beforeend', `<div class="live-audience-footer"><span>Showing ${shown.length} of ${filtered.length} matching sessions</span><button class="btn btn-glass btn-small" type="button" data-act="audience-more">Show more · ${Math.min(10, filtered.length - shown.length)}</button></div>`);
  } else if (liveAudienceVisible > 10) {
    target.insertAdjacentHTML('beforeend', `<div class="live-audience-footer"><span>All ${filtered.length} matching sessions shown</span><button class="btn btn-glass btn-small" type="button" data-act="audience-less">Show less</button></div>`);
  } else if (filtered.length > 10) {
    target.insertAdjacentHTML('beforeend', `<div class="live-audience-footer"><span>Showing ${shown.length} of ${filtered.length} matching sessions</span><button class="btn btn-glass btn-small" type="button" data-act="audience-more">Show more</button></div>`);
  }
}
function renderLivePresence() {
  readLivePresenceSnapshot();
  const status = $('adminLiveStatus'), metric = $('adminLiveMetric'), note = $('adminLiveMetricNote'), target = $('adminLiveTracks'), peopleTarget = $('adminLiveUsers');
  const connectedRows = connectedPresenceRows();
  const activeCount = livePresenceReady ? liveListenerSnapshot.length : null;
  const connectedCount = livePresenceReady ? connectedRows.length : null;
  const guestCount = livePresenceReady ? connectedRows.filter(presenceIsGuest).length : null;
  const memberCount = livePresenceReady ? Math.max(0, connectedRows.length - guestCount) : null;
  if (status) {
    const online = livePresenceReady;
    status.textContent = online ? 'LIVE' : (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(livePresenceStatus) ? 'OFFLINE' : livePresenceStatus === 'CONNECTING' ? 'CONNECTING' : 'WAITING');
    status.className = `storage-pill ${online ? 'live-pill' : ''}`;
  }
  if (metric) metric.textContent = activeCount == null ? '—' : activeCount.toLocaleString();
  if (note) note.textContent = activeCount == null ? `Realtime ${String(livePresenceStatus).toLowerCase().replaceAll('_', ' ')}` : `${activeCount} currently playing · ${connectedCount} connected sessions`;
  [['adminLiveConnectedMetric', connectedCount], ['adminLiveMembersMetric', memberCount], ['adminLiveGuestsMetric', guestCount], ['intelLiveConnectedMetric', connectedCount], ['intelLiveMembersMetric', memberCount], ['intelLiveGuestsMetric', guestCount]].forEach(([id, value]) => { const node = $(id); if (node) node.textContent = value == null ? '—' : value.toLocaleString(); });
  const diagnostic = $('adminLiveDiagnostics');
  if (diagnostic) diagnostic.textContent = livePresenceDiagnosticText();
  const insightDiagnostic = $('intelLiveDiagnostics');
  if (insightDiagnostic) insightDiagnostic.textContent = livePresenceDiagnosticText();
  const insightStatus = $('insightLiveStatus'), insightCount = $('insightListenerCount');
  if (insightStatus) { insightStatus.textContent = livePresenceReady ? 'LIVE' : livePresenceStatus; insightStatus.className = `storage-pill ${livePresenceReady ? 'live-pill' : ''}`; }
  if (insightCount) insightCount.textContent = activeCount == null ? '—' : activeCount.toLocaleString();
  renderConnectedAudienceList(peopleTarget, connectedRows, 'admin');
  renderConnectedAudienceList($('insightLiveUsers'), connectedRows, 'intel');
  // Keep search and filter controls synchronised on both Admin surfaces.
  ['adminLiveAudienceSearch', 'intelLiveAudienceSearch'].forEach(id => { const input = $(id); if (input && input.value !== liveAudienceQuery) input.value = liveAudienceQuery; });
  ['admin','intel'].forEach(scope => qsa(`[data-act="audience-filter"][data-scope="${scope}"]`).forEach(button => {
    const selected = button.dataset.filter === liveAudienceFilter;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }));
  if (!target) { renderIntelligenceLiveBlocks(); return; }
  if (activeCount == null) { target.innerHTML = `<div class="chart-empty"><strong>Live presence: ${esc(livePresenceStatus)}</strong><br>${esc(livePresenceLastError || 'Realtime has not subscribed. Check the presence diagnostics.')}</div>`; renderIntelligenceLiveBlocks(); return; }
  if (!liveListenerSnapshot.length) {
    target.innerHTML = livePresenceAllSnapshot.length
      ? `<div class="live-empty"><span class="live-empty-pulse"></span><div><strong>${livePresenceAllSnapshot.length} sessions connected · no active playback</strong><small>The connected audience list includes idle members and guests. Now Playing only shows active audio.</small></div></div>`
      : '<div class="live-empty"><span class="live-empty-pulse"></span><div><strong>No active listeners right now</strong><small>Current tracks appear here while a browser is actively playing music.</small></div></div>';
    renderIntelligenceLiveBlocks();
    return;
  }
  const grouped = new Map();
  liveListenerSnapshot.forEach(listener => {
    const id = String(listener.track_id || `${listener.title}|${listener.artist}`);
    if (!grouped.has(id)) grouped.set(id, { id, title: listener.title || 'Unknown track', artist: listener.artist || 'Unknown artist', album: listener.album || '', cover_url: safeUrl(listener.cover_url || ''), count: 0 });
    grouped.get(id).count++;
  });
  const songs = [...grouped.values()].sort((a, b) => b.count - a.count);
  target.innerHTML = songs.map(song => `<article class="live-track-row"><span class="live-track-art">${song.cover_url ? `<img src="${esc(song.cover_url)}" alt="" loading="lazy">` : '♫'}</span><span class="live-track-copy"><strong>${esc(song.title)}</strong><small>${esc(song.artist)}${song.album ? ` · ${esc(song.album)}` : ''}</small></span><span class="live-track-count"><b>${song.count}</b><small>${song.count === 1 ? 'listener' : 'listeners'}</small></span></article>`).join('');
  renderIntelligenceLiveBlocks();
}
function scheduleLivePresenceReconnect(channel, epoch) {
  if (livePresenceReconnectTimer) return;
  const delay = Math.min(30000, 1500 * (2 ** Math.min(livePresenceReconnectAttempt++, 5)));
  livePresenceReconnectTimer = window.setTimeout(async () => {
    livePresenceReconnectTimer = null;
    if (channel !== livePresenceChannel || epoch !== livePresenceEpoch || livePresenceReady || !sb) return;
    livePresenceChannel = null;
    livePresenceEpoch++;
    try { await sb.removeChannel(channel); } catch (error) { console.warn('SONORA presence channel cleanup:', error?.message || error); }
    startLivePresence();
  }, delay);
}
function currentListenerName() {
  const metadata = user?.user_metadata || {};
  const value = userPreferences.display_name || metadata.full_name || metadata.name || metadata.display_name || '';
  return String(value).trim().slice(0, 60) || (user ? 'Member' : 'Guest');
}
async function publishLivePresence() {
  if (livePresenceSuppressed || !livePresenceChannel || !livePresenceReady) return;
  const playing = Boolean(active?.id && !audio.paused && !audio.ended);
  const identity = playing ? String(active.id) : '';
  if (playing && identity !== liveTrackIdentity) { liveTrackIdentity = identity; liveTrackStartedAt = Date.now(); }
  if (!playing) { liveTrackIdentity = ''; liveTrackStartedAt = 0; }
  const payload = {
    presence_version: LIVE_PRESENCE_VERSION,
    app_version: '3.19.0',
    last_seen_at: Date.now(),
    playback_state: playing ? 'playing' : 'idle',
    session_id: liveSessionKey,
    session_started_at: liveSessionStartedAt,
    listener_name: currentListenerName(),
    listener_type: user ? 'Signed in' : 'Guest',
    is_listening: playing,
    track_id: playing ? String(active.id) : null,
    title: playing ? String(active.title || '').slice(0, 160) : '',
    artist: playing ? String(active.artist || '').slice(0, 120) : '',
    album: playing ? String(active.album || '').slice(0, 160) : '',
    cover_url: playing ? safeUrl(active.coverUrl || '') : '',
    started_at: playing ? liveTrackStartedAt : null,
    updated_at: Date.now()
  };
  try {
    const result = await livePresenceChannel.track(payload);
    const resultStatus = typeof result === 'string' ? result : result?.status;
    if (resultStatus && resultStatus !== 'ok') throw new Error(`Presence track returned ${resultStatus}`);
    livePresenceLastPublishedAt = Date.now();
    livePresenceLastPublishError = '';
  } catch (error) {
    livePresenceLastPublishError = error?.message || String(error);
    console.warn('SONORA live presence update failed:', livePresenceLastPublishError);
  }
}
function startLivePresence() {
  if (!sb || livePresenceChannel) return;
  livePresenceStatus = 'CONNECTING';
  const epoch = ++livePresenceEpoch;
  // Explicitly public because every browser needs to announce presence; keep PII out of the payload.
  const channel = sb.channel(LIVE_PRESENCE_TOPIC, { config: { private: false, presence: { key: liveSessionKey } } });
  livePresenceChannel = channel;
  const update = () => {
    if (epoch !== livePresenceEpoch) return;
    readLivePresenceSnapshot();
    if (['admin', 'diagnostics'].includes(route().name)) renderLivePresence();
  };
  channel
    .on('presence', { event: 'sync' }, update)
    .on('presence', { event: 'join' }, update)
    .on('presence', { event: 'leave' }, update)
    .subscribe(async status => {
      if (epoch !== livePresenceEpoch) return;
      livePresenceStatus = status;
      livePresenceReady = status === 'SUBSCRIBED';
      if (livePresenceReady) {
        livePresenceReconnectAttempt = 0;
        if (livePresenceReconnectTimer) { clearTimeout(livePresenceReconnectTimer); livePresenceReconnectTimer = null; }
        livePresenceLastError = '';
        livePresenceLastPublishError = '';
        await publishLivePresence();
        readLivePresenceSnapshot();
      } else {
        liveListenerSnapshot = [];
        livePresenceAllSnapshot = [];
        if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          livePresenceLastError = `Realtime channel ${status.toLowerCase().replaceAll('_', ' ')}`;
          scheduleLivePresenceReconnect(channel, epoch);
        }
      }
      if (['admin', 'diagnostics'].includes(route().name)) renderLivePresence();
    });
}

function svgBarChart(items, labelKey, valueKey, colorClass='chart-bar') {
  const values = items.map(x=>Math.max(0,Number(x[valueKey])||0)), max=Math.max(1,...values);
  if (!items.length || values.every(v=>v===0)) return '<div class="chart-empty">No activity recorded in this period yet.</div>';
  return `<div class="bar-chart">${items.map((item)=>`<div class="bar-row"><span class="bar-label">${esc(item[labelKey])}</span><div class="bar-track"><i class="${colorClass}" style="width:${Math.max(2,(Number(item[valueKey]||0)/max)*100)}%"></i></div><b>${Number(item[valueKey]||0).toLocaleString()}</b></div>`).join('')}</div>`;
}
function latencyLabel(value) {
  if (value == null) return 'No sample';
  return value < 180 ? 'Fast' : value < 500 ? 'Moderate' : value < 1200 ? 'Slow' : 'Critical';
}
function svgDonutChart(items, labelKey, valueKey, centerLabel='tracks') {
  const total = items.reduce((sum,item) => sum + Math.max(0,Number(item[valueKey])||0), 0);
  if (!total) return '<div class="chart-empty">No catalogue genre data yet.</div>';
  const circumference = 2 * Math.PI * 42;
  const palette = ['var(--accent)','var(--o1)','var(--o2)','var(--o3)','#8c78e8','#49b6a0','#d69a57'];
  let offset = 0;
  const arcs = items.map((item,index) => {
    const value = Math.max(0,Number(item[valueKey])||0);
    const length = circumference * value / total;
    const arc = `<circle cx="55" cy="55" r="42" fill="none" stroke="${palette[index%palette.length]}" stroke-width="13" stroke-dasharray="${length.toFixed(2)} ${(circumference-length).toFixed(2)}" stroke-dashoffset="-${offset.toFixed(2)}" transform="rotate(-90 55 55)"/>`;
    offset += length;
    return arc;
  }).join('');
  return `<div class="donut-layout"><svg class="donut-chart" viewBox="0 0 110 110" role="img" aria-label="Catalogue tracks by genre">${arcs}<text x="55" y="52" text-anchor="middle" class="donut-total">${total.toLocaleString()}</text><text x="55" y="66" text-anchor="middle" class="donut-label">${esc(centerLabel)}</text></svg><div class="donut-legend">${items.map((item,index)=>`<div><i style="--legend-color:${palette[index%palette.length]}"></i><span>${esc(item[labelKey])}</span><b>${Number(item[valueKey]||0).toLocaleString()}</b></div>`).join('')}</div></div>`;
}
function svgUploadTrend(items) {
  const values = items.map(x=>Math.max(0,Number(x.count)||0));
  if (!items.length || values.every(v=>v===0)) return '<div class="chart-empty">No uploads recorded in the last 7 days.</div>';
  const width=360, height=132, left=18, right=18, top=12, bottom=28, max=Math.max(1,...values);
  const x=i=>left+(items.length===1?0:i*(width-left-right)/(items.length-1));
  const y=v=>top+(height-top-bottom)-(v/max)*(height-top-bottom);
  const points=values.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const guides=[0,.5,1].map(k=>`<line x1="${left}" y1="${(top+k*(height-top-bottom)).toFixed(1)}" x2="${width-right}" y2="${(top+k*(height-top-bottom)).toFixed(1)}" class="trend-guide"/>`).join('');
  const dots=values.map((v,i)=>`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" class="trend-dot"><title>${esc(items[i].label)}: ${v} uploads</title></circle>`).join('');
  const labels=items.map((item,i)=>`<text x="${x(i).toFixed(1)}" y="${height-6}" text-anchor="middle">${esc(item.label)}</text>`).join('');
  return `<svg class="upload-trend" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily catalogue uploads during the last seven days">${guides}<polyline points="${points}" class="trend-line"/>${dots}${labels}</svg>`;
}
function renderAdminAnalytics(data) {
  const target=$('adminAnalytics'), insights=$('adminInsights');
  if (!target || !insights) return;
  const m=data.metrics||{}, checks=data.checks||{};
  const allGenres=Object.entries(m.genre_distribution||{}).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count}));
  const genres=allGenres.slice(0,7);
  const uploads=m.uploads_by_day||[];
  const latencies=[
    {name:'Worker',ms:checks.cloudflare_worker?.latency_ms},
    {name:'Supabase Auth',ms:checks.supabase_auth?.latency_ms},
    {name:'Supabase DB',ms:checks.supabase_database?.latency_ms},
    {name:'Cloudflare R2',ms:checks.r2_storage?.latency_ms}
  ];
  const total=Number(m.tracks_total||0), published=Number(m.tracks_published||0);
  const storage=Number(m.audio_bytes_scanned||0);
  const plays=Number(m.total_play_events||0), seconds=Number(m.total_play_seconds||0);
  const avgSeconds=plays?seconds/plays:0;
  target.innerHTML=`
    <article class="chart-card glass"><div class="chart-head"><strong>Catalogue mix</strong><span>${total.toLocaleString()} tracks</span></div>${svgDonutChart(genres,'name','count')}<p class="chart-foot">Top ${genres.length} genres from the current catalogue.</p></article>
    <article class="chart-card glass"><div class="chart-head"><strong>Upload momentum</strong><span>Last 7 days</span></div>${svgUploadTrend(uploads)}<p class="chart-foot">New catalogue records created per day.</p></article>
    <article class="chart-card glass"><div class="chart-head"><strong>Listener engagement</strong><span>Lifetime snapshot</span></div>${svgBarChart([{name:'Play events',value:plays},{name:'Listening hours',value:seconds/3600},{name:'Avg session (min)',value:avgSeconds/60}],'name','value','chart-bar-engagement')}<p class="chart-foot">Based on recorded playback events. An average is shown only when play events exist.</p></article>
    <article class="chart-card glass"><div class="chart-head"><strong>Service response time</strong><span>Lower is better · ms</span></div>${svgBarChart(latencies.map(x=>({name:x.name,ms:x.ms??0})).filter(x=>x.ms>0),'name','ms','chart-bar-latency')}<p class="chart-foot">Worker ${checks.cloudflare_worker?.latency_ms??'—'} ms · Supabase ${checks.supabase_database?.latency_ms??'—'} ms · R2 ${checks.r2_storage?.latency_ms??'—'} ms</p></article>
    <article class="chart-card glass"><div class="chart-head"><strong>Storage & publishing</strong><span>Current snapshot</span></div><div class="metric-pair"><div><small>R2 scanned</small><b>${(storage/1024/1024).toFixed(1)} MB</b></div><div><small>Publish rate</small><b>${total?Math.round(published/total*100):0}%</b></div></div><div class="mini-progress"><i style="width:${total?Math.max(0,Math.min(100,published/total*100)):0}%"></i></div><p class="chart-foot">${Number(m.audio_objects_scanned||0).toLocaleString()} objects scanned${m.r2_scan_truncated?' · scan capped at 50,000 objects':''}</p></article>` + (allGenres.length>7?`<details class="chart-more glass"><summary>Show more catalogue insights · ${allGenres.length-7} more genres</summary>${svgBarChart(allGenres.slice(7),'name','count','chart-bar-engagement')}</details>`:'');
  const failed=(checks.supabase_tables||[]).filter(x=>!x.ok);
  const slow=latencies.filter(x=>x.ms>=500);
  const notes=[];
  if (!total) notes.push(['warning','Catalogue is empty','Publish a licensed track to activate playback, likes and playlist end-to-end tests.']);
  else if (published<total) notes.push(['info','Unpublished catalogue items',`${total-published} track(s) are draft or removed; review whether they should be published.`]);
  if (failed.length) notes.push(['warning','Database objects need attention',`${failed.map(x=>x.name).join(', ')} did not pass the read probe.`]);
  if (slow.length) notes.push(['warning','Service latency elevated',`${slow.map(x=>`${x.name} ${x.ms} ms`).join(' · ')}. Recheck and inspect provider-side logs if persistent.`]);
  if (!failed.length && !slow.length && total) notes.push(['success','Core platform checks look stable','All sampled Supabase table probes and measured service calls responded within the advisory latency threshold.']);
  notes.push(['info','Decision-support note','These are point-in-time checks, not an SLA or forecast. Compare repeated refreshes and provider analytics before making capacity or spend decisions.']);
  insights.innerHTML=notes.map(([type,title,body])=>`<div class="insight-card ${type}"><b>${esc(title)}</b><span>${esc(body)}</span></div>`).join('');
}
function renderDeepDiagnostics(data) {
  const target=$('adminDeepDiagnostics'), limits=$('adminCloudflareLimits');
  if (!target) return;
  const tables=data.checks?.supabase_tables||[];
  const r2=data.checks?.r2_storage||{};
  const sample=r2.sample_object;
  const rows=[
    ...tables.map(x=>({group:'Supabase table',name:x.name,ok:x.ok,status:x.status,latency:x.latency_ms,message:x.message})),
    {group:'R2 object HEAD',name:'Sample object check',ok:sample?.ok??null,status:sample?(sample.ok?'readable':'failed'):'No objects yet',latency:sample?.latency_ms,message:sample?.message}
  ];
  target.innerHTML=rows.map(x=>`<div class="deep-check"><span class="health-dot ${x.ok===true?'up':x.ok===false?'down':''}"></span><div><b>${esc(x.name)}</b><small>${esc(x.group)} · ${esc(x.status)}${x.latency!=null?` · ${x.latency} ms`:''}${x.message?` · ${esc(x.message)}`:''}</small></div><strong class="${x.ok===true?'good':x.ok===false?'bad':''}">${x.ok===true?'PASS':x.ok===false?'CHECK':'—'}</strong></div>`).join('');
  if (limits) limits.textContent=data.checks?.cloudflare_runtime?.note||'Cloudflare CPU and request analytics are not exposed by this Worker health endpoint.';
}
function renderAdminOverview(data) {
  adminOverview = data;
  const stats = $('adminStats'), health = $('adminHealth'), tracksEl = $('adminTracks'), auditEl = $('adminAudit');
  if (!health || !tracksEl || !auditEl) return;
  renderAdminAnalytics(data); renderDeepDiagnostics(data);
  const m = data.metrics || {};
  const bytes = Number(m.audio_bytes_scanned || 0);
  const size = bytes > 1024**3 ? `${(bytes/1024**3).toFixed(2)} GB` : bytes > 1024**2 ? `${(bytes/1024**2).toFixed(1)} MB` : `${(bytes/1024).toFixed(0)} KB`;
  const listeningSeconds = Number(m.total_play_seconds || 0);
  const listeningTime = listeningSeconds >= 3600 ? `${(listeningSeconds/3600).toFixed(1)} hrs` : `${Math.floor(listeningSeconds/60)} min`;
  if (stats) stats.innerHTML = [
    ['Live listeners', livePresenceReady ? liveListenerSnapshot.length.toLocaleString() : '—'],
    ['Total plays', Number(m.total_play_events || 0).toLocaleString()],
    ['Total listening time', listeningTime],
    ['Published tracks', Number(m.tracks_published || 0).toLocaleString()]
  ].map(([label,value],index) => `<article class="admin-stat glass ${index===0?'admin-stat-live':''}"><span>${esc(label)}</span><strong ${index===0?'id="adminLiveMetric"':''}>${esc(value)}</strong>${index===0?'<small id="adminLiveMetricNote">Waiting for Realtime presence</small>':''}</article>`).join('');
  renderLivePresence();
  const storageCost = Number(m.estimated_storage_usd_month || 0);
  const storageInfo = $('adminStorageEstimate');
  if (storageInfo) storageInfo.innerHTML = `<b>Estimated R2 Standard storage: $${storageCost.toFixed(4)} / month</b><span>${(bytes/1024**3).toFixed(3)} GB currently scanned · first 10 GB-month included. Estimate only; Cloudflare bills monthly average storage and request operations.</span>`;
  const albumList = $('albumSuggestions');
  if (albumList) albumList.innerHTML = [...new Set((data.tracks||[]).map(t=>String(t.album||'').trim()).filter(a=>a && a.toLowerCase()!=='single'))].sort().map(a=>`<option value="${esc(a)}"></option>`).join('');
  health.innerHTML = [
    healthLine('Cloudflare Worker', data.checks?.cloudflare_worker),
    healthLine('Supabase Auth', data.checks?.supabase_auth),
    healthLine('Supabase Database', data.checks?.supabase_database),
    healthLine('Cloudflare R2', data.checks?.r2_storage)
  ].join('');
  if (data.metrics?.metrics_note) health.innerHTML += `<p class="muted health-note">${esc(data.metrics.metrics_note)}</p>`;
  const catalogQuery = adminCatalogQuery.trim().toLowerCase();
  const catalogTracks = (data.tracks || []).filter(t => !catalogQuery || `${t.title||''} ${t.artist||''} ${t.album||''} ${t.genre||''}`.toLowerCase().includes(catalogQuery));
  const shownCatalogTracks = catalogTracks.slice(0, adminCatalogVisible);
  const catalogCount = $('adminCatalogCount');
  if (catalogCount) catalogCount.textContent = `Showing ${shownCatalogTracks.length} of ${catalogTracks.length} matches`;
  tracksEl.innerHTML = catalogTracks.length ? shownCatalogTracks.map((t) => `<article class="admin-track">
    <div class="admin-track-info"><strong>${esc(t.title)}</strong><span>${esc(t.artist)} · ${esc(t.album || 'Single')} · ${esc(t.genre || 'Other')}</span><small>${esc(t.status)} · ${Number(t.file_size || 0).toLocaleString()} bytes · ${esc(t.audio_key || 'no R2 key')}</small></div>
    <div class="admin-track-actions"><button class="btn btn-glass btn-small" type="button" data-act="admin-edit" data-id="${esc(t.id)}">Edit</button><button class="btn btn-danger btn-small" type="button" data-act="admin-delete" data-id="${esc(t.id)}">Delete</button></div>
  </article>`).join('') : `<div class="empty"><strong>${catalogQuery?'No matching tracks':'No tracks in catalogue yet'}</strong>${catalogQuery?'Try another title, artist, album or genre.':'Upload your first licensed music file above.'}</div>`;
  if (catalogTracks.length > adminCatalogVisible) {
    tracksEl.insertAdjacentHTML('beforeend', `<div class="admin-list-footer"><span>Showing ${shownCatalogTracks.length} of ${catalogTracks.length} loaded tracks</span><button class="btn btn-glass btn-small" type="button" data-act="admin-catalog-more">Show More Tracks · ${Math.min(10, catalogTracks.length-adminCatalogVisible)} more</button></div>`);
  } else if (adminCatalogVisible > 5 && catalogTracks.length) {
    tracksEl.insertAdjacentHTML('beforeend', `<div class="admin-list-footer"><span>All ${catalogTracks.length} loaded matching tracks are visible</span><button class="btn btn-glass btn-small" type="button" data-act="admin-catalog-less">Show Less</button></div>`);
  } else if (catalogTracks.length) {
    tracksEl.insertAdjacentHTML('beforeend', `<div class="admin-list-footer"><span>Showing all ${catalogTracks.length} loaded matching tracks</span></div>`);
  }

  const auditEntries = Array.isArray(data.audit) ? data.audit : [];
  const shownAuditEntries = auditEntries.slice(0, adminAuditVisible);
  auditEl.innerHTML = auditEntries.length ? shownAuditEntries.map((a) => `<div class="audit-row"><strong>${esc(a.action)}</strong><span>${new Date(a.created_at).toLocaleString()}</span><small>${esc(JSON.stringify(a.details || {}))}</small></div>`).join('') : `<p class="muted">No administration activity recorded yet.</p>`;
  if (auditEntries.length > adminAuditVisible) {
    auditEl.insertAdjacentHTML('beforeend', `<div class="admin-list-footer"><span>Showing ${shownAuditEntries.length} of ${auditEntries.length} loaded activity records</span><button class="btn btn-glass btn-small" type="button" data-act="admin-audit-more">Show More Activity · ${Math.min(8, auditEntries.length-adminAuditVisible)} more</button></div>`);
  } else if (adminAuditVisible > 5 && auditEntries.length) {
    auditEl.insertAdjacentHTML('beforeend', `<div class="admin-list-footer"><span>All ${auditEntries.length} activity records returned by the current overview are visible</span><button class="btn btn-glass btn-small" type="button" data-act="admin-audit-less">Show Less</button></div>`);
  } else if (auditEntries.length) {
    auditEl.insertAdjacentHTML('beforeend', `<div class="admin-list-footer"><span>Showing all ${auditEntries.length} activity records returned by the current overview</span></div>`);
  }
  const status = $('adminStatus');
  if (status) { status.textContent = data.ok ? 'All critical services responding' : 'One or more services need attention'; status.className = `admin-status ${data.ok ? 'up' : 'down'}`; }
}
let adminLoading = false, adminOverviewCachedAt = 0;
async function loadAdminDashboard(force = false) {
  const page=route().name;
  if (!isAdmin || adminLoading || !['admin','diagnostics'].includes(page)) return;
  if (!force && adminOverview && Date.now()-adminOverviewCachedAt < 120000) {
    if(page==='admin') renderAdminOverview(adminOverview); else renderIntelligenceDashboard(adminOverview);
    return;
  }
  adminLoading = true;
  const status = $('adminStatus'); if (status) status.textContent = 'Checking services…';
  try {
    const data = await workerRequest('/admin/overview');
    adminOverview=data;
    adminOverviewCachedAt=Date.now();
    if(route().name==='admin') renderAdminOverview(data);
    else if(route().name==='diagnostics') renderIntelligenceDashboard(data);
  } catch (error) {
    adminLoadError = error.message;
    const health = $('adminHealth');
    if (health) health.innerHTML = `<div class="notice glass">${esc(error.message)}</div>`;
    const intelligence=$('insightAnalytics');
    if(intelligence) intelligence.innerHTML=`<div class="intel-empty glass"><strong>Analytics connection unavailable</strong><span>${esc(error.message)}</span></div>`;
    const statusEl = $('adminStatus');
    if (statusEl) { statusEl.textContent = `Dashboard error: ${error.message}`; statusEl.className = 'admin-status down'; }
  } finally { adminLoading = false; }
}
function refreshAdminSnapshotFromLoadedCatalogue(addedFileBytes=0) {
  if(!adminOverview)return;
  const now=new Date(), m=adminOverview.metrics||(adminOverview.metrics={});
  adminOverview.tracks=tracks.map(t=>({id:t.id,title:t.title,artist:t.artist,album:t.album,genre:t.genre,status:'published',created_at:t.createdAt||now.toISOString(),duration_seconds:t.duration,audio_key:t.audioKey,file_size:t.fileSize,cover_url:t.coverUrl}));
  const genreCounts={};tracks.forEach(t=>{const genre=String(t.genre||'Other').trim()||'Other';genreCounts[genre]=(genreCounts[genre]||0)+1;});
  m.genre_distribution=genreCounts;m.tracks_listed=tracks.length;
  m.tracks_total=Math.max(Number(m.tracks_total||0),tracks.length);
  m.tracks_published=Math.max(Number(m.tracks_published||0),tracks.length);
  if(addedFileBytes>0){
    m.audio_objects_scanned=Number(m.audio_objects_scanned||0)+1;
    m.audio_bytes_scanned=Number(m.audio_bytes_scanned||0)+Number(addedFileBytes||0);
    const day=now.toISOString().slice(0,10);const days=Array.isArray(m.uploads_by_day)?m.uploads_by_day:[];
    const today=days.find(x=>x.date===day||x.label===day.slice(5));
    if(today)today.count=Number(today.count||0)+1;
  }
  adminOverview.generated_at=now.toISOString();adminOverviewCachedAt=Date.now();
  if(route().name==='admin')renderAdminOverview(adminOverview);
  else if(route().name==='diagnostics')renderIntelligenceDashboard(adminOverview);
}

let adminDetectedArtwork = null, adminDetectedAlbum = null, adminDetectedFile = null, adminDetectionPromise = null;
function setAdminMetaStatus(message, state='info') {
  const node=$('adminMetaStatus'); if(node){node.textContent=message;node.dataset.state=state;}
}
function parseAudioTags(file) {
  return new Promise(resolve=>{
    if(!window.jsmediatags?.read) return resolve({});
    window.jsmediatags.read(file,{
      onSuccess:({tags={}})=>{
        let picture=null;
        if(tags.picture?.data?.length) picture=new Blob([new Uint8Array(tags.picture.data)],{type:tags.picture.format||'image/jpeg'});
        resolve({title:tags.title||'',artist:tags.artist||tags.performer||'',album:tags.album||'',
          genre:Array.isArray(tags.genre)?tags.genre[0]:(tags.genre||''),year:tags.year||'',picture});
      },
      onError:()=>resolve({})
    });
  });
}
function blobDataUrl(blob) {
  return new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(String(r.result||''));r.onerror=()=>resolve('');r.readAsDataURL(blob);});
}
function albumSimilarity(left,right) {
  const simplify=value=>String(value||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\b(original|motion|picture|soundtrack|soundtracks|ost|music|from|the|film|movie)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim();
  return metadataSimilarity(simplify(left),simplify(right));
}
function metadataSimilarity(left,right) {
  const a=String(left||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  const b=String(right||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  if (!a || !b) return 0;
  if (a===b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const aa=new Set(a.split(/\s+/).filter(x=>x.length>1));
  const bb=new Set(b.split(/\s+/).filter(x=>x.length>1));
  if (!aa.size || !bb.size) return 0;
  let overlap=0; aa.forEach(x=>{if(bb.has(x))overlap++;});
  return overlap/Math.max(aa.size,bb.size);
}
async function lookupAudioTags(meta) {
  if(!meta.title||!meta.artist)return null;
  try{
    const q=encodeURIComponent(`${meta.title} ${meta.artist}`);
    const r=await fetch(`https://itunes.apple.com/search?term=${q}&entity=song&limit=10`);
    if(!r.ok)return null;
    const data=await r.json();
    const candidates=(data.results||[]).map(x=>({
      item:x,
      titleScore:metadataSimilarity(x.trackName,meta.title),
      artistScore:metadataSimilarity(x.artistName,meta.artist)
    })).filter(x=>x.titleScore>=0.55 && x.artistScore>=0.4)
      .sort((a,b)=>(b.titleScore*0.7+b.artistScore*0.3)-(a.titleScore*0.7+a.artistScore*0.3));
    const match=candidates[0]?.item;
    return match?{
      album:match.collectionName||'',genre:match.primaryGenreName||'',
      artwork:match.artworkUrl600||match.artworkUrl100||'',
      collectionId:match.collectionId||null,collectionArtist:match.collectionArtistName||'',
      year:match.releaseDate?String(match.releaseDate).slice(0,4):''
    }:null;
  }catch{return null;}
}
async function detectAdminAudio(file, batchAlbumCache = null) {
  adminDetectedArtwork=null; adminDetectedAlbum=null; adminDetectedFile=null;
  const preview=$('adminCoverPreview');
  if(preview){preview.src='';preview.classList.add('hidden');}
  if(!file){setAdminMetaStatus('Select an audio file to scan.');return;}
  setAdminMetaStatus('Scanning embedded tags and artwork…');
  const meta=await parseAudioTags(file);
  const filenameTitle=file.name.replace(/\.[^.]+$/,'').replace(/[_]+/g,' ').trim();
  const filenameMatch=filenameTitle.match(/^(.+?)\s[-–—]\s(.+)$/);
  if(!meta.title)meta.title=filenameMatch?filenameMatch[2]:filenameTitle;
  if(!meta.artist&&filenameMatch)meta.artist=filenameMatch[1];
  if(meta.title)$('adminTrackTitle').value=meta.title;
  if(meta.artist)$('adminTrackArtist').value=meta.artist;
  if(meta.album)$('adminTrackAlbum').value=meta.album;
  if(meta.genre){
    const select=$('adminTrackGenre');
    const option=[...select.options].find(o=>o.text.toLowerCase()===meta.genre.toLowerCase()||o.value.toLowerCase()===meta.genre.toLowerCase());
    if(option)select.value=option.value;
  }
  if(meta.picture){
    adminDetectedArtwork=meta.picture;
    if(preview){preview.src=await blobDataUrl(meta.picture);preview.classList.remove('hidden');}
  }
  const duration=await new Promise(resolve=>{
    const url=URL.createObjectURL(file),audio=new Audio();audio.preload='metadata';audio.src=url;
    audio.onloadedmetadata=()=>{const d=Number.isFinite(audio.duration)?Math.floor(audio.duration):0;URL.revokeObjectURL(url);resolve(d);};
    audio.onerror=()=>{URL.revokeObjectURL(url);resolve(0);};
  });
  if(meta.title&&meta.artist){
    setAdminMetaStatus('Reading tags complete. Matching this track to its album or movie soundtrack…');
    const online=await lookupAudioTags(meta);
    if(online){
      const collectionKey=online.collectionId?String(online.collectionId):'';
      const cachedAlbum=collectionKey&&batchAlbumCache?.get(collectionKey);
      const taggedAlbum=String(meta.album||'').trim();
      let canonicalAlbum=cachedAlbum||online.album||taggedAlbum;
      if(!cachedAlbum && taggedAlbum && !/^single$/i.test(taggedAlbum) && albumSimilarity(taggedAlbum,online.album)<0.55) canonicalAlbum=taggedAlbum;
      if(!cachedAlbum && online.album && adminOverview?.tracks?.length){
        const known=[...new Set(adminOverview.tracks.map(track=>String(track.album||'').trim()).filter(name=>name&&!/^single$/i.test(name)))];
        const best=known.map(name=>({name,score:albumSimilarity(name,online.album)})).sort((a,b)=>b.score-a.score)[0];
        if(best?.score>=0.72) canonicalAlbum=best.name;
      }
      if(collectionKey&&batchAlbumCache&&!batchAlbumCache.has(collectionKey))batchAlbumCache.set(collectionKey,canonicalAlbum);
      adminDetectedAlbum={name:canonicalAlbum||'',collectionId:online.collectionId||null,artist:online.collectionArtist||'',year:online.year||''};
      if(canonicalAlbum && (!taggedAlbum || /^single$/i.test(taggedAlbum) || albumSimilarity(taggedAlbum,online.album)>=0.55 || cachedAlbum))$('adminTrackAlbum').value=canonicalAlbum;
      if(!meta.genre&&online.genre){
        const select=$('adminTrackGenre'),option=[...select.options].find(o=>o.text.toLowerCase()===online.genre.toLowerCase());
        if(option)select.value=option.value;
      }
      if(!adminDetectedArtwork&&online.artwork){
        try{const response=await fetch(online.artwork);if(response.ok){adminDetectedArtwork=await response.blob();if(preview){preview.src=await blobDataUrl(adminDetectedArtwork);preview.classList.remove('hidden');}}}catch{}
      }
    }
  }
  const bits=[duration?`Duration ${fmt(duration)}`:'Duration unavailable',file.type||file.name.split('.').pop().toUpperCase(),`${(file.size/1048576).toFixed(1)} MB`];
  const detectedAlbum=$('adminTrackAlbum')?.value.trim();
  setAdminMetaStatus(`Scan complete · ${bits.join(' · ')}${detectedAlbum?` · Album group: ${detectedAlbum}`:''}. Review the detected fields and fill only anything missing.`, 'success');
  adminDetectedFile=file;
}
async function uploadAdminArtwork(blob) {
  if(!blob||blob.size>5*1024*1024)return '';
  const mime=['image/jpeg','image/png','image/webp','image/gif'].includes(blob.type)?blob.type:'image/jpeg';
  const result=await workerRequest('/admin/cover',{method:'POST',headers:{'Content-Type':mime},body:blob});
  return result.cover_url||'';
}
function updateAdminUploadProgress(percent, label, detail = '') {
  const wrap=$('sonoraUploadProgress'), fill=$('sonoraUploadFill'), bar=$('sonoraUploadBar');
  if(wrap)wrap.classList.remove('hidden');
  const value=Math.max(0,Math.min(100,Math.round(Number(percent)||0)));
  if(fill)fill.style.width=`${value}%`;
  if(bar)bar.setAttribute('aria-valuenow',String(value));
  if($('sonoraUploadPercent'))$('sonoraUploadPercent').textContent=`${value}%`;
  if($('sonoraUploadLabel'))$('sonoraUploadLabel').textContent=label||'Uploading…';
  if($('sonoraUploadDetail'))$('sonoraUploadDetail').textContent=detail;
}
function formatUploadBytes(bytes) {
  const n=Math.max(0,Number(bytes)||0);
  return n>=1048576?`${(n/1048576).toFixed(1)} MB`:n>=1024?`${(n/1024).toFixed(0)} KB`:`${Math.round(n)} B`;
}
async function uploadAdminTrack(form, fileOverride = null, batchMode = false) {
  if (!isAdmin) { notify('Administrator access is required.'); return; }
  const file = fileOverride || $('adminAudioFile')?.files?.[0];
  const title = $('adminTrackTitle')?.value.trim();
  const artist = $('adminTrackArtist')?.value.trim();
  if (!file) { notify('Choose an audio file first.'); return; }
  if (!title || !artist) { notify('Automatic tags could not identify the title or artist. Please fill only the missing required fields.'); return; }
  const norm=(v)=>String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const duplicate=tracks.find(t=>norm(t.title)===norm(title)&&norm(t.artist)===norm(artist));
  if(duplicate){ notify(`Possible duplicate blocked: “${duplicate.title}” by ${duplicate.artist} is already in the catalogue. Check the existing track before uploading again.`); return; }
  if (file.size > 100 * 1024 * 1024) { notify('Direct upload limit is 100 MB per track.'); return; }
  const allowed = /\.(mp3|m4a|mp4|aac|wav|ogg|opus|flac|webm)$/i;
  if (!allowed.test(file.name)) { notify('Unsupported audio format. Use MP3, M4A, AAC, WAV, OGG, OPUS, FLAC or WEBM.'); return; }
  const button = $('adminUploadBtn'); if (button) { button.disabled = true; button.textContent = 'Preparing upload…'; }
  const progressWrap=$('sonoraUploadProgress'); if(progressWrap)progressWrap.dataset.state='';
  updateAdminUploadProgress(0, 'Preparing audio upload', `${file.name} · ${formatUploadBytes(file.size)}`);
  let uploadStartedAt=0, lastProgressBytes=0, lastProgressAt=0;
  try {
    let duration = 0;
    try {
      const tempUrl = URL.createObjectURL(file);
      duration = await new Promise((resolve) => {
        const probe = new Audio(); probe.preload = 'metadata'; probe.src = tempUrl;
        probe.onloadedmetadata = () => { URL.revokeObjectURL(tempUrl); resolve(Number.isFinite(probe.duration) ? Math.floor(probe.duration) : 0); };
        probe.onerror = () => { URL.revokeObjectURL(tempUrl); resolve(0); };
      });
    } catch { duration = 0; }
    let coverUrl='';
    if(adminDetectedArtwork){try{if(button)button.textContent='Saving album artwork…';updateAdminUploadProgress(0,'Saving album artwork','Uploading detected cover image…');coverUrl=await uploadAdminArtwork(adminDetectedArtwork);}catch(error){console.warn('Album artwork upload failed',error);notify('Artwork could not be saved; continuing with audio upload.');}}
    const params = new URLSearchParams({
      title, artist,
      album:$('adminTrackAlbum')?.value.trim() || 'Single',
      genre:$('adminTrackGenre')?.value || 'Other',
      filename:file.name,
      duration:String(duration),
      cover_url:coverUrl
    });
    if(button)button.textContent='Uploading 0%…';
    uploadStartedAt=Date.now(); lastProgressAt=uploadStartedAt;
    const result = await workerUploadRequest(`/admin/upload?${params.toString()}`, file, (loaded,total,percent,stage) => {
      const now=Date.now();
      const elapsed=Math.max(.25,(now-lastProgressAt)/1000);
      const speed=(loaded-lastProgressBytes)/elapsed;
      lastProgressBytes=loaded; lastProgressAt=now;
      const detail=stage || `${formatUploadBytes(loaded)} of ${formatUploadBytes(total)}${speed>0?` · ${(speed/1048576).toFixed(2)} MB/s`:''}`;
      updateAdminUploadProgress(percent,stage||'Uploading audio to private R2',detail);
      if(button)button.textContent=stage?'Finalizing…':`Uploading ${percent}%…`;
    });
    updateAdminUploadProgress(100,'Upload complete','Audio saved to R2; catalogue record created in Supabase.');
    if (!batchMode) form.reset(); adminDetectedArtwork=null; adminDetectedAlbum=null; if(!batchMode)adminDetectedFile=null;
    const coverPreview=$('adminCoverPreview'); if(coverPreview){coverPreview.src='';coverPreview.classList.add('hidden');}
    setAdminMetaStatus('Track published. Select another audio file to scan its tags.');
    notify(`Uploaded “${title}” to Cloudflare R2 and published it.`);
    await loadCatalogue();
    refreshAdminSnapshotFromLoadedCatalogue(file.size);
    return true;
  } catch (error) {
    console.error('SONORA admin upload:', error);
    updateAdminUploadProgress(0,'Upload failed',error.message);
    const wrap=$('sonoraUploadProgress'); if(wrap)wrap.dataset.state='error';
    notify(`Upload failed: ${error.message}`);
    return false;
  } finally {
    if (button && !batchMode) { button.disabled = false; button.innerHTML = `${ic('plus')}Upload and publish`; }
  }
}
async function uploadAdminBatch(form) {
  const input = $('adminAudioFile');
  const files = Array.from(input?.files || []);
  if (!files.length) { notify('Choose one or more audio files first.'); return; }
  if (files.length === 1) { if(adminDetectionPromise)await adminDetectionPromise; if(adminDetectedFile!==files[0]){adminDetectionPromise=detectAdminAudio(files[0]);try{await adminDetectionPromise;}finally{adminDetectionPromise=null;}} await uploadAdminTrack(form, files[0], false); return; }
  const button = $('adminUploadBtn');
  if (button) { button.disabled = true; button.textContent = `Preparing ${files.length} tracks…`; }
  let succeeded = 0, failed = 0;
  const batchAlbumCache = new Map();
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > 100 * 1024 * 1024 || !/\.(mp3|m4a|mp4|aac|wav|ogg|opus|flac|webm)$/i.test(file.name)) { failed++; notify(`Skipped unsupported or oversized file: ${file.name}`); continue; }
      $('adminTrackTitle').value = ''; $('adminTrackArtist').value = ''; $('adminTrackAlbum').value = ''; $('adminTrackGenre').value = 'Other';
      setAdminMetaStatus(`Track ${i + 1} of ${files.length} · Detecting tags and soundtrack album…`);
      await detectAdminAudio(file,batchAlbumCache);
      if (button) { button.disabled = true; button.textContent = `Uploading ${i + 1}/${files.length}…`; }
      const ok = await uploadAdminTrack(form, file, true);
      if (ok) succeeded++; else failed++;
    }
  } finally {
    if (input) input.value = '';
    adminDetectedFile=null; adminDetectionPromise=null;
    $('adminTrackTitle').value = ''; $('adminTrackArtist').value = ''; $('adminTrackAlbum').value = '';
    if ($('sonoraSelectedFile')) $('sonoraSelectedFile').textContent = 'No files selected';
    if (button) { button.disabled = false; button.innerHTML = `${ic('plus')}Upload and publish`; }
    setAdminMetaStatus(`Batch finished · ${succeeded} uploaded · ${failed} failed or skipped.`, failed ? 'warning' : 'success');
    notify(`Batch upload complete: ${succeeded} uploaded, ${failed} failed or skipped.`);
  }
}

async function deleteAdminTrack(id) {
  const track = (adminOverview?.tracks || []).find((x) => x.id === id);
  if (!isAdmin || !confirm(`Delete “${track?.title || 'this track'}” and its Cloudflare R2 audio file? This cannot be undone.`)) return;
  try {
    await workerRequest(`/admin/tracks/${encodeURIComponent(id)}`, { method:'DELETE' });
    notify('Track and R2 audio object deleted.');
    await loadCatalogue(); await loadAdminDashboard();
  } catch (error) { notify(`Delete failed: ${error.message}`); }
}
function editAdminTrack(id) {
  const track = (adminOverview?.tracks || []).find((x) => x.id === id);
  if (!track || !isAdmin) return;
  openDlg('Edit track details', `<form id="adminEditForm" data-id="${esc(track.id)}">
    <div class="field"><label for="editTitle">Track title</label><input class="input" id="editTitle" maxlength="160" value="${esc(track.title)}" required></div>
    <div class="field"><label for="editArtist">Artist</label><input class="input" id="editArtist" maxlength="120" value="${esc(track.artist)}" required></div>
    <div class="field"><label for="editAlbum">Album</label><input class="input" id="editAlbum" maxlength="160" value="${esc(track.album || 'Single')}"></div>
    <div class="field"><label for="editGenre">Genre</label><input class="input" id="editGenre" maxlength="60" value="${esc(track.genre || 'Other')}"></div>
    <div class="field"><label for="editStatus">Publication status</label><select class="input" id="editStatus"><option value="published" ${track.status==='published'?'selected':''}>Published</option><option value="draft" ${track.status==='draft'?'selected':''}>Draft</option><option value="removed" ${track.status==='removed'?'selected':''}>Removed</option></select></div>
    <button class="btn btn-primary" style="width:100%" type="submit">Save track</button>
  </form>`);
  $('adminEditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await workerRequest(`/admin/tracks/${encodeURIComponent(track.id)}`, {
        method:'PATCH', headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ title:$('editTitle').value, artist:$('editArtist').value, album:$('editAlbum').value, genre:$('editGenre').value, status:$('editStatus').value })
      });
      closeDlg(); notify('Track details updated.'); await loadCatalogue(); await loadAdminDashboard();
    } catch (error) { notify(`Update failed: ${error.message}`); }
  });
}

const views = {
  home() {
    const h = new Date().getHours(), part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    const name = userPreferences.display_name ? `, ${esc(userPreferences.display_name)}` : user?.email ? `, ${esc(user.email.split('@')[0])}` : '';
    const preferred = userPreferences.preferred_genres || [];
    const homeTracks = preferred.length ? [...tracks].sort((a,b) => Number(preferred.includes(b.genre)) - Number(preferred.includes(a.genre))) : tracks;
    const f = homeTracks[0];
    return `<div class="page"><h1>Good ${part}${name}.</h1><p class="lede">${preferred.length ? 'Picked around the genres you enjoy.' : 'Fresh independent releases, ready to stream.'}</p>
    ${!supabaseConfigured ? `<div class="notice glass">${ic('user')}<span>Supabase is not configured. Add the project URL and publishable key in <b>config.js</b> to load your catalogue and accounts.</span></div>` : !streamingConfigured ? `<div class="notice glass">${ic('user')}<span>Music catalogue is connected, but the streaming Worker URL is not configured yet.</span></div>` : ''}
    ${f ? `<section class="feature glass" aria-label="Featured track">${cover(f)}<div style="min-width:0"><div class="kicker">Newest release</div><h2>${esc(f.title)}</h2><div class="muted">${esc(f.artist)} · ${esc(f.genre)}</div>
      <div class="acts"><button class="btn btn-primary" data-act="playcard" data-id="${esc(f.id)}" data-ctx="home">${ic('play')}Play</button>
      <button class="btn btn-glass" data-act="add" data-id="${esc(f.id)}">${ic('plus')}Add to playlist</button></div></div></section>` : emptyCatalogue()}
    ${tracks.length > 1 ? `<div class="sec-head"><div><h2>Fresh releases</h2><p>Recently added to the catalogue.</p></div></div>
      <div class="grid">${homeTracks.slice(1, 9).map((t) => card(t, 'home')).join('')}</div>` : ''}
    ${genres().length ? `<div class="sec-head"><div><h2>Browse by genre</h2></div></div><div class="chips">${genres().map((g) => `<button class="chip" data-act="genre" data-genre="${esc(g)}">${esc(g)}</button>`).join('')}</div>` : ''}
    ${albumEntries().length ? `<div class="sec-head"><div><h2>Albums & soundtracks</h2><p>Automatically grouped from catalogue metadata.</p></div><a class="link" href="#/albums">View all</a></div><div class="grid collection-grid">${albumEntries().slice(0,4).map(a=>`<a class="card collection-card" href="#/album/${encodeURIComponent(a.id)}" data-act="open-album" data-album-id="${esc(a.id)}" style="text-decoration:none;color:inherit">${collectionArtwork(a.tracks,a.name)}<span class="t">${esc(a.name)}</span><span class="s">${a.tracks.length} ${a.tracks.length===1?'track':'tracks'}</span></a>`).join('')}</div>` : ''}
    ${tracks.length ? `<div class="sec-head"><div><h2>All tracks</h2><p>${tracks.length} in the catalogue.</p></div><button class="link" data-act="go" data-to="search">Open search</button></div>${rows(tracks.slice(0, 10), 'home')}` : ''}</div>`;
  },
  search() {
    const list = filtered();
    return `<div class="page"><h1>Search</h1><p class="lede">Find tracks, artists and genres.</p>
    <div class="chips" role="group" aria-label="Genre">${['All', ...genres()].map((g) => `<button class="chip" data-act="genre" data-genre="${esc(g)}" aria-pressed="${g === genre}">${esc(g)}</button>`).join('')}</div>
    <div class="sec-head"><div><h2>${genre === 'All' ? 'All tracks' : esc(genre)}</h2><p>${list.length} ${list.length === 1 ? 'result' : 'results'}${query.trim() ? ` for “${esc(query.trim())}”` : ''}</p></div></div>
    ${list.length ? rows(list, 'search') : empty('Nothing found', 'Try a different title, artist or genre.')}</div>`;
  },
  liked() {
    const list = ctxList('liked');
    return `<div class="page library-page"><div class="kicker">YOUR LIBRARY</div><h1>Liked songs</h1><p class="lede">${isCloudUser() ? 'Your saved music, synced to your SONORA account.' : 'Your favourites are saved on this device. Sign in to sync across devices.'}</p>
    <section class="library-hero liked-hero">
      <div class="liked-art">${ic('heart-fill')}</div><div class="library-hero-copy"><span class="kicker">PLAYLIST</span><h2>Liked songs</h2><p>${list.length.toLocaleString()} ${list.length === 1 ? 'song' : 'songs'} · ${isCloudUser() ? 'Synced library' : 'This device'}</p>
      <div class="acts"><button class="btn btn-primary" data-act="playctx" data-ctx="liked" ${list.length ? '' : 'disabled'}>${ic('play')}Play</button><button class="btn btn-glass" data-act="playctx-shuffle" data-ctx="liked" ${list.length ? '' : 'disabled'}>${ic('shuffle')}Shuffle</button></div></div>
    </section>
    ${list.length ? `<div class="sec-head"><div><h2>Saved tracks</h2><p>Most recently added to your liked songs.</p></div></div>${rows(list, 'liked')}` : empty('No liked songs yet', 'Tap the heart beside any track to save it here.')}</div>`;
  },
  playlists() {
    return `<div class="page library-page"><div class="library-heading"><div><div class="kicker">YOUR LIBRARY</div><h1>Playlists</h1><p class="lede">Your music, organised around every mood and moment.</p></div><button class="btn btn-primary" data-act="newpl">${ic('plus')}Create playlist</button></div>
    <div class="grid collection-grid">
      <a class="card collection-card liked-collection" href="#/liked" style="text-decoration:none;color:inherit">${collectionArtwork(ctxList('liked'), 'Liked songs')}<span class="t">Liked songs</span><span class="s">${liked.size.toLocaleString()} saved songs</span></a>
      <button class="card new" data-act="newpl">${ic('plus')}<strong>New playlist</strong><span class="s">Start a new collection</span></button>
      ${playlists.map((p) => { const list=p.ids.map(byId).filter(Boolean); return `<a class="card collection-card" href="#/playlist/${encodeURIComponent(p.id)}" style="text-decoration:none;color:inherit">${collectionArtwork(list, p.name)}<span class="t">${esc(p.name)}</span><span class="s">${list.length} ${list.length === 1 ? 'song' : 'songs'} · Playlist</span></a>`; }).join('')}
    </div></div>`;
  },
  playlist(id) {
    const p = playlistById(id);
    if (!p) return `<div class="page"><h1>Playlist not found</h1><p class="lede">It may have been deleted.</p><a class="btn btn-glass" href="#/playlists" style="text-decoration:none">Back to playlists</a></div>`;
    const list = ctxList(`pl:${id}`);
    return `<div class="page library-page"><section class="collection-hero glass">${collectionArtwork(list, p.name)}<div class="collection-hero-copy"><span class="kicker">PLAYLIST</span><h1>${esc(p.name)}</h1><p class="lede">${list.length} ${list.length === 1 ? 'song' : 'songs'} · Personal collection</p><div class="acts"><button class="btn btn-primary" data-act="playctx" data-ctx="pl:${esc(id)}" ${list.length?'':'disabled'}>${ic('play')}Play</button><button class="btn btn-glass" data-act="playctx-shuffle" data-ctx="pl:${esc(id)}" ${list.length?'':'disabled'}>${ic('shuffle')}Shuffle</button><button class="btn btn-glass" data-act="delpl" data-id="${esc(id)}">${ic('trash')}Delete</button></div></div></section>
    ${list.length ? `<div class="sec-head"><div><h2>Tracks</h2><p>Use the heart to save favourites, or + to add them to another playlist.</p></div></div>${rows(list, `pl:${id}`, { remove:true })}` : empty('This playlist is empty', 'Use the + button on any track to add it here.')}</div>`;
  },
  albums() {
    const albums = albumEntries();
    return `<div class="page library-page"><div class="kicker">YOUR LIBRARY</div><h1>Albums & soundtracks</h1><p class="lede">Tracks with matching album or movie soundtrack metadata are automatically grouped here.</p>
      ${albums.length ? `<div class="grid collection-grid">${albums.map((album) => `<a class="card collection-card" href="#/album/${encodeURIComponent(album.id)}" data-act="open-album" data-album-id="${esc(album.id)}" style="text-decoration:none;color:inherit">${collectionArtwork(album.tracks, album.name)}<span class="t">${esc(album.name)}</span><span class="s">${album.tracks.length} ${album.tracks.length===1?'track':'tracks'} · ${[...new Set(album.tracks.map(t=>t.artist))].length>1?'Various artists':esc(album.tracks[0]?.artist||'Album')}</span></a>`).join('')}</div>` : empty('No albums yet', 'As tracks are added with album or movie soundtrack metadata, SONORA groups them into album collections automatically.')}</div>`;
  },
  album(id) {
    const album = albumById(id);
    if (!album) return `<div class="page"><h1>Album not found</h1><p class="lede">This album may no longer be in the catalogue.</p><a class="btn btn-glass" href="#/albums" style="text-decoration:none">Browse albums</a></div>`;
    const artists=[...new Set(album.tracks.map(t=>t.artist))];
    const ctx=`album:${album.id}`;
    return `<div class="page library-page"><section class="collection-hero glass">${collectionArtwork(album.tracks, album.name)}<div class="collection-hero-copy"><span class="kicker">ALBUM / SOUNDTRACK</span><h1>${esc(album.name)}</h1><p class="lede">${artists.length>1?'Various artists':esc(artists[0]||'Unknown artist')} · ${album.tracks.length} ${album.tracks.length===1?'track':'tracks'}</p><div class="acts"><button class="btn btn-primary" data-act="playctx" data-ctx="${esc(ctx)}">${ic('play')}Play</button><button class="btn btn-glass" data-act="playctx-shuffle" data-ctx="${esc(ctx)}">${ic('shuffle')}Shuffle</button></div></div></section>
      <div class="sec-head"><div><h2>Track list</h2><p>All catalogue tracks recognised as part of this album.</p></div></div>${rows(album.tracks, ctx)}</div>`;
  },
  preferences() {
    if (!user) return `<div class="page">${empty('Sign in required','Sign in to save your music preferences.')}</div>`;
    return `<div class="page preferences-page">
      <div class="kicker">MAKE SONORA YOURS</div>
      <h1>What do you love listening to?</h1>
      <p class="lede">Choose at least three genres and one mood. We’ll use these preferences to shape your discovery experience. You can change them any time in Settings.</p>
      <div class="preference-panel glass">
        <div class="field"><label for="prefDisplayName">WHAT SHOULD WE CALL YOU? (OPTIONAL)</label><input class="input" id="prefDisplayName" maxlength="80" value="${esc(preferenceNameDraft)}" placeholder="Your display name"></div>
        <h2>Choose your genres <span>Pick at least 3</span></h2>
        <div class="chips">${prefChips('genres', PREFERENCE_GENRES, preferenceDraft.genres)}</div>
        <h2>Your listening moods <span>Pick at least 1</span></h2>
        <div class="chips">${prefChips('moods', PREFERENCE_MOODS, preferenceDraft.moods)}</div>
        <div class="preference-actions"><span class="muted">${preferenceDraft.genres.length} genres · ${preferenceDraft.moods.length} moods selected</span><button class="btn btn-primary" type="button" data-act="save-preferences">${ic('check')}Save my taste</button></div>
      </div>
    </div>`;
  },
  settings() {
    return `<div class="page settings-page">
      <div class="kicker">YOUR SONORA</div><h1>Account & settings</h1>
      <p class="lede">Manage your account, listening taste and app experience.</p>
      <section class="settings-card glass">
        <div class="settings-card-head"><div><h2>Account</h2><p>Signed in with Supabase authentication.</p></div><span class="settings-avatar">${esc((user?.email || 'S').slice(0,1).toUpperCase())}</span></div>
        <div class="settings-detail"><span>Email address</span><strong>${esc(user?.email || 'Guest')}</strong></div>
        <div class="settings-detail"><span>Account status</span><strong>${user?.email_confirmed_at || user?.confirmed_at ? 'Email confirmed' : 'Confirmation may be pending'}</strong></div>
        ${isAdmin ? `<div class="admin-callout"><div><strong>SONORA administration</strong><p>Manage music, view service health and review audience and catalogue analytics.</p></div><div class="admin-shortcuts"><a class="btn btn-primary" href="#/admin">Admin dashboard</a><a class="btn btn-glass" href="#/diagnostics">Music & Audience Intelligence</a></div></div>` : ''}
        <div class="settings-actions"><button class="btn btn-glass" type="button" data-act="password-reset">Send password reset email</button></div>
      </section>
      <section class="settings-card glass">
        <h2>Listening preferences</h2><p class="muted">Personalise discovery with the genres and moods you enjoy.</p>
        <form id="settingsForm">
          <div class="field"><label for="prefDisplayName">DISPLAY NAME</label><input class="input" id="prefDisplayName" maxlength="80" value="${esc(preferenceNameDraft)}" placeholder="Your display name"></div>
          <h3>Genres</h3><div class="chips">${prefChips('genres', PREFERENCE_GENRES, preferenceDraft.genres)}</div>
          <h3>Moods</h3><div class="chips">${prefChips('moods', PREFERENCE_MOODS, preferenceDraft.moods)}</div>
          <button class="btn btn-primary" type="submit">${ic('check')}Save preferences</button>
        </form>
      </section>
      <section class="settings-card appearance-settings glass">
        <div class="appearance-brand"><img src="public/sonora-mark.svg" alt="SONORA logo"><div><span class="kicker">SONORA EXPERIENCE</span><h2>Appearance & playback</h2><p>Make the player feel at home on every device.</p></div><span class="appearance-mode-badge">${themeMode==='system'?'SYSTEM':themeMode.toUpperCase()}</span></div>
        <div class="settings-subhead"><div><h3>Appearance mode</h3><p>Choose how SONORA surfaces look.</p></div></div>
        <div class="theme-mode-options" role="group" aria-label="Appearance mode">
          <button class="theme-mode-option ${themeMode==='system'?'selected':''}" type="button" data-act="theme-mode" data-value="system" aria-pressed="${themeMode==='system'}"><span class="theme-mode-visual system-visual"><i></i><i></i><i></i></span><strong>System</strong><small>Follow device</small></button>
          <button class="theme-mode-option ${themeMode==='dark'?'selected':''}" type="button" data-act="theme-mode" data-value="dark" aria-pressed="${themeMode==='dark'}"><span class="theme-mode-visual dark-visual"><i></i><i></i><i></i></span><strong>Dark</strong><small>Low-light listening</small></button>
          <button class="theme-mode-option ${themeMode==='light'?'selected':''}" type="button" data-act="theme-mode" data-value="light" aria-pressed="${themeMode==='light'}"><span class="theme-mode-visual light-visual"><i></i><i></i><i></i></span><strong>Light</strong><small>Bright and clear</small></button>
        </div>
        <div class="settings-subhead palette-subhead"><div><h3>Colour identity</h3><p>Four coordinated SONORA palettes with matching logo accents.</p></div></div>
        <div class="theme-palette-options" role="group" aria-label="Colour palette">
          <button class="theme-palette-option ${themeAccent==='violet'?'selected':''}" type="button" data-act="theme-accent" data-value="violet" aria-pressed="${themeAccent==='violet'}"><span class="palette-swatch violet-swatch"><i></i><i></i></span><strong>Violet</strong><small>Original SONORA</small></button>
          <button class="theme-palette-option ${themeAccent==='ocean'?'selected':''}" type="button" data-act="theme-accent" data-value="ocean" aria-pressed="${themeAccent==='ocean'}"><span class="palette-swatch ocean-swatch"><i></i><i></i></span><strong>Ocean</strong><small>Blue & aqua</small></button>
          <button class="theme-palette-option ${themeAccent==='emerald'?'selected':''}" type="button" data-act="theme-accent" data-value="emerald" aria-pressed="${themeAccent==='emerald'}"><span class="palette-swatch emerald-swatch"><i></i><i></i></span><strong>Emerald</strong><small>Green & mint</small></button>
          <button class="theme-palette-option ${themeAccent==='rose'?'selected':''}" type="button" data-act="theme-accent" data-value="rose" aria-pressed="${themeAccent==='rose'}"><span class="palette-swatch rose-swatch"><i></i><i></i></span><strong>Rose</strong><small>Pink & coral</small></button>
        </div>
        <div class="settings-subhead playback-subhead"><div><h3>Playback behaviour</h3><p>Control how music continues on this device.</p></div></div>
        <label class="setting-check playback-check"><input type="checkbox" id="autoplayNext" ${autoplayDraft ? 'checked' : ''}> <span><strong>Autoplay next track</strong><small>Continue playing the queue when a song ends.</small></span></label>
        <div class="settings-volume"><div><label for="settingsVolume">DEFAULT PLAYER VOLUME</label><strong id="settingsVolumeValue">${Number($('vol')?.value ?? store.get('sonora-vol',80))}%</strong></div><input type="range" id="settingsVolume" min="0" max="100" value="${Number($('vol')?.value ?? store.get('sonora-vol',80))}" aria-label="Default player volume"></div>
        <div class="playback-quality"><span class="quality-icon">♫</span><div><strong>Original audio quality</strong><small>SONORA streams the uploaded audio without changing its source quality.</small></div><span class="quality-tag">SOURCE</span></div>
        <div class="settings-actions"><button class="btn btn-primary" type="button" data-act="save-appearance">${ic('check')}Save appearance & playback</button><span class="muted settings-save-note">${isCloudUser() ? 'Appearance and autoplay sync to your account. Volume is saved on this device.' : 'Appearance, autoplay and volume are saved on this device. Sign in to sync across devices.'}</span></div>
      </section>

      <section class="settings-danger glass"><div><h2>Sign out</h2><p class="muted">Your cloud library remains saved to your account.</p></div><button class="btn btn-danger" type="button" data-act="signout">${ic('user')}Sign out</button></section>
    </div>`;
  },
  admin() {
    if (!isAdmin) return `<div class="page">${empty('Administrator access required','Sign in with the allowlisted and email-confirmed SONORA administrator account to open this dashboard.')}</div>`;
    return `<div class="page admin-page">
      <div class="admin-heading"><div><div class="kicker">SONORA CONTROL ROOM</div><h1>Admin dashboard</h1><p class="lede">Upload and manage music, monitor Supabase and Cloudflare service health, and inspect administrative activity.</p></div><div class="admin-heading-actions"><a class="btn btn-glass" href="#/diagnostics">${ic('activity')}Music & Audience Intelligence</a><button class="btn btn-glass" type="button" data-act="admin-refresh">${ic('activity')}Refresh status</button></div></div>
      <div class="admin-welcome glass"><div><strong>Administrator verified</strong><span>${esc(user?.email || '')}</span></div><span class="admin-status" id="adminStatus">Loading service health…</span></div>
      <div class="r2-storage-estimate glass" id="adminStorageEstimate"><b>Cloudflare R2 storage estimate</b><span>Loading bucket usage…</span></div>
      <section class="admin-section glass live-listening-section"><div class="section-top"><div><h2>Live audience across SONORA</h2><p>Live connected browser sessions and active audio are measured separately. Counts represent browser sessions, not unique people.</p><div class="live-listener-kpi"><strong id="adminLiveMetric">—</strong><span id="adminLiveMetricNote">Waiting for Realtime presence</span></div></div><span class="storage-pill" id="adminLiveStatus">CONNECTING</span></div><div class="live-audience-summary"><div><strong id="adminLiveConnectedMetric">—</strong><span>Connected sessions</span></div><div><strong id="adminLiveMembersMetric">—</strong><span>Signed-in members</span></div><div><strong id="adminLiveGuestsMetric">—</strong><span>Guest sessions</span></div></div><small class="live-presence-diagnostic" id="adminLiveDiagnostics">Waiting for Realtime diagnostics…</small><div class="admin-live-grid"><div class="admin-live-column"><div class="admin-live-subhead"><strong>Now Playing</strong><small>Tracks with active playback</small></div><div class="admin-live-tracks" id="adminLiveTracks"><div class="chart-empty">Connecting to live listening presence…</div></div></div><div class="admin-live-column"><div class="admin-live-subhead"><strong>Connected users</strong><small>All sessions · members and guests</small></div><div class="live-audience-tools"><input class="input live-audience-search" id="adminLiveAudienceSearch" type="search" value="${esc(liveAudienceQuery)}" placeholder="Find a member, guest or track…" aria-label="Search connected users"><div class="live-audience-filters" role="group" aria-label="Filter connected users"><button type="button" class="selected" data-act="audience-filter" data-scope="admin" data-filter="all" aria-pressed="true">All</button><button type="button" data-act="audience-filter" data-scope="admin" data-filter="listening" aria-pressed="false">Listening</button><button type="button" data-act="audience-filter" data-scope="admin" data-filter="online" aria-pressed="false">Online</button></div></div><div class="admin-live-users" id="adminLiveUsers"><div class="chart-empty">Waiting for connected sessions…</div></div></div></div></section>
      <section class="admin-section glass analytics-section"><div class="section-top"><div><h2>Platform intelligence</h2><p>Catalogue mix, weekly upload momentum, listener engagement, storage and service response times.</p></div><span class="storage-pill">LIVE SNAPSHOT</span></div><div class="admin-analytics-grid" id="adminAnalytics"><div class="chart-card glass">Loading analytics…</div></div><div class="admin-insights" id="adminInsights"></div></section>
      <section class="admin-section glass"><div class="section-top"><div><h2>Service health & performance</h2><p>Live probes for authentication, database access, Cloudflare Worker and private R2 storage.</p></div></div><div class="admin-health" id="adminHealth"><p class="muted">Checking services…</p></div></section>
      <section class="admin-section glass"><div class="section-top"><div><h2>Deep diagnostics</h2><p>Read-only checks against the core Supabase tables and a sample R2 object. Refresh to re-run.</p></div></div><div class="admin-deep-grid" id="adminDeepDiagnostics"><p class="muted">Waiting for diagnostic results…</p></div><p class="muted health-note" id="adminCloudflareLimits"></p></section>
      <section class="admin-section glass"><div class="section-top"><div><h2>Upload music</h2><p>Audio is uploaded directly to the private Cloudflare R2 bucket. The Worker then registers the track in Supabase.</p></div><span class="storage-pill">R2 · Private</span></div>
        <form id="adminUploadForm" class="admin-upload-form">
          <div class="admin-form-grid">
            <div class="field"><label for="adminTrackTitle">TRACK TITLE</label><input class="input" id="adminTrackTitle" maxlength="160" placeholder="Auto-detected; fill only if missing"></div>
            <div class="field"><label for="adminTrackArtist">ARTIST</label><input class="input" id="adminTrackArtist" maxlength="120" placeholder="Auto-detected; fill only if missing"></div>
            <div class="field"><label for="adminTrackAlbum">ALBUM / MOVIE SOUNDTRACK</label><input class="input" id="adminTrackAlbum" list="albumSuggestions" maxlength="160" placeholder="Auto-detected from tags or soundtrack lookup"><datalist id="albumSuggestions"></datalist><small class="muted">SONORA groups tracks with the same album or movie soundtrack title automatically. No separate album upload is needed.</small></div>
            <div class="field"><label for="adminTrackGenre">GENRE</label><select class="input" id="adminTrackGenre"><option>Pop</option><option>Hip-hop</option><option>R&amp;B</option><option>Electronic</option><option>Rock</option><option>Indie</option><option>Jazz</option><option>Classical</option><option>Ambient</option><option>Folk</option><option>Bollywood</option><option>Afrobeats</option><option>Other</option></select></div>
          </div>
          <div class="field"><label for="adminAudioFile">AUDIO FILE (MP3, M4A, AAC, WAV, OGG, OPUS, FLAC, WEBM · MAX 100 MB)</label><label class="sonora-dropzone" id="sonoraDropzone" for="adminAudioFile"><span class="dropzone-icon">♫</span><strong>Choose audio files or drag them here</strong><span>Multiple selection supported · MP3, M4A, WAV, FLAC and more · Up to 100 MB each</span><input id="adminAudioFile" type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac,.webm" multiple required><small id="sonoraSelectedFile">No file selected</small></label></div>
          <div class="admin-meta-result" id="adminMetaStatus" role="status" aria-live="polite">Select an audio file. SONORA will scan its embedded tags, cover art and technical details.</div>
          <div class="sonora-upload-progress hidden" id="sonoraUploadProgress" aria-live="polite">
            <div class="sonora-upload-progress-top"><strong id="sonoraUploadLabel">Preparing upload…</strong><span id="sonoraUploadPercent">0%</span></div>
            <div class="sonora-upload-track" role="progressbar" aria-label="Audio upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="sonoraUploadBar"><span id="sonoraUploadFill"></span></div>
            <div class="sonora-upload-progress-bottom"><span id="sonoraUploadDetail">Waiting to upload</span><span id="sonoraUploadSpeed"></span></div>
          </div>
          <div class="admin-cover-preview-wrap"><img id="adminCoverPreview" class="admin-cover-preview hidden" alt="Detected album artwork preview"></div>
          <div class="upload-foot"><p class="muted">Only upload recordings you own or are licensed to distribute. The service rejects non-audio extensions and enforces upload rate limits.</p><button class="btn btn-primary" id="adminUploadBtn" type="submit">${ic('plus')}Upload and publish</button></div>
        </form>
      </section>
      <section class="admin-section glass"><div class="section-top"><div><h2>Music catalogue</h2><p>Search, edit, unpublish or permanently delete a track and its R2 object.</p></div><span class="muted" id="adminCatalogCount">Latest 250 records</span></div><div class="catalog-search"><span>⌕</span><input class="input" id="adminCatalogSearch" type="search" value="${esc(adminCatalogQuery)}" placeholder="Search title, artist, album or genre…" aria-label="Search music catalogue"></div><div class="admin-track-list" id="adminTracks"><p class="muted">Loading catalogue…</p></div></section>
      <section class="admin-section glass"><div class="section-top"><div><h2>Admin activity</h2><p>Recent upload, update and delete actions.</p></div></div><div id="adminAudit" class="admin-audit"><p class="muted">Loading activity…</p></div></section>
      <section class="admin-note"><strong>Reliability & safety</strong><p>Dashboard checks show current service reachability, not a guarantee against outages. Cloudflare CPU, request volume and edge errors remain available in the Worker Metrics and Observability tabs. Uploads are limited to 100 MB per file and 12 per administrator per hour.</p></section>
    </div>`;
  },
  diagnostics() {
    return `<div class="page intel-page">
      <header class="intel-page-header"><div class="intel-brand-lockup"><span class="intel-brand-mark">${ic('activity')}</span><div><div class="kicker">SONORA · MUSIC INTELLIGENCE</div><h1>Music & Audience Intelligence</h1><p class="lede">Understand your audience, catalogue performance and platform health in one place.</p></div></div><div class="intel-header-meta"><span id="intelHeaderLiveBadge" class="intel-live-label"><i></i> Connecting to audience</span><small id="intelHeaderUpdated">Analytics snapshot loads automatically</small></div></header>
      <div id="insightAnalytics" class="intel-board"><div class="intel-loading glass"><span class="intel-loading-pulse"></span><strong>Preparing your music intelligence dashboard</strong><small>Loading catalogue, playback totals and live audience presence.</small></div></div>
    </div>`;
  }
};

function route() {
  const raw=String(location.hash||'').replace(/^#\/?/,'');
  const slash=raw.indexOf('/');
  const name=(slash<0?raw:raw.slice(0,slash)).toLowerCase();
  const id=slash<0?undefined:raw.slice(slash+1);
  return { name: views[name] ? name : 'home', id };
}
function render() {
  const current = route();
  if (current.name === 'admin' && !isAdmin) {
    $('view').innerHTML = views.admin();
  } else if (current.name === 'diagnostics' && !isAdmin) {
    $('view').innerHTML = `<div class="page">${empty('Administrator access required','The Music & Audience Intelligence and service network are reserved for the SONORA administrator account.')}</div>`;
  } else {
    let routeId=current.id; try { if (routeId) routeId=decodeURIComponent(routeId); } catch { /* keep raw route token */ }
    $('view').innerHTML = views[current.name](routeId);
  }
  const navRoute=current.name==='playlist'?'playlists':current.name==='album'?'albums':current.name;
  qsa('[data-nav]').forEach((a) => { const on = a.dataset.nav === navRoute; on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  const si = $('topSearch'); if (document.activeElement !== si) si.value = query;
  syncLike();
  if (current.name === 'admin' && isAdmin) loadAdminDashboard();
  if (current.name === 'diagnostics' && isAdmin) loadAdminDashboard();
}
window.addEventListener('hashchange', () => { render(); window.scrollTo({ top:0 }); $('view').focus({ preventScroll:true }); });

/* ---------- playback ---------- */
const setIcon = (btn, name) => { btn.innerHTML = ic(name); };
function syncPlayerControls() {
  const playing = Boolean(active && !audio.paused);
  [['play',playing],['expandedPlay',playing]].forEach(([id,on]) => {
    const b=$(id); if(!b)return; setIcon(b,on?'pause':'play'); b.setAttribute('aria-label',on?'Pause':'Play');
  });
  [['shuffle',shuffle],['expandedShuffle',shuffle]].forEach(([id,on])=>{const b=$(id);if(!b)return;b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));b.setAttribute('aria-label',on?'Shuffle on':'Shuffle off');});
  const repeatLabel = repeatMode==='one'?'Repeat one':repeatMode==='all'?'Repeat all':'Repeat off';
  ['repeat','expandedRepeat'].forEach(id=>{const b=$(id);if(!b)return;b.classList.toggle('on',repeatMode!=='off');b.setAttribute('aria-pressed',String(repeatMode!=='off'));b.setAttribute('aria-label',repeatLabel);b.title=repeatLabel;b.innerHTML=ic('repeat')+(repeatMode==='one'?'<span class="repeat-one-badge">1</span>':'');});
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : (active?'paused':'none');
}
function syncPlaying() {
  const playing = active && !audio.paused;
  syncPlayerControls();
  qsa('.row[data-id]').forEach((r) => { const on = r.dataset.id === active?.id; r.classList.toggle('active', on); r.classList.toggle('playing', on && playing); });
  publishLivePresence();
}
function syncLike() {
  const lk = Boolean(active && liked.has(active.id));
  [ $('npLike'), $('expandedLike') ].forEach(btn=>{if(!btn)return;setIcon(btn,lk?'heart-fill':'heart');btn.classList.toggle('on',lk);btn.setAttribute('aria-pressed',String(lk));btn.setAttribute('aria-label',lk?'Unlike track':'Like track');});
}
function updateCoverElement(el,t) {
  if(!el||!t)return;
  el.style.setProperty('--h1',hue(t.id));el.style.setProperty('--h2',(hue(t.id)+60)%360);
  el.innerHTML=`<b>${esc((t.title||'S').slice(0,1))}</b>${t.coverUrl?`<img src="${esc(t.coverUrl)}" alt="" decoding="async">`:''}`;
}
function renderExpandedQueue() {
  const target=$('expandedQueueList'); if(!target)return;
  const ids=queue.length?queue:tracks.map(t=>t.id);
  if(!ids.length){target.innerHTML='<p class="muted">Your queue is empty. Play an album or playlist to build your queue.</p>';return;}
  target.innerHTML=ids.map((id,index)=>{const t=byId(id);if(!t)return '';const current=t.id===active?.id;return `<div class="expanded-queue-row${current?' is-current':''}"><button type="button" class="expanded-queue-item" data-queue-play="${esc(t.id)}"><span class="expanded-queue-index">${current?ic('play'):index+1}</span>${cover(t,'queue-cover')}<span class="expanded-queue-copy"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}</small></span>${current?'<span class="queue-current-label">PLAYING</span>':''}</button>${!current?`<button type="button" class="icon-btn queue-remove" data-queue-remove="${esc(t.id)}" aria-label="Remove ${esc(t.title)} from queue">${ic('x')}</button>`:''}</div>`;}).join('');
}
function syncExpandedPlayer() {
  const overlay=$('nowPlayingExpanded'); if(!overlay)return;
  const t=active;
  $('expandedTitle').textContent=t?.title||'Nothing playing';$('expandedArtist').textContent=t?.artist||'Pick a track to start';$('expandedAlbum').textContent=t?.album||'SONORA';
  updateCoverElement($('expandedCover'),t);
  const dur=Number(audio.duration)||Number(t?.duration)||0;
  $('expandedDur').textContent=fmt(dur);$('expandedCur').textContent=fmt(audio.currentTime||0);
  if(!$('expandedSeek').matches(':active')){$('expandedSeek').value=dur?String(Math.round((audio.currentTime/dur)*1000)):0;$('expandedSeek').style.setProperty('--p',`${dur?Math.max(0,Math.min(1,audio.currentTime/dur))*100:0}%`);}
  if($('playbackSpeed'))$('playbackSpeed').value=String(audio.playbackRate||1);
  if($('expandedVolume')&&!$('expandedVolume').matches(':active'))$('expandedVolume').value=String(Math.round(audio.volume*100));
  syncPlayerControls();syncLike();
}
let nowPlayingReturnFocus=null;
function openNowPlaying(showQueue=false) {
  if(!active){notify('Pick a song to start listening.');return;}
  const panel=$('nowPlayingExpanded');nowPlayingReturnFocus=document.activeElement;panel.classList.remove('hidden');panel.setAttribute('aria-hidden','false');document.body.classList.add('now-playing-open');syncExpandedPlayer();renderExpandedQueue();$('closeNowPlaying').focus({preventScroll:true});
  if(showQueue)showExpandedQueue(true);
}
function closeNowPlaying() {const panel=$('nowPlayingExpanded');panel.classList.add('hidden');panel.setAttribute('aria-hidden','true');document.body.classList.remove('now-playing-open');if(nowPlayingReturnFocus?.focus)nowPlayingReturnFocus.focus({preventScroll:true});}
function showExpandedQueue(show) {const q=$('expandedQueue');if(!q)return;q.classList.toggle('hidden',!show);$('expandedQueueToggle').setAttribute('aria-expanded',String(show));if(show)q.scrollIntoView({block:'nearest',behavior:'smooth'});}
function setShuffle(value) {shuffle=Boolean(value);store.set('sonora-shuffle',shuffle);syncPlayerControls();}
function cycleRepeat() {repeatMode=repeatMode==='off'?'all':repeatMode==='all'?'one':'off';audio.loop=repeatMode==='one';store.set('sonora-repeat-mode',repeatMode);syncPlayerControls();notify(repeatMode==='off'?'Repeat off':repeatMode==='all'?'Repeat all':'Repeating this song');}
function setActive(t) {
  active = t;
  $('npTitle').textContent = t.title; $('npArtist').textContent = t.artist;
  updateCoverElement($('npCover'),t);
  $('dur').textContent = fmt(t.duration); $('cur').textContent = '0:00'; setSeek(0);
  store.set('sonora-last', t.id); syncLike();syncExpandedPlayer();renderExpandedQueue();
  if ('mediaSession' in navigator && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title:t.title, artist:t.artist, album:t.album, artwork:t.coverUrl?[{src:t.coverUrl,sizes:'512x512',type:'image/jpeg'}]:[] });
}
function load(t, autoplay) {
  setActive(t);
  if (!t.audioUrl) { audio.removeAttribute('src'); audio.load(); syncPlaying(); if (autoplay) notify('This track has no playable audio URL. Check the track metadata and Worker configuration in Music & Audience Intelligence.'); return; }
  if (audio.src !== t.audioUrl) audio.src = t.audioUrl;
  if (autoplay) audio.play().catch((e) => { if (e.name !== 'AbortError') notify('Could not start playback. Tap play to try again.'); });
  syncPlaying();
}
function play(id, ctx) {
  const t = byId(id); if (!t) return;
  if (ctx) queue = ctxList(ctx).map((x) => x.id);
  if (!queue.includes(id)) queue = [id];
  if (active?.id === id && audio.src) { toggle(); return; }
  load(t, true);
}
function playContext(ctx, randomize = false) {
  const list=ctxList(ctx);
  if (!list.length) return;
  queue=list.map(track=>track.id);
  if (randomize) {
    setShuffle(true);
    for(let i=queue.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[queue[i],queue[j]]=[queue[j],queue[i]];}
  }
  renderExpandedQueue();
  const first=byId(queue[0]); if(first)load(first,true);
}
function toggle() {
  if (!active) { notify('Pick a track to start listening.'); return; }
  if (!audio.src) { load(active, true); return; }
  audio.paused ? audio.play().catch(() => notify('Could not start playback.')) : audio.pause();
}
function addToQueue(trackId) {
  const track=byId(trackId);if(!track)return;
  if(trackId===active?.id){notify('This track is already playing.');return;}
  if(queue.includes(trackId)){notify('This track is already in your queue.');return;}
  if(!queue.length&&active)queue=[active.id];
  queue.push(trackId);
  renderExpandedQueue();
  notify(`Added ${track.title} to your queue.`);
}
function clearUpcomingQueue() {
  queue=active?[active.id]:[];
  renderExpandedQueue();
  notify('Upcoming queue cleared.');
}

function step(dir, auto) {
  if (!queue.length) queue = tracks.map((t) => t.id);
  if (!queue.length) return;
  const i = queue.indexOf(active?.id);
  if (auto && repeatMode !== 'all' && !shuffle && i === queue.length - 1) { audio.pause(); audio.currentTime = 0; syncExpandedPlayer(); return; }
  let n;
  if (shuffle && queue.length > 1) { do { n = Math.floor(Math.random() * queue.length); } while (n === i); }
  else n = (i + dir + queue.length) % queue.length;
  const t = byId(queue[n]); if (t) load(t, true);
}
function restoreLast() {
  if (active) return;
  const t = byId(store.get('sonora-last', '')); if (t) { queue = tracks.map((x) => x.id); load(t, false); }
}
const setSeek = (p) => { $('seek').value = p * 1000; $('seek').style.setProperty('--p', `${p * 100}%`); };
async function beginPlaybackEvent() {
  if (!sb || !user?.id || !active?.id || currentPlayEventId || playEventCreating) return;
  playEventCreating = true; playFinishRequested = false; sessionPlayedSeconds = 0;
  try {
    const { data, error } = await sb.from('sonora_play_events')
      .insert({ user_id:user.id, track_id:active.id, played_seconds:0 })
      .select('id').single();
    if (error) throw error;
    currentPlayEventId = data.id;
    if (pendingPlaySeconds >= 1) await flushPlaybackTime();
    if (playFinishRequested || audio.paused) await flushPlaybackTime(currentPlayEventId, true);
  } catch (error) { console.warn('SONORA play event could not be started:', error.message || error); }
  finally { playEventCreating = false; }
}
async function flushPlaybackTime(eventId = currentPlayEventId, finish = false) {
  if (playFlushBusy || !sb || !user?.id || !eventId) return;
  const seconds = Math.floor(pendingPlaySeconds);
  if (seconds < 1 && !finish) return;
  playFlushBusy = true; pendingPlaySeconds -= seconds; sessionPlayedSeconds += seconds;
  try {
    const { error } = await sb.from('sonora_play_events').update({ played_seconds:sessionPlayedSeconds })
      .eq('id', eventId).eq('user_id', user.id);
    if (error) throw error;
  } catch (error) {
    pendingPlaySeconds = Math.min(60, pendingPlaySeconds + seconds);
    sessionPlayedSeconds = Math.max(0, sessionPlayedSeconds - seconds);
    console.warn('SONORA play analytics could not be saved:', error.message || error);
  } finally {
    playFlushBusy = false;
    if (finish && currentPlayEventId === eventId) currentPlayEventId = null;
  }
}
async function finishPlaybackEvent() {
  const eventId = currentPlayEventId;
  if (eventId) await flushPlaybackTime(eventId, true);
  else if (playEventCreating) playFinishRequested = true;
}
audio.addEventListener('timeupdate', () => {
  const d = audio.duration; $('cur').textContent = fmt(audio.currentTime); if (d) setSeek(audio.currentTime / d);
  if ($('nowPlayingExpanded') && !$('nowPlayingExpanded').classList.contains('hidden')) syncExpandedPlayer();
  if (audio.paused || !active?.id) { lastPlaybackPosition = audio.currentTime; lastPlaybackTrackId = active?.id || null; return; }
  if (lastPlaybackTrackId !== active.id) { lastPlaybackTrackId = active.id; lastPlaybackPosition = audio.currentTime; return; }
  const previous = lastPlaybackPosition;
  const delta = previous == null ? 0 : audio.currentTime - previous;
  if (delta > 0 && delta <= 2.5) pendingPlaySeconds += delta; // ignore seeks and buffering jumps
  lastPlaybackPosition = audio.currentTime;
  if (pendingPlaySeconds >= 30) flushPlaybackTime();
});
audio.addEventListener('seeking', () => { lastPlaybackPosition = audio.currentTime; });
audio.addEventListener('play', () => { lastPlaybackPosition = audio.currentTime; lastPlaybackTrackId = active?.id || null; beginPlaybackEvent(); });
audio.addEventListener('pause', () => { finishPlaybackEvent(); });
audio.addEventListener('ended', () => { finishPlaybackEvent(); });
window.addEventListener('pagehide', () => { finishPlaybackEvent(); try { livePresenceChannel?.untrack(); } catch (error) { console.warn('SONORA presence untrack:', error?.message || error); } });
audio.addEventListener('loadedmetadata', () => { $('dur').textContent = fmt(audio.duration); syncExpandedPlayer(); });
audio.addEventListener('play', syncPlaying); audio.addEventListener('pause', syncPlaying);
audio.addEventListener('playing', () => { syncPlaying(); publishLivePresence(); });
audio.addEventListener('ended', () => publishLivePresence());
window.addEventListener('focus', () => { if (livePresenceReady) { publishLivePresence(); readLivePresenceSnapshot(); if (['admin','diagnostics'].includes(route().name)) renderLivePresence(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && livePresenceReady) { publishLivePresence(); readLivePresenceSnapshot(); if (['admin','diagnostics'].includes(route().name)) renderLivePresence(); } });
window.addEventListener('online', () => { if (sb && !livePresenceReady && livePresenceChannel) scheduleLivePresenceReconnect(livePresenceChannel, livePresenceEpoch); });
audio.addEventListener('waiting', () => $('play').classList.add('loading'));
['playing', 'canplay', 'pause', 'error'].forEach((e) => audio.addEventListener(e, () => $('play').classList.remove('loading')));
audio.addEventListener('ended', () => { if (repeatMode === 'all' || userPreferences.autoplay_next !== false) step(1, true); });
audio.addEventListener('error', () => { if (audio.src && active) notify('This track could not be streamed. Check that your Worker is deployed and the file exists in R2.'); });
$('seek').addEventListener('input', (e) => { const p = e.target.value / 1000; e.target.style.setProperty('--p', `${p * 100}%`); if (audio.duration) audio.currentTime = audio.duration * p; });
$('expandedSeek').addEventListener('input', (e) => { const p=e.target.value/1000;e.target.style.setProperty('--p',`${p*100}%`);if(audio.duration)audio.currentTime=audio.duration*p;$('expandedCur').textContent=fmt(audio.currentTime); });
const setVol = (v) => { audio.volume = v / 100; $('vol').style.setProperty('--p', `${v}%`); setIcon($('muteBtn'), v === 0 || audio.muted ? 'mute' : 'volume'); };
$('vol').addEventListener('input', (e) => { audio.muted = false; setVol(Number(e.target.value)); store.set('sonora-vol', Number(e.target.value)); });
$('muteBtn').addEventListener('click', () => { audio.muted = !audio.muted; setVol(Number($('vol').value)); });
$('vol').value = store.get('sonora-vol', 80); setVol(Number($('vol').value));
$('play').addEventListener('click', toggle);
$('prev').addEventListener('click', () => { if (audio.currentTime > 3) audio.currentTime = 0; else step(-1); });
$('next').addEventListener('click', () => step(1));
$('shuffle').addEventListener('click', () => setShuffle(!shuffle));
$('repeat').addEventListener('click', cycleRepeat);
$('npLike').addEventListener('click', () => active && toggleLike(active.id));
$('openNowPlaying').addEventListener('click', () => openNowPlaying(false));
$('queueBtn').addEventListener('click', () => openNowPlaying(true));
$('expandedQueueToggle').addEventListener('click', () => showExpandedQueue($('expandedQueue').classList.contains('hidden')));
$('expandedQueueClose').addEventListener('click', () => showExpandedQueue(false));
$('clearQueue').addEventListener('click',clearUpcomingQueue);
$('closeNowPlaying').addEventListener('click', closeNowPlaying);$('closeNowPlayingBackdrop').addEventListener('click',closeNowPlaying);
$('expandedPlay').addEventListener('click',toggle);$('expandedPrev').addEventListener('click',()=>{if(audio.currentTime>3)audio.currentTime=0;else step(-1);});$('expandedNext').addEventListener('click',()=>step(1));
$('expandedShuffle').addEventListener('click',()=>setShuffle(!shuffle));$('expandedRepeat').addEventListener('click',cycleRepeat);$('expandedLike').addEventListener('click',()=>active&&toggleLike(active.id));
$('playbackSpeed').addEventListener('change',e=>{const speed=Math.max(.5,Math.min(2,Number(e.target.value)||1));audio.playbackRate=speed;store.set('sonora-playback-speed',speed);});
const initialSpeed=Math.max(.5,Math.min(2,Number(store.get('sonora-playback-speed',1))||1));audio.playbackRate=initialSpeed;$('playbackSpeed').value=String(initialSpeed);
$('expandedVolume').addEventListener('input',e=>{const v=Math.max(0,Math.min(100,Number(e.target.value)||0));audio.muted=false;$('vol').value=String(v);setVol(v);store.set('sonora-vol',v);});
$('nowPlayingExpanded').addEventListener('click',e=>{const playButton=e.target.closest('[data-queue-play]');const removeButton=e.target.closest('[data-queue-remove]');if(playButton){const id=playButton.dataset.queuePlay;const t=byId(id);if(t)load(t,true);return;}if(removeButton){const id=removeButton.dataset.queueRemove;queue=queue.filter(x=>x!==id);renderExpandedQueue();notify('Removed from queue.');}});
$('nowPlayingExpanded').addEventListener('keydown',e=>{
  if(e.key==='Tab'){
    const items=qsa('button:not([disabled]),input:not([disabled]),select:not([disabled])',$('nowPlayingExpanded')).filter(el=>el.offsetParent!==null);
    if(!items.length)return;
    const first=items[0],last=items[items.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('nowPlayingExpanded').classList.contains('hidden'))closeNowPlaying();});
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const registerMediaAction = (name, handler) => { try { ms.setActionHandler(name, handler); } catch { /* action not supported by this browser */ } };
  registerMediaAction('play', () => { if(audio.paused)toggle(); });
  registerMediaAction('pause', () => { if(!audio.paused)audio.pause(); });
  registerMediaAction('previoustrack', () => step(-1));
  registerMediaAction('nexttrack', () => step(1));
  registerMediaAction('seekto', (d) => { if(Number.isFinite(d.seekTime))audio.currentTime=d.seekTime; });
  registerMediaAction('seekbackward', (d) => { audio.currentTime=Math.max(0,audio.currentTime-(d.seekOffset||10)); });
  registerMediaAction('seekforward', (d) => { audio.currentTime=Math.min(audio.duration||Infinity,audio.currentTime+(d.seekOffset||10)); });
  registerMediaAction('stop', () => { audio.pause(); audio.currentTime=0; syncExpandedPlayer(); });
}
syncPlayerControls();syncExpandedPlayer();

/* ---------- likes & playlists ---------- */
async function toggleLike(id) {
  const was = liked.has(id);
  was ? liked.delete(id) : liked.add(id);
  render();
  if (isCloudUser()) {
    const r = was ? await sb.from('likes').delete().eq('user_id', user.id).eq('track_id', id) : await sb.from('likes').insert({ user_id:user.id, track_id:id });
    if (r.error) { was ? liked.add(id) : liked.delete(id); render(); notify('Could not sync your like. Try again.'); }
  } else saveGuest();
}
async function createPlaylist(name) {
  name = name.trim().slice(0, 50); if (!name) return null;
  if (isCloudUser()) {
    const { data, error } = await sb.from('playlists').insert({ user_id:user.id, name }).select('id,name').single();
    if (error) { notify('Could not create the playlist. Try again.'); return null; }
    const p = { id:data.id, name:data.name, ids:[] }; playlists.unshift(p); return p;
  }
  const p = { id:`local-${Date.now()}`, name, ids:[] }; playlists.unshift(p); saveGuest(); return p;
}
async function addToPlaylist(p, trackId) {
  if (p.ids.includes(trackId)) { notify(`Already in ${p.name}.`); return true; }
  if (isCloudUser()) {
    const { error } = await sb.from('playlist_tracks').insert({ playlist_id:p.id, track_id:trackId, position:p.ids.length });
    if (error) { notify('Could not add the track. Try again.'); return false; }
  }
  p.ids.push(trackId); if (!isCloudUser()) saveGuest(); notify(`Added to ${p.name}.`); return true;
}
function newPlaylistDialog(thenAdd) {
  openDlg('New playlist', `<form id="plForm"><div class="field"><label for="plName">Name</label><input class="input" id="plName" maxlength="50" required placeholder="Sunday morning" autocomplete="off"></div><button class="btn btn-primary" style="width:100%" type="submit">Create playlist</button></form>`);
  $('plName').focus();
  $('plForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = await createPlaylist($('plName').value); if (!p) return;
    if (thenAdd) await addToPlaylist(p, thenAdd); else notify('Playlist created.');
    closeDlg(); render();
  });
}
function addDialog(trackId) {
  const t = byId(trackId); if (!t) return;
  openDlg('Add to playlist', `<p class="muted" style="margin:0">Save “${esc(t.title)}” to:</p><div class="pick">${playlists.map((p, i) => `<button type="button" data-pl="${i}">${ic('list')}${esc(p.name)}</button>`).join('')}<button type="button" data-pl="new">${ic('plus')}New playlist</button></div>`);
  qsa('[data-pl]', $('dlgBody')).forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.pl === 'new') { newPlaylistDialog(trackId); return; }
    if (await addToPlaylist(playlists[Number(b.dataset.pl)], trackId)) { closeDlg(); render(); }
  }));
}
async function deletePlaylist(id) {
  const p = playlistById(id); if (!p) return;
  openDlg('Delete playlist?', `<p class="muted" style="margin-top:0">“${esc(p.name)}” will be removed. The tracks themselves stay in SONORA.</p><div style="display:grid;gap:10px"><button class="btn btn-primary" id="delYes" type="button">Delete</button><button class="btn btn-glass" id="delNo" type="button">Keep it</button></div>`);
  $('delNo').addEventListener('click', closeDlg);
  $('delYes').addEventListener('click', async () => {
    if (isCloudUser()) { const { error } = await sb.from('playlists').delete().eq('id', id); if (error) { notify('Could not delete the playlist.'); return; } }
    playlists = playlists.filter((x) => x.id !== id); if (!isCloudUser()) saveGuest();
    closeDlg(); location.hash = '#/playlists'; notify('Playlist deleted.');
  });
}
async function removeFromPlaylist(plId, trackId) {
  const p = playlistById(plId); if (!p) return;
  if (isCloudUser()) { const { error } = await sb.from('playlist_tracks').delete().eq('playlist_id', plId).eq('track_id', trackId); if (error) { notify('Could not remove the track.'); return; } }
  p.ids = p.ids.filter((x) => x !== trackId); if (!isCloudUser()) saveGuest(); render();
}

/* ---------- Music & Audience Intelligence ---------- */
function normaliseMusicKey(value) {
  return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function readableListenTime(seconds) {
  const value=Math.max(0,Math.floor(Number(seconds)||0));
  if(value>=3600){const hours=Math.floor(value/3600),mins=Math.floor((value%3600)/60);return `${hours} hr${hours===1?'':'s'}${mins?` ${mins} min`:''}`;}
  if(value>=60)return `${Math.floor(value/60)} min`;
  return `${value} sec`;
}
function liveListenerLabel(listener,index) { return presenceDisplayName(listener,index); }
function renderIntelligenceLiveBlocks() {
  const countNode=$('insightListenerCount'),statusNode=$('insightLiveStatus');
  const headerLiveBadge=$('intelHeaderLiveBadge');
  const count=livePresenceReady?liveListenerSnapshot.length:null;
  const connected=livePresenceReady?livePresenceAllSnapshot:[];
  const activeUsers=connected.filter(presenceIsPlaying);
  const connectedGuests=connected.filter(presenceIsGuest).length;
  const connectedMembers=Math.max(0,connected.length-connectedGuests);
  if(headerLiveBadge){headerLiveBadge.textContent=livePresenceReady?'LIVE AUDIENCE':`AUDIENCE ${String(livePresenceStatus||'WAITING').replaceAll('_',' ')}`;headerLiveBadge.classList.toggle('offline',!livePresenceReady);}
  if(countNode)countNode.textContent=count==null?'—':count.toLocaleString();
  if(statusNode){statusNode.textContent=livePresenceReady?'LIVE':livePresenceStatus;statusNode.className=`storage-pill ${livePresenceReady?'live-pill':''}`;}
  [['intelLiveConnectedMetric',livePresenceReady?connected.length:null],['intelLiveMembersMetric',livePresenceReady?connectedMembers:null],['intelLiveGuestsMetric',livePresenceReady?connectedGuests:null]].forEach(([id,value])=>{const node=$(id);if(node)node.textContent=value==null?'—':value.toLocaleString();});
  const signed=connectedMembers;
  const guests=connectedGuests;
  const audienceMix=$('intelAudienceMix');
  if(audienceMix) audienceMix.innerHTML=!livePresenceReady?'<div class="chart-empty">Waiting for Realtime presence.</div>':!connected.length?'<div class="chart-empty">No connected audience sessions yet.</div>':svgDonutChart([{name:'Signed in',value:signed},{name:'Guests',value:guests}],'name','value','sessions');
  const bands=[{name:'0–5 min',value:0},{name:'5–15 min',value:0},{name:'15–30 min',value:0},{name:'30+ min',value:0}];
  activeUsers.forEach(x=>{const start=presenceTimestamp(x.started_at || x.track_started_at);const mins=start?Math.max(0,(Date.now()-start)/60000):0;const index=mins<5?0:mins<15?1:mins<30?2:3;bands[index].value++;});
  const sessionBands=$('intelSessionBands');
  if(sessionBands)sessionBands.innerHTML=!livePresenceReady?'<div class="chart-empty">Waiting for live sessions.</div>':activeUsers.length?svgBarChart(bands,'name','value','chart-bar-engagement'):'<div class="chart-empty">No current listening sessions to analyse.</div>';
  const grouped=new Map();
  activeUsers.forEach(listener=>{const id=String(presenceTrackId(listener)||`${listener.title}|${listener.artist}`);if(!grouped.has(id))grouped.set(id,{name:listener.title||'Unknown track',artist:listener.artist||'Unknown artist',value:0});grouped.get(id).value++;});
  const liveTracks=[...grouped.values()].sort((a,b)=>b.value-a.value);
  const tracksNode=$('intelLiveTrackChart');
  if(tracksNode)tracksNode.innerHTML=!livePresenceReady?'<div class="chart-empty">Live track data is unavailable until presence connects.</div>':liveTracks.length?svgBarChart(liveTracks.slice(0,7).map(x=>({name:`${x.name} · ${x.artist}`,value:x.value})),'name','value','chart-bar-engagement'):'<div class="chart-empty">Nothing is playing right now.</div>';
  const listeningNow=$('intelCurrentlyPlaying');
  if(listeningNow){
    if(!livePresenceReady)listeningNow.innerHTML='<div class="intel-empty-state"><strong>Connecting to live listening</strong><span>Live track data is not available yet.</span></div>';
    else if(!liveTracks.length)listeningNow.innerHTML='<div class="intel-empty-state"><strong>Nothing is playing</strong><span>Currently playing music will be shown here.</span></div>';
    else listeningNow.innerHTML=liveTracks.slice(0,4).map(track=>`<div class="intel-now-track"><span class="intel-now-eq"><i></i><i></i><i></i></span><span><strong>${esc(track.name)}</strong><small>${esc(track.artist)}</small></span><b>${track.value} ${track.value===1?'listener':'listeners'}</b></div>`).join('');
  }
  const liveUpdated=$('intelLiveUpdated');if(liveUpdated)liveUpdated.textContent=`${connected.length} connected · ${activeUsers.length} listening · refreshed ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
}
function renderIntelligenceDashboard(data) {
  const target=$('insightAnalytics');
  if(!target)return;
  const m=data.metrics||{},checks=data.checks||{},catalogue=Array.isArray(data.tracks)?data.tracks:[];
  const total=Number(m.tracks_total||catalogue.length),published=Number(m.tracks_published||0);
  const plays=Number(m.total_play_events||0),playSeconds=Number(m.total_play_seconds||0),avgPlay=plays?playSeconds/plays:0;
  const hours=playSeconds/3600;
  const genres=Object.entries(m.genre_distribution||{}).sort((a,b)=>b[1]-a[1]).map(([name,value])=>({name,value}));
  const artistsMap=new Map(),albumsMap=new Map(),duplicateMap=new Map();
  const quality=[{name:'Title',value:0},{name:'Artist',value:0},{name:'Genre',value:0},{name:'Artwork',value:0},{name:'Audio object',value:0}];
  catalogue.forEach(track=>{
    const artist=String(track.artist||'').trim()||'Unknown artist';artistsMap.set(artist,(artistsMap.get(artist)||0)+1);
    const album=String(track.album||'').trim();if(album&&album.toLowerCase()!=='single')albumsMap.set(album,(albumsMap.get(album)||0)+1);
    const key=`${normaliseMusicKey(track.title)}|${normaliseMusicKey(track.artist)}`;
    if(normaliseMusicKey(track.title)&&normaliseMusicKey(track.artist)){if(!duplicateMap.has(key))duplicateMap.set(key,[]);duplicateMap.get(key).push(track);}
    if(String(track.title||'').trim())quality[0].value++;
    if(String(track.artist||'').trim())quality[1].value++;
    if(String(track.genre||'').trim())quality[2].value++;
    if(String(track.cover_url||'').trim())quality[3].value++;
    if(String(track.audio_key||'').trim())quality[4].value++;
  });
  const artists=[...artistsMap].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value);
  const albums=[...albumsMap].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value);
  const duplicateGroups=[...duplicateMap.values()].filter(rows=>rows.length>1).sort((a,b)=>b.length-a.length);
  const duplicates=duplicateGroups.reduce((sum,rows)=>sum+rows.length-1,0);
  const uploads=m.uploads_by_day||[];
  const latencies=[{name:'Worker',value:checks.cloudflare_worker?.latency_ms},{name:'Auth',value:checks.supabase_auth?.latency_ms},{name:'Database',value:checks.supabase_database?.latency_ms},{name:'R2 storage',value:checks.r2_storage?.latency_ms}].filter(x=>Number(x.value)>0).map(x=>({name:x.name,ms:Number(x.value)}));
  const healthy=Object.entries(checks).filter(([key,value])=>['cloudflare_worker','supabase_auth','supabase_database','r2_storage'].includes(key)&&value?.ok).length;
  const status=healthy===4?'All core services healthy':healthy?`${healthy}/4 core services healthy`:'Service status unavailable';
  const updated=data.generated_at?new Date(data.generated_at).toLocaleString():new Date().toLocaleString();
  const headerUpdated=$('intelHeaderUpdated');if(headerUpdated)headerUpdated.textContent=`Last catalogue snapshot · ${updated}`;
  const qualityBars=quality.map(x=>({name:x.name,value:x.value}));
  const duplicateHtml=duplicateGroups.length?duplicateGroups.slice(0,6).map(rows=>`<div class="intel-audit-row"><span><strong>${esc(rows[0].title||'Unknown title')}</strong><small>${esc(rows[0].artist||'Unknown artist')} · ${rows.length} matching records</small></span><b class="intel-warning-count">${rows.length-1} extra</b></div>`).join(''):'<div class="intel-empty-state compact"><strong>No title/artist metadata duplicates found</strong><span>The upload form also blocks exact normalised title + artist matches. Audio fingerprint matching is not available in the current catalogue.</span></div>';
  target.innerHTML=`
    <div class="intel-board-topline"><span class="intel-live-label"><i></i> MUSIC INTELLIGENCE</span><span id="intelDataStatus" class="intel-data-status">${esc(status)}</span><small id="intelDataUpdated">Snapshot · ${esc(updated)}</small></div>
    <section class="intel-live-grid">
      <article class="intel-panel intel-live-panel">
        <div class="intel-panel-head"><div><span class="intel-eyebrow">REALTIME AUDIENCE</span><h2>Live listening room</h2><p>Active playback across connected browsers. Listener browsers must use the current frontend build.</p></div><span id="insightLiveStatus" class="storage-pill">CONNECTING</span></div>
        <div class="intel-live-main"><div class="intel-live-count"><strong id="insightListenerCount">—</strong><span>currently playing</span><small id="intelLiveUpdated">Waiting for live presence</small><small class="live-presence-diagnostic" id="intelLiveDiagnostics">Waiting for Realtime diagnostics…</small></div><div id="intelCurrentlyPlaying" class="intel-playing-list"><div class="chart-empty">Waiting for active tracks…</div></div></div>
        <div class="live-audience-summary intel-audience-summary"><div><strong id="intelLiveConnectedMetric">—</strong><span>Connected</span></div><div><strong id="intelLiveMembersMetric">—</strong><span>Members</span></div><div><strong id="intelLiveGuestsMetric">—</strong><span>Guests</span></div></div>
        <div class="intel-user-head"><strong>Connected users</strong><span>All browser sessions · listening or online</span></div>
        <div class="live-audience-tools"><input class="input live-audience-search" id="intelLiveAudienceSearch" type="search" value="${esc(liveAudienceQuery)}" placeholder="Find a member, guest or track…" aria-label="Search connected users"><div class="live-audience-filters" role="group" aria-label="Filter connected users"><button type="button" class="selected" data-act="audience-filter" data-scope="intel" data-filter="all" aria-pressed="true">All</button><button type="button" data-act="audience-filter" data-scope="intel" data-filter="listening" aria-pressed="false">Listening</button><button type="button" data-act="audience-filter" data-scope="intel" data-filter="online" aria-pressed="false">Online</button></div></div>
        <div id="insightLiveUsers" class="intel-user-list"><div class="chart-empty">Waiting for live presence…</div></div>
      </article>
      <article class="intel-panel intel-audience-panel"><div class="intel-panel-head"><div><span class="intel-eyebrow">AUDIENCE COMPOSITION</span><h2>Live audience mix</h2><p>Connected signed-in members versus guest browser sessions.</p></div></div><div id="intelAudienceMix" class="intel-chart-visual"><div class="chart-empty">Waiting for live presence…</div></div><div class="intel-subchart"><h3>Time on current track</h3><div id="intelSessionBands"><div class="chart-empty">Waiting for sessions…</div></div></div></article>
    </section>
    <div class="intel-chart-grid">
      <article class="intel-panel intel-chart-panel"><div class="intel-panel-head"><div><span class="intel-eyebrow">MUSIC CATALOGUE</span><h2>Genre distribution</h2><p>How published and listed tracks are distributed by genre.</p></div></div>${svgDonutChart(genres.slice(0,7),'name','value','tracks')}${genres.length>7?`<details class="intel-more"><summary>Show ${genres.length-7} more genres</summary>${svgBarChart(genres.slice(7),'name','value','chart-bar-engagement')}</details>`:''}</article>
      <article class="intel-panel intel-chart-panel"><div class="intel-panel-head"><div><span class="intel-eyebrow">CATALOGUE GROWTH</span><h2>Upload momentum</h2><p>New catalogue records by day · last seven days.</p></div></div>${svgUploadTrend(uploads)}</article>
      <article class="intel-panel intel-chart-panel"><div class="intel-panel-head"><div><span class="intel-eyebrow">LIVE PLAYBACK</span><h2>What is playing now</h2><p>Current active listening sessions grouped by track.</p></div></div><div id="intelLiveTrackChart"><div class="chart-empty">Waiting for active tracks…</div></div></article>
      <article class="intel-panel intel-chart-panel"><div class="intel-panel-head"><div><span class="intel-eyebrow">ARTIST CATALOGUE</span><h2>Artists by track count</h2><p>Catalogue depth, not play rankings.</p></div></div>${artists.length?svgBarChart(artists.slice(0,7),'name','value','chart-bar-engagement'):'<div class="chart-empty">No artist catalogue records yet.</div>'}${artists.length>7?`<details class="intel-more"><summary>Show ${artists.length-7} more artists</summary>${svgBarChart(artists.slice(7),'name','value','chart-bar-engagement')}</details>`:''}</article>
      <article class="intel-panel intel-chart-panel"><div class="intel-panel-head"><div><span class="intel-eyebrow">LISTENING FOOTPRINT</span><h2>Playback activity</h2><p>Lifetime aggregate metrics currently exposed by SONORA.</p></div></div><div class="intel-playback-stats"><div><span>Play events</span><strong>${plays.toLocaleString()}</strong><small>Recorded playback sessions</small></div><div><span>Total listening time</span><strong>${readableListenTime(playSeconds)}</strong><small>${hours.toFixed(2)} hours combined</small></div><div><span>Average per play</span><strong>${readableListenTime(avgPlay)}</strong><small>${plays?'Derived from total seconds ÷ play events':'No recorded play events yet'}</small></div></div><div class="intel-footprint-bars">${svgBarChart([{name:'Recorded plays',value:plays}],'name','value','chart-bar-engagement')}</div></article>
      <article class="intel-panel intel-chart-panel"><div class="intel-panel-head"><div><span class="intel-eyebrow">CATALOGUE QUALITY</span><h2>Metadata coverage</h2><p>Completeness across the returned catalogue records.</p></div></div>${svgBarChart(qualityBars,'name','value','chart-bar-engagement')}<p class="intel-chart-foot">${catalogue.length.toLocaleString()} returned catalogue records · album is optional for singles.</p></article>
      <article class="intel-panel intel-chart-panel"><div class="intel-panel-head"><div><span class="intel-eyebrow">COLLECTIONS</span><h2>Album depth</h2><p>Largest album and soundtrack groups by track count.</p></div></div>${albums.length?svgBarChart(albums.slice(0,7),'name','value','chart-bar-engagement'):'<div class="chart-empty">No album metadata found yet.</div>'}${albums.length>7?`<details class="intel-more"><summary>Show ${albums.length-7} more albums</summary>${svgBarChart(albums.slice(7),'name','value','chart-bar-engagement')}</details>`:''}</article>
      <article class="intel-panel intel-chart-panel"><div class="intel-panel-head"><div><span class="intel-eyebrow">PLATFORM PERFORMANCE</span><h2>Service response time</h2><p>Latest endpoint probes · lower is faster.</p></div></div>${latencies.length?svgBarChart(latencies.map(x=>({name:x.name,value:x.ms})),'name','value','chart-bar-latency'):'<div class="chart-empty">No latency samples available.</div>'}<div class="intel-service-status">${[['Cloudflare Worker',checks.cloudflare_worker],['Supabase Auth',checks.supabase_auth],['Supabase database',checks.supabase_database],['R2 storage',checks.r2_storage]].map(([name,item])=>`<span><i class="${item?.ok?'is-up':'is-down'}"></i>${esc(name)}</span>`).join('')}</div></article>
    </div>
    <section class="intel-panel intel-catalogue-audit"><div class="intel-panel-head"><div><span class="intel-eyebrow">MUSIC INTEGRITY</span><h2>Duplicate & catalogue audit</h2><p>Automated metadata checks against the current returned catalogue.</p></div><span class="intel-audit-state ${duplicates?'has-warning':'is-clean'}">${duplicates?`${duplicates} possible duplicates`:'No metadata duplicates'}</span></div><div class="intel-audit-grid"><div class="intel-audit-summary"><div><span>Potential duplicate rows</span><strong>${duplicates.toLocaleString()}</strong></div><div><span>Published tracks</span><strong>${published.toLocaleString()}</strong></div><div><span>Catalogue records</span><strong>${total.toLocaleString()}</strong></div></div><div class="intel-audit-list">${duplicateHtml}</div></div><p class="intel-chart-foot">Duplicate detection compares normalised title + artist metadata. It does not perform an audio fingerprint comparison, so alternate filenames or metadata may still represent the same recording.</p></section>
    <details class="intel-panel intel-more-panel"><summary>Show more platform details</summary><div class="intel-details-grid"><div><h3>Service and storage notes</h3><p>${esc(m.metrics_note||'Metrics are based on the latest admin overview response.')}</p><p>R2 objects scanned: ${Number(m.audio_objects_scanned||0).toLocaleString()} · Storage: ${(Number(m.audio_bytes_scanned||0)/1024**3).toFixed(3)} GB · Snapshot duration: ${Number(data.elapsed_ms||0)} ms.</p></div><div><h3>Data coverage</h3><p>Live names, current tracks and session duration come from the existing Realtime presence channel. Historical playtime is available only as platform-wide totals; the existing admin metrics do not expose past play events by individual user.</p><p>Guest IP addresses are not read or displayed in this browser dashboard.</p></div><div><h3>Catalogue protection</h3><p>Uploads are blocked when normalised title and artist match an existing catalogue item. This is a metadata check, not proof of identical audio content.</p></div></div></details>
    <div class="intel-board-footer"><span><i class="intel-health-dot"></i>${esc(status)}</span><span>Analytics snapshot · ${esc(updated)} · Realtime audience updates independently</span></div>`;
  // Repaint the live audience from the existing Presence snapshot after the dashboard DOM exists.
  // A route change does not necessarily trigger a fresh Realtime sync/join event.
  renderLivePresence();
}

/* ---------- delegated clicks ---------- */
$('view').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]'), r = e.target.closest('.row[data-id]');
  if (a) {
    const row = a.closest('.row'), id = a.dataset.id || row?.dataset.id, ctx = a.dataset.ctx || row?.dataset.ctx;
    switch (a.dataset.act) {
      case 'like': toggleLike(id); break;
      case 'queue-add': addToQueue(id); break;
      case 'add': addDialog(id); break;
      case 'remove': removeFromPlaylist(route().id && decodeURIComponent(route().id), id); break;
      case 'playcard': play(id, ctx); break;
      case 'playctx': playContext(ctx, false); break;
      case 'playctx-shuffle': playContext(ctx, true); break;
      case 'genre': genre = genre === a.dataset.genre && route().name === 'search' ? 'All' : a.dataset.genre; if (route().name === 'search') render(); else location.hash = '#/search'; break;
      case 'go': location.hash = `#/${a.dataset.to}`; break;
      case 'newpl': newPlaylistDialog(); break;
      case 'delpl': deletePlaylist(id); break;
      case 'open-album': e.preventDefault(); location.hash = `#/album/${encodeURIComponent(a.dataset.albumId || '')}`; break;
      case 'pref-toggle': togglePreference(a.dataset.kind, a.dataset.value); break;
      case 'save-preferences': saveUserPreferences(true); break;
      case 'theme-mode': applyTheme(a.dataset.value, themeAccent, true); render(); break;
      case 'theme-accent': applyTheme(themeMode, a.dataset.value, true); render(); break;
      case 'save-appearance': applyTheme(themeMode, themeAccent, true); saveUserPreferences(false, true); break;
      case 'admin-refresh': loadAdminDashboard(true); break;
      case 'admin-catalog-more': adminCatalogVisible += 10; if (adminOverview) renderAdminOverview(adminOverview); break;
      case 'admin-catalog-less': adminCatalogVisible = 5; if (adminOverview) renderAdminOverview(adminOverview); break;
      case 'admin-audit-more': adminAuditVisible += 8; if (adminOverview) renderAdminOverview(adminOverview); break;
      case 'admin-audit-less': adminAuditVisible = 5; if (adminOverview) renderAdminOverview(adminOverview); break;
      case 'audience-filter': liveAudienceFilter = ['all','listening','online'].includes(a.dataset.filter) ? a.dataset.filter : 'all'; liveAudienceVisible = 10; renderLivePresence(); break;
      case 'audience-more': liveAudienceVisible += 10; renderLivePresence(); break;
      case 'audience-less': liveAudienceVisible = 10; renderLivePresence(); break;
      case 'admin-delete': deleteAdminTrack(id); break;
      case 'admin-edit': editAdminTrack(id); break;
      case 'signout': signOutUser(a); break;
      case 'password-reset': sendAccountPasswordReset(); break;
    }
    return;
  }
  if (r) play(r.dataset.id, r.dataset.ctx);
});
$('view').addEventListener('input', (e) => {
  if (e.target.id === 'adminCatalogSearch') { adminCatalogQuery = e.target.value; adminCatalogVisible = 5; if (adminOverview) renderAdminOverview(adminOverview); const search=$('adminCatalogSearch'); if(search){search.focus();search.setSelectionRange(search.value.length,search.value.length);} }
  if (e.target.id === 'adminLiveAudienceSearch' || e.target.id === 'intelLiveAudienceSearch') { liveAudienceQuery = e.target.value; liveAudienceVisible = 10; renderLivePresence(); const search=$(e.target.id); if(search){search.focus();search.setSelectionRange(search.value.length,search.value.length);} }
  if (e.target.id === 'prefDisplayName') preferenceNameDraft = e.target.value;
  if (e.target.id === 'autoplayNext') autoplayDraft = e.target.checked;
  if (e.target.id === 'settingsVolume') { const value=Math.max(0,Math.min(100,Number(e.target.value)||0)); $('vol').value=String(value); setVol(value); store.set('sonora-vol',value); const label=$('settingsVolumeValue'); if(label)label.textContent=`${value}%`; }
});
$('view').addEventListener('change', (e) => { if(e.target.id==='adminAudioFile') { const files=Array.from(e.target.files||[]); const label=$('sonoraSelectedFile'); if(label)label.textContent=files.length?`${files.length} file(s) selected · ${files.slice(0,3).map(f=>f.name).join(', ')}${files.length>3?'…':''}`:'No files selected'; if(files.length===1){adminDetectedFile=null;adminDetectionPromise=detectAdminAudio(files[0]).finally(()=>{adminDetectionPromise=null;});} else if(files.length>1){adminDetectedFile=null;setAdminMetaStatus(`${files.length} files queued. Metadata and soundtrack recognition will run separately for each file during upload.`);} } });
$('view').addEventListener('dragover', (e) => { const zone=e.target.closest('#sonoraDropzone'); if(zone){e.preventDefault();zone.classList.add('dragover');} });
$('view').addEventListener('dragleave', (e) => { const zone=e.target.closest('#sonoraDropzone'); if(zone && !zone.contains(e.relatedTarget))zone.classList.remove('dragover'); });
$('view').addEventListener('drop', (e) => { const zone=e.target.closest('#sonoraDropzone'); if(!zone)return; e.preventDefault(); zone.classList.remove('dragover'); const files=Array.from(e.dataTransfer?.files||[]).filter(f=>f.type.startsWith('audio/')||/\.(mp3|m4a|mp4|aac|wav|ogg|opus|flac|webm)$/i.test(f.name)); if(!files.length)return; const input=$('adminAudioFile'); const transfer=new DataTransfer(); files.forEach(file=>transfer.items.add(file)); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); });
$('view').addEventListener('submit', (e) => {
  if (e.target.id === 'adminUploadForm') {
    e.preventDefault();
    uploadAdminBatch(e.target);
  }
  if (e.target.id === 'settingsForm') {
    e.preventDefault();
    saveUserPreferences(false);
  }
});
$('view').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('row')) { e.preventDefault(); play(e.target.dataset.id, e.target.dataset.ctx); }
});
const onSearch = debounce((v) => { query = v; if (route().name !== 'search') location.hash = '#/search'; else render(); }, 140);
$('topSearch').addEventListener('input', (e) => onSearch(e.target.value));
document.addEventListener('keydown', (e) => {
  if (dlg.open || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (e.key === '/' && tag !== 'INPUT') { e.preventDefault(); $('topSearch').focus(); }
  if (e.code === 'Space' && (tag === 'BODY' || e.target === $('view'))) { e.preventDefault(); toggle(); }
});

/* ---------- accounts ---------- */
let mode = 'signin';
const authEl = $('auth');
const friendly = (m = '') => /auth session missing|session missing/i.test(m) ? 'Your saved sign-in session is no longer available. Please sign in again. Your music catalogue and local preferences are not deleted.'
  : /invalid login/i.test(m) ? 'Email or password is incorrect.' : /not confirmed/i.test(m) ? 'Confirm your email first — check your inbox for the link.'
  : /already registered|already been registered/i.test(m) ? 'An account with this email already exists. Try signing in.' : /rate limit|too many/i.test(m) ? 'Too many attempts. Wait a minute and try again.'
  : /password/i.test(m) ? m : /fetch|network/i.test(m) ? 'Network problem. Check your connection and try again.' : m || 'Something went wrong. Try again.';
function setMode(m) {
  mode = m; const up = m === 'signup', rs = m === 'reset';
  $('tabIn').setAttribute('aria-selected', !up); $('tabUp').setAttribute('aria-selected', up);
  $('authTitle').textContent = rs ? 'Reset password' : up ? 'Join SONORA' : 'Welcome back';
  $('authSub').textContent = rs ? 'We will email you a reset link.' : up ? 'Create an account to sync likes and playlists.' : 'Sign in to sync your library.';
  $('pwField').classList.toggle('hidden', rs); $('forgotBtn').classList.toggle('hidden', rs || up);
  $('authPw').autocomplete = up ? 'new-password' : 'current-password';
  $('authSubmit').textContent = rs ? 'Send reset link' : up ? 'Create account' : 'Sign in';
  msg('');
}
function msg(text, kind = '') { const m = $('authMsg'); m.textContent = text; m.className = `msg ${kind}`; }
function showAuth(m = 'signin') {
  setMode(m); authEl.classList.remove('hidden'); $('app').setAttribute('inert', ''); document.querySelector('.player').setAttribute('inert', '');
  document.querySelector('.tabbar').setAttribute('inert', ''); $('authEmail').focus({ preventScroll:true });
  if (!cloud) msg('Cloud sign-in is not configured yet. You can continue as a guest.');
}
function hideAuth() {
  authEl.classList.add('hidden'); ['app'].forEach((i) => $(i).removeAttribute('inert'));
  document.querySelector('.player').removeAttribute('inert'); document.querySelector('.tabbar').removeAttribute('inert');
}
$('tabIn').addEventListener('click', () => setMode('signin')); $('tabUp').addEventListener('click', () => setMode('signup'));
$('forgotBtn').addEventListener('click', () => setMode('reset'));
$('pwToggle').addEventListener('click', () => {
  const show = $('authPw').type === 'password'; $('authPw').type = show ? 'text' : 'password';
  $('pwToggle').innerHTML = ic(show ? 'eye-off' : 'eye'); $('pwToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});
$('guestBtn').addEventListener('click', () => { store.set('sonora-guest', true); livePresenceSuppressed = false; hideAuth(); if (livePresenceReady) publishLivePresence(); });
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!cloud) { msg('Cloud sign-in is not configured yet. You can continue as a guest.', 'err'); return; }
  const email = $('authEmail').value.trim(), pw = $('authPw').value;
  if (!$('authEmail').checkValidity() || !email) { msg('Enter a valid email address.', 'err'); $('authEmail').focus(); return; }
  if (mode !== 'reset' && pw.length < 8) { msg('Use a password with at least 8 characters.', 'err'); $('authPw').focus(); return; }
  const btn = $('authSubmit'), label = btn.textContent; btn.disabled = true; btn.textContent = 'Please wait…'; msg('');
  const back = location.origin + location.pathname;
  let res;
  try {
    res = mode === 'reset' ? await sb.auth.resetPasswordForEmail(email, { redirectTo:back })
      : mode === 'signup' ? await sb.auth.signUp({ email, password:pw, options:{ emailRedirectTo:back } })
      : await sb.auth.signInWithPassword({ email, password:pw });
  } catch (err) { res = { error:err }; }
  btn.disabled = false; btn.textContent = label;
  if (res.error) { msg(friendly(res.error.message), 'err'); return; }
  if (mode === 'reset') { msg('Check your inbox for the reset link.', 'ok'); return; }
  if (mode === 'signup' && !res.data?.session) { msg('Account created. Confirm your email, then sign in.', 'ok'); return; }
  let signedInSession = res.data?.session || null;
  if (!signedInSession) {
    try { signedInSession = (await sb.auth.getSession()).data?.session || null; }
    catch (sessionError) { console.warn('SONORA sign-in session read:', sessionError?.message || sessionError); }
  }
  if (!signedInSession?.user) { msg('The sign-in request completed, but this browser could not restore the session. Please try signing in once more.', 'err'); return; }
  try { await handleAuthSession('SIGNED_IN', signedInSession); }
  catch (sessionError) { console.error('SONORA post-sign-in setup:', sessionError); }
  hideAuth(); notify(mode === 'signup' ? 'Welcome to SONORA.' : 'Signed in.');
});
function refreshAccount() {
  document.body.classList.toggle('is-admin', Boolean(isAdmin));
  const b = $('acctBtn');
  if (user) { b.className = 'acct in'; b.innerHTML = `${ic('user')}<span>Account</span>`; }
  else { b.className = 'acct'; b.textContent = 'Sign in'; }
  $('syncTitle').textContent = user ? 'Synced' : 'Guest mode';
  $('syncText').textContent = user ? (isAdmin ? 'Administrator account · cloud library synced.' : 'Likes and playlists follow you across devices.') : 'Likes and playlists stay on this device until you sign in.';
  const nav = $('adminNav');
  if (nav) nav.classList.toggle('hidden', !isAdmin);
  const intelligenceNav = $('diagnosticsNav');
  if (intelligenceNav) intelligenceNav.classList.toggle('hidden', !isAdmin);
  const mobileIntelligenceNav = $('mobileDiagnosticsNav');
  if (mobileIntelligenceNav) mobileIntelligenceNav.classList.toggle('hidden', !isAdmin);
  const mobileAdminNav = $('mobileAdminNav');
  if (mobileAdminNav) mobileAdminNav.classList.toggle('hidden', !isAdmin);
}
async function finishPlaybackBeforeSignOut() {
  // Pause first so no further seconds are accrued while authentication is being cleared.
  if (audio && !audio.paused) audio.pause();
  if (playEventCreating) {
    playFinishRequested = true;
    const started = Date.now();
    while (playEventCreating && Date.now() - started < 5000) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (playFlushBusy) {
    const started = Date.now();
    while (playFlushBusy && Date.now() - started < 5000) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (currentPlayEventId) await flushPlaybackTime(currentPlayEventId, true);
}
async function clearSignedOutPresence() {
  livePresenceSuppressed = true;
  try { await finishPlaybackBeforeSignOut(); }
  catch (error) { console.warn('SONORA playback finalisation during sign-out:', error?.message || error); }
  try {
    if (livePresenceChannel && livePresenceReady) await livePresenceChannel.untrack();
  } catch (error) { console.warn('SONORA presence cleanup during sign-out:', error?.message || error); }
  liveTrackIdentity = '';
  liveTrackStartedAt = 0;
  liveListenerSnapshot = [];
  livePresenceAllSnapshot = [];
  if (['admin', 'diagnostics'].includes(route().name)) renderLivePresence();
}
async function signOutUser(button) {
  if (!sb || signOutInProgress) return;
  if (!user) { showAuth('signin'); notify('You are already signed out on this device.'); return; }
  signOutInProgress = true;
  const originalHtml = button?.innerHTML;
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Signing out…'; }
  try {
    // Check storage first. A stale in-memory user can outlive a removed/expired local session.
    const before = await sb.auth.getSession();
    if (before.error) throw before.error;
    if (!before.data?.session) {
      await handleAuthSession('SIGNED_OUT', null);
      closeDlg();
      notify('Your previous sign-in session had already expired on this device. Please sign in again.');
      return;
    }
    await clearSignedOutPresence();
    const result = await sb.auth.signOut({ scope: 'local' });
    const after = await sb.auth.getSession();
    if (after.error) throw after.error;
    if (after.data?.session) throw result?.error || new Error('This browser still has an active sign-in session. Please try again.');
    // A missing-session error after local storage is confirmed empty is not a logout failure.
    await handleAuthSession('SIGNED_OUT', null);
    closeDlg();
    notify(result?.error ? 'Signed out on this device. The local session is cleared.' : 'Signed out on this device.');
  } catch (error) {
    let stillSignedIn = false;
    try { stillSignedIn = Boolean((await sb.auth.getSession()).data?.session); } catch { /* retain conservative state */ }
    if (stillSignedIn) {
      livePresenceSuppressed = false;
      if (livePresenceReady) await publishLivePresence();
    }
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = originalHtml || `${ic('user')}Sign out`; }
    notify(`Could not sign out: ${friendly(error?.message || String(error))}`);
  } finally {
    signOutInProgress = false;
    if (button && !user) { button.disabled = false; button.removeAttribute('aria-busy'); }
  }
}
$('acctBtn').addEventListener('click', () => {
  if (!user) { showAuth('signin'); return; }
  clonePrefsDraft();
  location.hash = '#/settings';
});
async function sendAccountPasswordReset() {
  if (!user?.email || !sb) return;
  const redirectTo = location.origin + location.pathname;
  const { error } = await sb.auth.resetPasswordForEmail(user.email, { redirectTo });
  if (error) notify(`Could not send password reset email: ${friendly(error.message)}`);
  else notify('Password reset link sent to your account email.');
}
function newPasswordDialog() {
  openDlg('Choose a new password', `<form id="npForm"><div class="field"><label for="npPw">New password</label><input class="input" id="npPw" type="password" minlength="8" autocomplete="new-password" required></div><p class="msg" id="npMsg" role="status"></p><button class="btn btn-primary" style="width:100%" type="submit">Save password</button></form>`);
  $('npForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const { error } = await sb.auth.updateUser({ password:$('npPw').value });
    if (error) { $('npMsg').textContent = friendly(error.message); $('npMsg').className = 'msg err'; } else { closeDlg(); notify('Password updated.'); }
  });
}


// SONORA is delivered as a responsive website. Remove only SONORA's legacy
// service worker; never unregister unrelated apps' workers on a shared origin.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const appRoot = new URL('./', location.href);
      const sonoraWorkerPath = new URL('sw.js', appRoot).pathname;
      const registrations = await navigator.serviceWorker.getRegistrations();
      const sonoraRegistrations = registrations.filter((registration) => {
        const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
        return workers.some((worker) => {
          try {
            const script = new URL(worker.scriptURL);
            return script.origin === appRoot.origin && script.pathname === sonoraWorkerPath;
          } catch { return false; }
        });
      });
      await Promise.all(sonoraRegistrations.map((registration) => registration.unregister()));
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith('sonora-shell-')).map((key) => caches.delete(key)));
      }
    } catch (err) {
      console.warn('Could not clear an old SONORA app cache:', err);
    }
  });
}

/* ---------- auth session orchestration + start ---------- */
async function handleAuthSession(event, session) {
  // Also handle sign-outs initiated in another tab or by session expiry.
  // Do this before replacing `user`, so the final playback event can still be saved.
  if (event === 'SIGNED_OUT' && user) await clearSignedOutPresence();
  else if (session?.user) livePresenceSuppressed = false;
  user = session?.user || null;
  if (sb && session?.access_token) { try { await sb.realtime.setAuth(session.access_token); } catch (error) { console.warn('SONORA Realtime auth update:', error?.message || error); } }
  refreshAccount();
  if (event === 'PASSWORD_RECOVERY') { hideAuth(); newPasswordDialog(); return; }
  const uid = user?.id || null;
  if (uid !== lastUid) {
    lastUid = uid;
    if (user) {
      store.set('sonora-guest', false);
      hideAuth();
      await Promise.allSettled([loadLibrary(), loadUserPreferences(), verifyAdminAccess()]);
      refreshAccount();
      if (preferencesSchemaReady && !userPreferences.onboarding_completed) {
        clonePrefsDraft();
        if (route().name !== 'preferences') location.hash = '#/preferences';
        else render();
      } else if (route().name === 'preferences') location.hash = '#/home';
      if ((route().name === 'admin' || route().name === 'diagnostics') && !isAdmin) location.hash = '#/home';
    } else {
      isAdmin = false;
      adminOverview = null; adminLoadError = ''; adminCatalogQuery = ''; adminCatalogVisible = 5; adminAuditVisible = 5;
      preferenceDraft = { genres:[], moods:[] }; preferenceNameDraft = '';
      userPreferences = { display_name:'', preferred_genres:[], preferred_moods:[], onboarding_completed:false, autoplay_next:store.get('sonora-autoplay-next', true), theme_mode:'system', theme_accent:'violet' };
      autoplayDraft = userPreferences.autoplay_next !== false;
      preferencesSchemaReady = false;
      if ($('authPw')) $('authPw').value = '';
      refreshAccount();
      await loadLibrary();
      if (route().name === 'admin' || route().name === 'diagnostics' || route().name === 'settings' || route().name === 'preferences') location.hash = '#/home';
      if (event === 'SIGNED_OUT' && !store.get('sonora-guest', false)) showAuth('signin');
    }
  } else if (user) {
    hideAuth();
    refreshAccount();
  }
  if (livePresenceReady) publishLivePresence();
}
async function init() {
  store.set('sonora-liked', [...liked]);
  store.set('sonora-playlists', playlists);
  render(); refreshAccount();
  if (!cloud) { if (!store.get('sonora-guest', false)) showAuth('signin'); return; }
  sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, flowType:'pkce' } });
  let session = null;
  try {
    // Let the auth client finish restoring storage (and any refresh) before adding
    // listeners or making other Supabase calls. This avoids an initialization race.
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    session = data?.session || null;
  } catch (error) { console.error('SONORA session restore:', error); }
  await handleAuthSession('INITIAL_SESSION', session);
  // Subscribe only after the initial storage read has resolved. Never await Supabase
  // calls directly in this callback; defer all state work outside the auth lock.
  sb.auth.onAuthStateChange((event, nextSession) => {
    window.setTimeout(() => { handleAuthSession(event, nextSession).catch((error) => console.error('SONORA auth state:', error)); }, 0);
  });
  // Start presence only after Supabase has restored the current auth state/JWT.
  startLivePresence();
  if (!livePresenceHeartbeatTimer) livePresenceHeartbeatTimer = window.setInterval(async () => { if (livePresenceReady) { await publishLivePresence(); readLivePresenceSnapshot(); if (['admin','diagnostics'].includes(route().name)) renderLivePresence(); } }, 15000);
  if (!user && !store.get('sonora-guest', false)) showAuth('signin');
  await loadCatalogue();
  if (!user) await loadLibrary();
}
init();
})();
