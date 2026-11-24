/* SONORA 3.28 — encrypted offline downloads.
 *
 * Songs are fetched once, split into 1 MiB chunks and encrypted with AES-GCM-256 before they are written to
 * IndexedDB. The key is generated on the device as NON-EXTRACTABLE (the browser will not hand its bytes to any
 * script), so the stored data is unreadable outside SONORA: it is not a playable file in Downloads / Files /
 * gallery and cannot be copied to another device or app. Each chunk has its own random IV and is bound to its
 * track id + position (AAD), so chunks cannot be swapped or reordered.
 * Playback decrypts into memory (a blob: URL that is revoked when the track changes) — nothing plain is written to disk.
 */
(() => {
'use strict';
const DB_NAME = 'sonora-offline', DB_VER = 1, CHUNK = 1024 * 1024;
const enc = new TextEncoder();
const supported = Boolean(window.indexedDB && window.crypto?.subtle && window.isSecureContext !== false);
let dbPromise = null, keyPromise = null;
const ids = new Set();          // ids of fully downloaded tracks (kept in memory for instant UI checks)
const busy = new Map();         // id -> { pct, abort }
const listeners = new Set();
let readyResolve; const ready = new Promise((r) => { readyResolve = r; });

const emit = (id) => listeners.forEach((fn) => { try { fn(id); } catch { /* listener error */ } });
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Storage transaction aborted')); });

function db() {
  if (!supported) return Promise.reject(new Error('Offline storage is not supported in this browser.'));
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const open = indexedDB.open(DB_NAME, DB_VER);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains('keys')) d.createObjectStore('keys');
      if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks');
    };
    open.onsuccess = () => res(open.result);
    open.onerror = () => { dbPromise = null; rej(open.error); };
  });
  return dbPromise;
}
async function getKey() {
  if (!keyPromise) keyPromise = (async () => {
    const d = await db();
    let key = await wrap(d.transaction('keys').objectStore('keys').get('device'));
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); // extractable = false
      await done((() => { const tx = d.transaction('keys', 'readwrite'); tx.objectStore('keys').put(key, 'device'); return tx; })());
    }
    return key;
  })().catch((e) => { keyPromise = null; throw e; });
  return keyPromise;
}
const aad = (id, i) => enc.encode(`${id}:${i}`);
async function sealChunk(key, id, i, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id, i) }, key, plain);
  return { iv, data };
}

async function refreshIds() {
  try {
    const d = await db();
    const all = await wrap(d.transaction('tracks').objectStore('tracks').getAll());
    ids.clear(); all.filter((r) => r.complete).forEach((r) => ids.add(r.id));
  } catch { /* unsupported / blocked */ }
  readyResolve();
}

async function deleteChunks(d, id, count) {
  const tx = d.transaction('chunks', 'readwrite'); const st = tx.objectStore('chunks');
  for (let i = 0; i < count; i++) st.delete(`${id}:${i}`);
  await done(tx);
}

