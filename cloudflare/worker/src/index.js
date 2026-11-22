/**
 * SONORA edge API — private R2 streaming + owner-only administration.
 * Upload fix 3.3: use FixedLengthStream for known-size audio bodies and byte buffers for artwork.
 *
 * Public:
 *   GET|HEAD /health
 *   GET      /                 service discovery
 *   GET|HEAD /stream/<object-key>  audio with byte-range seeking
 *
 * Authenticated, allowlisted admin only:
 *   GET      /admin/me
 *   GET      /admin/overview
 *   POST     /admin/cover (administrator artwork upload)
 *   POST     /admin/upload?title=...&artist=...&album=...&genre=...&filename=...
 *   PATCH    /admin/tracks/<uuid>
 *   DELETE   /admin/tracks/<uuid>
 *
 * Required bindings / vars:
 *   AUDIO (R2 bucket binding)
 *   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ADMIN_EMAIL, ALLOWED_ORIGIN
 * Required Worker secret:
 *   SUPABASE_SECRET_KEY (sb_secret_...; never put in GitHub or the browser)
 */
const VERSION = '3.6.0';
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_TRACKS_RETURNED = 250;
const UPLOADS_PER_HOUR = 12;
const AUDIO_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm'
};
const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}
function text(message, status = 400, headers = {}) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map((x) => x.trim()).filter(Boolean);
  const headers = {
    Vary: 'Origin',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, X-SONORA-Version'
  };
  if (origin && (allowed.includes(origin) || allowed.includes('*'))) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
function withCors(response, headers) {
  const h = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) h.set(key, value);
  h.set('X-SONORA-Version', VERSION);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
function cleanString(value, max = 160) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}
function cleanDescription(value, max = 2000) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}
function normalizeTrackText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function parseRange(value, size) {
  if (!value) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
  return { start, end, status: 206 };
}
async function supabaseHealth(env) {
  const result = { ok: false, status: 'not_configured', latency_ms: null };
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return result;
  const start = Date.now();
  try {
    const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/health`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(8000)
    });
    result.ok = response.ok;
    result.status = response.ok ? 'healthy' : `http_${response.status}`;
    result.latency_ms = Date.now() - start;
  } catch (error) {
    result.status = 'unreachable';
    result.message = String(error?.message || error).slice(0, 180);
    result.latency_ms = Date.now() - start;
  }
  return result;
}
async function publicDatabaseHealth(env) {
  const result = { ok: false, status: 'not_configured', latency_ms: null };
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return result;
  const start = Date.now();
  try {
    const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/tracks?select=id&limit=1`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(8000)
    });
    result.ok = response.ok;
    result.status = response.ok ? 'healthy' : `http_${response.status}`;
    if (!response.ok) result.message = (await response.text()).slice(0, 180);
    result.latency_ms = Date.now() - start;
  } catch (error) {
    result.status = 'unreachable';
    result.message = String(error?.message || error).slice(0, 180);
    result.latency_ms = Date.now() - start;
  }
  return result;
}
async function r2Health(env) {
  const result = { ok: false, status: 'not_bound', latency_ms: null };
  if (!env.AUDIO) return result;
  const start = Date.now();
  try {
    await env.AUDIO.list({ limit: 1 });
    result.ok = true;
    result.status = 'healthy';
    result.latency_ms = Date.now() - start;
  } catch (error) {
    result.status = 'error';
    result.message = String(error?.message || error).slice(0, 180);
    result.latency_ms = Date.now() - start;
  }
  return result;
}
async function supabaseRest(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error('Supabase server secret is not configured on the Worker. Add SUPABASE_SECRET_KEY under Worker runtime secrets.');
  }
  const url = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`;
  const headers = new Headers(options.headers || {});
  headers.set('apikey', env.SUPABASE_SECRET_KEY);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...options, headers, signal: options.signal || AbortSignal.timeout(15000) });
}
async function readJson(response) {
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { message: raw.slice(0, 400) }; }
  if (!response.ok) {
    const message = data?.message || data?.error_description || data?.hint || `Supabase returned HTTP ${response.status}`;
    throw new Error(String(message).slice(0, 320));
  }
  return data;
}
async function authenticateAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return { error: json({ error: 'Sign in with your SONORA admin account first.' }, 401) };
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SECRET_KEY) {
    return { error: json({ error: 'Admin API is not fully configured. Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and the SUPABASE_SECRET_KEY Worker secret.' }, 503) };
  }
  try {
    const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return { error: json({ error: 'Your session is invalid or expired. Sign in again.' }, 401) };
    const user = await response.json();
    const email = String(user.email || '').trim().toLowerCase();
    const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!adminEmail || email !== adminEmail) return { error: json({ error: 'This account is not authorized for SONORA administration.' }, 403) };
    if (!(user.email_confirmed_at || user.confirmed_at)) return { error: json({ error: 'Confirm the administrator email address before using admin tools.' }, 403) };
    return { user };
  } catch (error) {
    return { error: json({ error: `Could not verify administrator session: ${String(error?.message || error).slice(0, 180)}` }, 503) };
  }
}
async function writeAudit(env, user, action, details = {}) {
  try {
    await supabaseRest(env, 'sonora_admin_audit', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ admin_user_id: user.id, admin_email: user.email, action, details })
    });
  } catch (error) {
    console.error('SONORA audit write failed:', error?.message || error);
  }
}
async function enforceUploadRate(env, user) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const path = `sonora_upload_events?select=id&user_id=eq.${encodeURIComponent(user.id)}&created_at=gte.${encodeURIComponent(since)}`;
  const response = await supabaseRest(env, path, { headers: { Prefer: 'count=exact' } });
  if (!response.ok) throw new Error(`Upload rate-limit check failed: ${(await response.text()).slice(0, 180)}`);
  const range = response.headers.get('Content-Range') || '';
  const total = Number(range.split('/').pop());
  if (Number.isFinite(total) && total >= UPLOADS_PER_HOUR) return false;
  const log = await supabaseRest(env, 'sonora_upload_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: user.id, action: 'upload' })
  });
  if (!log.ok) throw new Error(`Upload audit/rate-limit table is not ready: ${(await log.text()).slice(0, 180)}`);
  return true;
}
async function getAdminOverview(env, user) {
  const started = Date.now();
  const [authCheck, dbCheck, storageCheck] = await Promise.all([
    supabaseHealth(env),
    (async () => {
      const check = { ok: false, status: 'unknown', latency_ms: null };
      const t = Date.now();
      try {
        const r = await supabaseRest(env, 'tracks?select=id&limit=1');
        check.ok = r.ok; check.status = r.ok ? 'healthy' : `http_${r.status}`;
        check.latency_ms = Date.now() - t;
        if (!r.ok) check.message = (await r.text()).slice(0, 180);
      } catch (e) {
        check.status = 'error'; check.message = String(e?.message || e).slice(0, 180); check.latency_ms = Date.now() - t;
      }
      return check;
    })(),
    r2Health(env)
  ]);

  // Deeper operational probes. These are read-only and use the Worker's private
  // server credential; no service secrets are returned to the browser.
  const tableNames = ['tracks','playlists','playlist_tracks','likes','sonora_user_preferences','sonora_admin_audit','sonora_upload_events','sonora_play_events'];
  const tableChecks = await Promise.all(tableNames.map(async (table) => {
    const started = Date.now();
    try {
      const response = await supabaseRest(env, `${table}?select=*&limit=0`);
      return { name:table, ok:response.ok, status:response.ok?'reachable':`http_${response.status}`, latency_ms:Date.now()-started,
        message:response.ok?undefined:(await response.text()).slice(0,140) };
    } catch (error) {
      return { name:table, ok:false, status:'error', latency_ms:Date.now()-started, message:String(error?.message||error).slice(0,140) };
    }
  }));
  const workerRuntime = {
    ok:true, version:VERSION, checked_at:new Date().toISOString(),
    note:'Cloudflare CPU time, request volume, edge error rates and billable usage require Cloudflare Analytics/Observability API access; they are not exposed by the Worker runtime itself.'
  };

  let tracks = [], trackCount = 0, publishedCount = 0, tracksError = null;
  try {
    const [listResponse, publishedResponse] = await Promise.all([
      supabaseRest(env, `tracks?select=id,title,artist,album,genre,description,audio_key,duration_seconds,file_size,mime_type,cover_url,status,created_at&order=created_at.desc&limit=${MAX_TRACKS_RETURNED}`, {
        headers: { Prefer: 'count=exact' }
      }),
      supabaseRest(env, 'tracks?select=id&status=eq.published&limit=1', {
        headers: { Prefer: 'count=exact' }
      })
    ]);
    if (!listResponse.ok) throw new Error((await listResponse.text()).slice(0, 220));
    if (!publishedResponse.ok) throw new Error((await publishedResponse.text()).slice(0, 220));
    tracks = await listResponse.json();
    const total = Number((listResponse.headers.get('Content-Range') || '').split('/').pop());
    const publishedTotal = Number((publishedResponse.headers.get('Content-Range') || '').split('/').pop());
    trackCount = Number.isFinite(total) ? total : tracks.length;
    publishedCount = Number.isFinite(publishedTotal) ? publishedTotal : tracks.filter((t) => t.status === 'published').length;
  } catch (e) { tracksError = String(e?.message || e).slice(0, 220); }

  let objectCount = 0, storageBytes = 0, r2Truncated = false, r2ObjectsScanned = 0;
  if (storageCheck.ok) {
    try {
      let cursor;
      for (let page = 0; page < 50; page++) {
        const listing = await env.AUDIO.list({ limit: 1000, cursor });
        for (const object of listing.objects || []) {
          objectCount++;
          storageBytes += Number(object.size) || 0;
        }
        r2ObjectsScanned += (listing.objects || []).length;
        if (page === 0 && listing.objects?.length) {
          const sampleStarted = Date.now();
          try {
            const sample = await env.AUDIO.head(listing.objects[0].key);
            storageCheck.sample_object = { ok:!!sample, latency_ms:Date.now()-sampleStarted, size:sample?.size||0 };
          } catch (error) {
            storageCheck.sample_object = { ok:false, latency_ms:Date.now()-sampleStarted, message:String(error?.message||error).slice(0,140) };
          }
        }
        if (!listing.truncated) { r2Truncated = false; break; }
        r2Truncated = true; cursor = listing.cursor;
      }
    } catch (e) {
      storageCheck.ok = false; storageCheck.status = 'error'; storageCheck.message = String(e?.message || e).slice(0, 180);
    }
  }

  let audit = [];
  try {
    const r = await supabaseRest(env, 'sonora_admin_audit?select=id,action,details,created_at&order=created_at.desc&limit=12');
    if (r.ok) audit = await r.json();
  } catch (e) { /* audit history is non-critical */ }

  const genreCounts = {};
  for (const track of tracks) {
    const genre = cleanString(track.genre || 'Other', 40) || 'Other';
    genreCounts[genre] = (genreCounts[genre] || 0) + 1;
  }
  const uploadsByDay = Array.from({length:7}, (_, index) => {
    const day = new Date(); day.setUTCHours(0,0,0,0); day.setUTCDate(day.getUTCDate() - (6-index));
    const key = day.toISOString().slice(0,10);
    return { date:key, label:key.slice(5), count:tracks.filter(t => String(t.created_at||'').slice(0,10) === key).length };
  });
  let playStats = { total_play_events:0, total_play_seconds:0 };
  try {
    const playResponse = await supabaseRest(env, 'rpc/sonora_admin_play_stats', { method:'POST', body:'{}' });
    if (playResponse.ok) { const value=await playResponse.json(); playStats={ total_play_events:Number(value?.total_play_events||0), total_play_seconds:Number(value?.total_play_seconds||0) }; }
  } catch (error) { console.warn('SONORA play stats unavailable:', error?.message||error); }

  const serviceChecks = {
    supabase_tables: tableChecks,
    r2_sample_object: storageCheck.sample_object || null,
    cloudflare_runtime: workerRuntime
  };

  return {
    ok: authCheck.ok && dbCheck.ok && storageCheck.ok && !tracksError && tableChecks.every(x => x.ok),
    admin: { email: user.email, user_id: user.id },
    checks: { cloudflare_worker: { ok:true, status:'online', version:VERSION, latency_ms:Date.now()-started }, supabase_auth: authCheck, supabase_database: dbCheck, r2_storage: storageCheck, ...serviceChecks },
    metrics: {
      genre_distribution:genreCounts,
      uploads_by_day:uploadsByDay,
      table_checks_total:tableChecks.length,
      table_checks_failed:tableChecks.filter(x=>!x.ok).length,
      tracks_total: trackCount,
      tracks_published: publishedCount,
      tracks_removed_or_draft: Math.max(0, trackCount - publishedCount),
      audio_objects_scanned: objectCount,
      audio_bytes_scanned: storageBytes,
      estimated_storage_usd_month: Math.max(0, (storageBytes / (1024 ** 3)) - 10) * 0.015,
      ...playStats,
      r2_scan_truncated: r2Truncated,
      tracks_listed: tracks.length,
      metrics_note: trackCount > tracks.length || r2Truncated ? 'Counts/bytes cover the returned catalogue rows and first 50,000 R2 objects; check Cloudflare R2 metrics for exact account-wide usage.' : 'Catalogue and R2 object scan completed.'
    },
    tracks,
    audit,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started
  };
}
async function findDuplicateTrack(env, title, artist) {
  // Narrow by case-insensitive title first, then compare normalized title + artist.
  // This keeps the check server-side and catches collisions outside the 500-row browser catalogue.
  const query = new URLSearchParams({ select:'id,title,artist,status', status:'neq.removed', limit:'100' });
  query.set('title', `ilike.${String(title).replace(/[%_*]/g, (value) => `\\${value}`)}`);
  const response = await supabaseRest(env, `tracks?${query.toString()}`);
  if (!response.ok) throw new Error(`Could not check the existing catalogue for duplicates: ${(await response.text()).slice(0,220)}`);
  const candidates = await response.json();
  const normalizedTitle = normalizeTrackText(title), normalizedArtist = normalizeTrackText(artist);
  return candidates.find(track => normalizeTrackText(track.title) === normalizedTitle && normalizeTrackText(track.artist) === normalizedArtist) || null;
}

async function adminRoute(request, env, url) {
  const auth = await authenticateAdmin(request, env);
  if (auth.error) return auth.error;
  const user = auth.user;
  if (url.pathname === '/admin/me' && request.method === 'GET') {
    return json({ ok: true, is_admin: true, email: user.email, user_id: user.id });
  }
  if (url.pathname === '/admin/overview' && request.method === 'GET') {
    return json(await getAdminOverview(env, user));
  }
  if (url.pathname === '/admin/cover' && request.method === 'POST') {
    if (!env.AUDIO) return json({ error:'R2 bucket binding AUDIO is missing.' }, 503);
    const type=(request.headers.get('Content-Type')||'').toLowerCase();
    if (!['image/jpeg','image/png','image/webp','image/gif'].includes(type)) return json({error:'Artwork must be JPG, PNG, WEBP or GIF.'},415);
    if (!request.body) return json({error:'Artwork body is empty.'},400);
    const imageExt = ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'})[type];
    const key=`covers/${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}.${imageExt}`;
    try {
      // Artwork is capped at 5 MB, so buffer it to a known-length Uint8Array.
      // Passing request.body directly can fail because R2 requires a known-length stream.
      const artworkBytes = await request.arrayBuffer();
      if (!artworkBytes.byteLength) return json({error:'Artwork body is empty.'},400);
      if (artworkBytes.byteLength > 5*1024*1024) return json({error:'Artwork must be 5 MB or smaller.'},413);
      const object=await env.AUDIO.put(key,artworkBytes,{httpMetadata:{contentType:type,cacheControl:'public, max-age=31536000, immutable'}});
      const base=String(env.PUBLIC_STREAM_URL||new URL(request.url).origin).replace(/\/$/,'');
      const cover_url=`${base}/stream/${key.split('/').map(encodeURIComponent).join('/')}`;
      return json({ok:true,cover_url,cover_key:key},201);
    } catch(error){return json({error:String(error?.message||error).slice(0,240)},500);}
  }
  if (url.pathname === '/admin/upload' && request.method === 'POST') {
    if (!env.AUDIO) return json({ error: 'R2 bucket binding AUDIO is missing.' }, 503);
    const contentLength = request.headers.get('Content-Length');
    const length = contentLength ? Number(contentLength) : 0;
    if (contentLength && (!Number.isFinite(length) || length <= 0)) return json({ error: 'Upload body is empty or its Content-Length is invalid.' }, 400);
    if (length > MAX_UPLOAD_BYTES) return json({ error: `File is too large. Maximum direct upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` }, 413);
    const title = cleanString(url.searchParams.get('title'), 160);
    const artist = cleanString(url.searchParams.get('artist'), 120);
    const album = cleanString(url.searchParams.get('album') || 'Single', 160);
    const genre = cleanString(url.searchParams.get('genre') || 'Other', 60);
    const filename = cleanString(url.searchParams.get('filename'), 240);
    const duration = Math.max(0, Math.floor(Number(url.searchParams.get('duration') || 0)));
    if (!title || !artist) return json({ error: 'Track title and artist are required.' }, 400);
    const ext = (filename.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const mime = AUDIO_TYPES[ext];
    if (!mime) return json({ error: 'Unsupported audio format. Upload MP3, M4A, AAC, WAV, OGG, OPUS, FLAC or WEBM.' }, 415);
    if (!request.body) return json({ error: 'The upload has no file body.' }, 400);
    const requestedMime = (request.headers.get('Content-Type') || '').toLowerCase();
    if (requestedMime && requestedMime !== 'application/octet-stream' && !requestedMime.startsWith('audio/')) {
      return json({ error: 'The selected file must have an audio content type.' }, 415);
    }
    const storedMime = requestedMime.startsWith('audio/') ? requestedMime : mime;
    try {
      const duplicate = await findDuplicateTrack(env, title, artist);
      if (duplicate) return json({ error:`Possible duplicate blocked: “${duplicate.title}” by ${duplicate.artist} is already in the catalogue.`, duplicate_track_id:duplicate.id }, 409);
    } catch (error) {
      return json({ error:String(error?.message||error).slice(0,300) }, 503);
    }
    let permitted;
    try { permitted = await enforceUploadRate(env, user); }
    catch (e) { return json({ error: e.message }, 503); }
    if (!permitted) return json({ error: `Upload limit reached: maximum ${UPLOADS_PER_HOUR} tracks per hour.` }, 429);
    const key = `tracks/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
    try {
      let streamedBytes = 0;
      const putOptions = {
        httpMetadata: { contentType: storedMime, cacheControl: 'public, max-age=86400' },
        customMetadata: { title, artist, album, genre, uploaded_by: user.id }
      };
      let object;
      if (length > 0) {
        // R2 requires a known-length stream. FixedLengthStream communicates the
        // exact Content-Length while preserving streaming and browser progress.
        const fixedLength = new FixedLengthStream(length);
        const sizeGuard = request.body.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            streamedBytes += chunk.byteLength;
            if (streamedBytes > MAX_UPLOAD_BYTES) controller.error(new Error('SONORA_UPLOAD_TOO_LARGE'));
            else controller.enqueue(chunk);
          }
        }));
        const [ , storedObject ] = await Promise.all([
          sizeGuard.pipeTo(fixedLength.writable),
          env.AUDIO.put(key, fixedLength.readable, putOptions)
        ]);
        object = storedObject;
      } else {
        // Some intermediaries omit Content-Length. Buffer only in that case;
        // the hard 100 MB cap is checked before writing to R2.
        const audioBytes = await request.arrayBuffer();
        streamedBytes = audioBytes.byteLength;
        if (!streamedBytes) return json({ error: 'The upload body is empty.' }, 400);
        if (streamedBytes > MAX_UPLOAD_BYTES) return json({ error: `File is too large. Maximum direct upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` }, 413);
        object = await env.AUDIO.put(key, audioBytes, putOptions);
      }
      if (object.size > MAX_UPLOAD_BYTES) {
        await env.AUDIO.delete(key);
        return json({ error: `File is too large. Maximum direct upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` }, 413);
      }
      const insert = await supabaseRest(env, 'tracks', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          owner_id: user.id, title, artist, album, genre, audio_key: key,
          duration_seconds: duration, file_size: Number(object.size || streamedBytes || length),
          mime_type: storedMime, cover_url: cleanString(url.searchParams.get('cover_url') || '', 1000) || null, status: 'published'
        })
      });
      if (!insert.ok) {
        await env.AUDIO.delete(key);
        const err = (await insert.text()).slice(0, 300);
        throw new Error(`Audio was rolled back because the Supabase track insert failed: ${err}`);
      }
      const rows = await insert.json();
      await writeAudit(env, user, 'track.upload', { track_id: rows?.[0]?.id, title, artist, key, file_size: object.size || length });
      return json({ ok: true, track: rows?.[0] || null, audio_key: key, bytes: object.size || streamedBytes || length }, 201);
    } catch (error) {
      console.error('SONORA upload failed:', error?.message || error);
      if (String(error?.message || error).includes('SONORA_UPLOAD_TOO_LARGE')) return json({ error: `File is too large. Maximum direct upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` }, 413);
      return json({ error: String(error?.message || error).slice(0, 320) }, 500);
    }
  }

  const match = url.pathname.match(/^\/admin\/tracks\/([0-9a-f-]{36})$/i);
  if (match && request.method === 'PATCH') {
    const id = match[1];
    let changes;
    try { changes = await request.json(); } catch { return json({ error: 'Send valid JSON track metadata.' }, 400); }
    const update = {};
    for (const field of ['title', 'artist', 'album', 'genre', 'status']) {
      if (changes[field] !== undefined) update[field] = field === 'status' ? String(changes[field]) : cleanString(changes[field], field === 'genre' ? 60 : field === 'artist' ? 120 : 160);
    }
    if (changes.description !== undefined) update.description = cleanDescription(changes.description, 2000);
    if (update.status && !['draft', 'published', 'removed'].includes(update.status)) return json({ error: 'Invalid track status.' }, 400);
    if (Object.keys(update).length === 0) return json({ error: 'No editable fields supplied.' }, 400);
    if (update.title === '' || update.artist === '') return json({ error: 'Title and artist cannot be empty.' }, 400);
    update.updated_at = new Date().toISOString();
    const response = await supabaseRest(env, `tracks?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(update)
    });
    if (!response.ok) return json({ error: (await response.text()).slice(0, 300) }, 500);
    const rows = await response.json();
    if (!rows.length) return json({ error: 'Track not found.' }, 404);
    await writeAudit(env, user, 'track.update', { track_id: id, fields: Object.keys(update) });
    return json({ ok: true, track: rows[0] });
  }
  if (match && request.method === 'DELETE') {
    const id = match[1];
    const found = await supabaseRest(env, `tracks?id=eq.${encodeURIComponent(id)}&select=id,audio_key,title&limit=1`);
    if (!found.ok) return json({ error: (await found.text()).slice(0, 280) }, 500);
    const rows = await found.json();
    const track = rows[0];
    if (!track) return json({ error: 'Track not found.' }, 404);
    // Hide it first. If the DB delete later fails, listeners still cannot see it.
    const archive = await supabaseRest(env, `tracks?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'removed', updated_at: new Date().toISOString() })
    });
    if (!archive.ok) return json({ error: `Could not archive track: ${(await archive.text()).slice(0, 220)}` }, 500);
    if (track.audio_key && env.AUDIO) await env.AUDIO.delete(track.audio_key);
    const del = await supabaseRest(env, `tracks?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!del.ok) return json({ error: `Audio removed and track hidden, but catalogue row cleanup failed: ${(await del.text()).slice(0, 220)}` }, 500);
    await writeAudit(env, user, 'track.delete', { track_id: id, title: track.title, audio_key: track.audio_key });
    return json({ ok: true, deleted_id: id });
  }
  return json({ error: 'Admin endpoint not found.' }, 404);
}

export default {
  async fetch(request, env) {
    const base = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...base,
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, If-None-Match',
          'Access-Control-Max-Age': '86400'
        }
      });
    }
    const url = new URL(request.url);
    let response;

    if (url.pathname === '/' && request.method === 'GET') {
      response = json({
        service: 'sonora-stream',
        version: VERSION,
        status: 'online',
        routes: ['/health', '/admin/me', '/admin/overview', '/admin/cover', '/admin/upload', '/admin/tracks/:id'],
        note: 'This service streams music through /stream/<audio_key>. The root URL is a status page, not a music player.'
      });
    } else if (url.pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      const [auth, database, r2] = await Promise.all([supabaseHealth(env), publicDatabaseHealth(env), r2Health(env)]);
      const checks = { cloudflare_worker: { ok:true, status:'online', version:VERSION }, supabase_auth: auth, supabase_database: database, r2_storage: r2 };
      const ok = Object.values(checks).every((x) => x.ok);
      response = json({ ok, service: 'sonora-stream', version: VERSION, checks, checked_at: new Date().toISOString() }, ok ? 200 : 503);
    } else if (url.pathname.startsWith('/admin/')) {
      response = await adminRoute(request, env, url);
    } else if (url.pathname.startsWith('/stream/') && (request.method === 'GET' || request.method === 'HEAD')) {
      if (!env.AUDIO) response = json({ error: 'R2 bucket binding AUDIO is missing.' }, 503);
      else {
        let key;
        try { key = decodeURIComponent(url.pathname.slice('/stream/'.length)); } catch { key = ''; }
        const ext = key.split('.').pop().toLowerCase();
        const isLegacyCoverKey = key.startsWith('covers/');
        if (!key || key.includes('..') || key.startsWith('/') || (!AUDIO_TYPES[ext] && !IMAGE_TYPES[ext] && !isLegacyCoverKey)) response = json({ error: 'Invalid media object key.' }, 404);
        else {
          try {
            const head = await env.AUDIO.head(key);
            if (!head) response = json({ error: 'Media object not found.' }, 404);
            else {
              const storedType = head.httpMetadata?.contentType || AUDIO_TYPES[ext] || IMAGE_TYPES[ext] || '';
              if (!AUDIO_TYPES[ext] && !IMAGE_TYPES[ext] && !(isLegacyCoverKey && storedType.startsWith('image/'))) {
                response = json({ error: 'Unsupported media object type.' }, 415);
              } else {
              const headers = new Headers({
                'Content-Type': storedType,
                'Accept-Ranges': 'bytes',
                'ETag': head.httpEtag,
                'Cache-Control': 'public, max-age=86400',
                'X-Content-Type-Options': 'nosniff',
                ...base
              });
              if (request.headers.get('If-None-Match') === head.httpEtag) response = new Response(null, { status: 304, headers });
              else {
                const range = parseRange(request.headers.get('Range'), head.size);
                if (!range) {
                  headers.set('Content-Range', `bytes */${head.size}`);
                  response = new Response(null, { status: 416, headers });
                } else {
                  const length = range.end - range.start + 1;
                  headers.set('Content-Length', String(length));
                  if (range.status === 206) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
                  if (request.method === 'HEAD') response = new Response(null, { status: range.status, headers });
                  else {
                    const object = await env.AUDIO.get(key, range.status === 206 ? { range: { offset: range.start, length } } : undefined);
                    response = object?.body ? new Response(object.body, { status: range.status, headers }) : json({ error: 'Audio object disappeared during streaming.' }, 404, base);
                  }
                }
              }
              }
            }
          } catch (error) {
            console.error('SONORA stream failed:', error?.message || error);
            response = json({ error: 'Audio streaming failed. Check the R2 binding and object key.' }, 502, base);
          }
        }
      }
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      response = json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, HEAD, POST, PATCH, DELETE, OPTIONS' });
    } else {
      response = json({ error: 'Route not found.', available: ['/', '/health', '/stream/<audio_key>'] }, 404);
    }

    return withCors(response, base);
  }
};