async function save(track, { signal } = {}) {
  if (!supported) throw new Error('This browser cannot store songs offline.');
  const id = track.id;
  if (ids.has(id) || busy.has(id)) return;
  if (!track.audioUrl) throw new Error('This track has no audio file to download.');
  if (navigator.onLine === false) throw new Error('You are offline. Connect to download this song.');
  const ctl = new AbortController(); const state = { pct: 0, abort: () => ctl.abort() }; busy.set(id, state); emit(id);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  const d = await db(); let written = 0;
  try {
    navigator.storage?.persist?.().catch(() => {});
    const key = await getKey();
    const res = await fetch(track.audioUrl, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`Download failed (${res.status}).`);
    const total = Number(res.headers.get('Content-Length')) || track.fileSize || 0;
    const mime = (res.headers.get('Content-Type') || 'audio/mpeg').split(';')[0];
    let pending = new Uint8Array(0), received = 0, idx = 0;
    const flush = async (bytes) => {
      const sealed = await sealChunk(key, id, idx, bytes);
      const tx = d.transaction('chunks', 'readwrite'); tx.objectStore('chunks').put(sealed, `${id}:${idx}`); await done(tx);
      idx++; written = idx;
    };
    const push = async (value) => {
      received += value.length;
      const merged = new Uint8Array(pending.length + value.length); merged.set(pending); merged.set(value, pending.length); pending = merged;
      while (pending.length >= CHUNK) { await flush(pending.slice(0, CHUNK)); pending = pending.slice(CHUNK); }
      state.pct = total ? Math.min(99, Math.round((received / total) * 100)) : 0; emit(id);
    };
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      for (;;) { const { done: end, value } = await reader.read(); if (end) break; await push(value); }
    } else await push(new Uint8Array(await res.arrayBuffer()));
    if (pending.length) await flush(pending);
    if (!received) throw new Error('The downloaded file was empty.');
    // cover art is public; store it so lists look right with no connection
    let cover = null;
    if (track.coverUrl) { try { const c = await fetch(track.coverUrl, { signal: ctl.signal }); if (c.ok) cover = await c.blob(); } catch { /* cover is optional */ } }
    const rec = { id, title: track.title, artist: track.artist, album: track.album, genre: track.genre, description: track.description,
      duration: track.duration, createdAt: track.createdAt, mime, size: received, chunks: written, cover, ts: Date.now(), complete: true };
    const tx = d.transaction('tracks', 'readwrite'); tx.objectStore('tracks').put(rec); await done(tx);
    ids.add(id);
  } catch (e) {
    try { await deleteChunks(d, id, written + 1); } catch { /* best effort cleanup */ }
    if (e?.name === 'AbortError') throw Object.assign(new Error('Download cancelled.'), { cancelled: true });
    if (e?.name === 'QuotaExceededError') throw new Error('Not enough free storage on this device.');
    throw e;
  } finally { busy.delete(id); emit(id); }
}

async function remove(id) {
  busy.get(id)?.abort();
  const d = await db();
  const rec = await wrap(d.transaction('tracks').objectStore('tracks').get(id));
  if (rec) await deleteChunks(d, id, rec.chunks || 0);
  const tx = d.transaction('tracks', 'readwrite'); tx.objectStore('tracks').delete(id); await done(tx);
  ids.delete(id); emit(id);
}

/* Decrypts a stored song into a blob: URL. Caller must revoke it (URL.revokeObjectURL) when done. */
async function objectUrl(id) {
  const d = await db(); const key = await getKey();
  const rec = await wrap(d.transaction('tracks').objectStore('tracks').get(id));
  if (!rec?.complete) throw new Error('This song is not downloaded.');
  const parts = [];
  for (let i = 0; i < rec.chunks; i++) {
    const c = await wrap(d.transaction('chunks').objectStore('chunks').get(`${id}:${i}`));
    if (!c) throw new Error('A part of this download is missing. Remove it and download again.');
    parts.push(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.iv, additionalData: aad(id, i) }, key, c.data));
  }
  return URL.createObjectURL(new Blob(parts, { type: rec.mime || 'audio/mpeg' }));
}

/* Metadata of everything downloaded — used to run the app with no connection. Cover blobs become object URLs. */
async function list() {
  await ready;
  try {
    const d = await db();
    const all = await wrap(d.transaction('tracks').objectStore('tracks').getAll());
    return all.filter((r) => r.complete).sort((a, b) => b.ts - a.ts).map((r) => ({ ...r, coverUrl: r.cover ? URL.createObjectURL(r.cover) : '' }));
  } catch { return []; }
}
async function usage() { const l = await list(); l.forEach((r) => r.coverUrl && URL.revokeObjectURL(r.coverUrl)); return { count: l.length, bytes: l.reduce((n, r) => n + (r.size || 0), 0) }; }
async function removeAll() { for (const id of [...ids]) await remove(id); }

window.SonoraOffline = {
  supported, ready, has: (id) => ids.has(id), progress: (id) => (busy.has(id) ? busy.get(id).pct : null), isBusy: (id) => busy.has(id),
  save, remove, removeAll, objectUrl, list, usage, cancel: (id) => busy.get(id)?.abort(),
  onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
};
if (supported) refreshIds(); else readyResolve();
})();
