/* SONORA 3.25 — motion layer + track menu.
 * Pure progressive enhancement: if this file fails to load, the app still works.
 * Honors Settings > Motion (html[data-motion] = full | reduced | off).
 * Only transform/opacity are animated (GPU friendly), except the title marquee.
 */
(() => {
'use strict';
const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const mode = () => root.dataset.motion || 'full';
const isFull = () => mode() === 'full';
const canAnimate = () => mode() !== 'off' && typeof Element.prototype.animate === 'function';
const EASE = 'cubic-bezier(.2,.85,.2,1)';
const vibrate = (ms) => { try { if (isFull() && navigator.vibrate) navigator.vibrate(ms); } catch { /* unsupported */ } };

/* ---------------- page transitions, stagger, scroll reveal ---------------- */
let revealObserver = null;
function routeEnter(view) {
  if (!view || !canAnimate()) return;
  view.classList.remove('view-enter'); void view.offsetWidth; view.classList.add('view-enter');
  setTimeout(() => view.classList.remove('view-enter'), 700);
  if (!isFull()) return;
  const items = [...view.querySelectorAll('.card, .row, .sec-head, .library-hero, .collection-hero, .sk-card')];
  let n = 0; const below = [];
  items.forEach((el) => {
    if (el.getBoundingClientRect().top < innerHeight) { el.style.setProperty('--i', Math.min(n++, 14)); el.classList.add('stag'); }
    else below.push(el);
  });
  setTimeout(() => items.forEach((el) => el.classList.remove('stag')), 1100);
  if (!below.length) return;
  if (!('IntersectionObserver' in window)) return;
  revealObserver?.disconnect();
  const show = (el) => { el.classList.add('in'); setTimeout(() => el.classList.remove('reveal', 'in'), 700); };
  revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { show(en.target); revealObserver.unobserve(en.target); } });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
  below.forEach((el) => { el.classList.add('reveal'); revealObserver.observe(el); });
  // Failsafe: never leave content hidden.
  setTimeout(() => below.forEach((el) => { if (el.classList.contains('reveal')) show(el); }), 3000);
}

/* ---------------- mini player <-> full player (shared cover) ---------------- */
function openPlayer(panel, srcCover, dstCover) {
  if (!canAnimate() || !panel) return;
  const inner = panel.querySelector('.now-playing-panel');
  const full = isFull();
  const dur = full ? 460 : 180;
  panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: full ? 260 : 160, easing: 'ease-out' });
  let flew = false;
  if (full && srcCover && dstCover) {
    const a = srcCover.getBoundingClientRect(), b = dstCover.getBoundingClientRect();
    if (a.width > 4 && b.width > 4 && a.bottom > 0 && a.top < innerHeight) {
      const dx = a.left - b.left, dy = a.top - b.top, sx = a.width / b.width, sy = a.height / b.height;
      const radius = getComputedStyle(dstCover).borderRadius;
      dstCover.animate([
        { transformOrigin: 'top left', transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})`, borderRadius: '10px' },
        { transformOrigin: 'top left', transform: 'translate(0,0) scale(1,1)', borderRadius: radius }
      ], { duration: dur, easing: EASE });
      flew = true;
    }
  }
  if (inner && !flew) inner.animate([{ transform: 'translateY(34px) scale(.985)', opacity: .4 }, { transform: 'none', opacity: 1 }], { duration: dur, easing: EASE });
  if (inner && full) {
    [...inner.children].forEach((child, i) => {
      if (child.classList.contains('expanded-art-wrap')) return;
      child.animate([{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 120 + i * 45, easing: EASE, fill: 'backwards' });
    });
  }
}
function closePlayer(panel, srcCover, dstCover, finish) {
  if (!canAnimate() || !panel || panel._closing) { finish(); return; }
  panel._closing = true;
  const inner = panel.querySelector('.now-playing-panel');
  const full = isFull();
  const anims = [];
  const done = () => { if (!panel._closing) return; panel._closing = false; finish(); anims.forEach((a) => { try { a.cancel(); } catch { /* ignore */ } }); };
  anims.push(panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: full ? 300 : 140, easing: 'ease-in', fill: 'forwards' }));
  let flew = false;
  if (full && srcCover && dstCover) {
    const a = srcCover.getBoundingClientRect(), b = dstCover.getBoundingClientRect();
    if (a.width > 4 && b.width > 4 && a.bottom > 0 && a.top < innerHeight) {
      anims.push(dstCover.animate([
        { transformOrigin: 'top left', transform: 'translate(0,0) scale(1,1)' },
        { transformOrigin: 'top left', transform: `translate(${a.left - b.left}px,${a.top - b.top}px) scale(${a.width / b.width},${a.height / b.height})`, borderRadius: '10px' }
      ], { duration: 300, easing: EASE, fill: 'forwards' }));
      flew = true;
    }
  }
  if (inner && !flew && full) anims.push(inner.animate([{ transform: 'none' }, { transform: 'translateY(40px) scale(.985)' }], { duration: 300, easing: 'ease-in', fill: 'forwards' }));
  anims[0].onfinish = done;
  setTimeout(done, 420); // failsafe
}

/* ---------------- adaptive ambient background (cover colours) ---------------- */
let ambient = null, paletteToken = 0;
const paletteCache = new Map();
function ensureAmbient() {
  if (ambient) return ambient;
  const overlay = $('nowPlayingExpanded'); if (!overlay) return null;
  ambient = document.createElement('div');
  ambient.className = 'np-ambient'; ambient.setAttribute('aria-hidden', 'true');
  ambient.innerHTML = '<i class="amb a1"></i><i class="amb a2"></i><i class="amb a3"></i>';
  overlay.insertBefore(ambient, overlay.firstChild);
  return ambient;
}
function setPalette(c1, c2, c3) {
  const el = ensureAmbient(); if (!el) return;
  el.style.setProperty('--amb1', c1); el.style.setProperty('--amb2', c2); el.style.setProperty('--amb3', c3);
}
function hueFallback() {
  const cv = $('expandedCover'); const h1 = parseFloat(cv?.style.getPropertyValue('--h1')); const h2 = parseFloat(cv?.style.getPropertyValue('--h2'));
  const a = Number.isFinite(h1) ? h1 : 270, b = Number.isFinite(h2) ? h2 : (a + 60) % 360;
  return [`hsl(${a} 75% 52%)`, `hsl(${b} 80% 56%)`, `hsl(${(a + 130) % 360} 70% 48%)`];
}
function extractPalette(url) {
  return new Promise((resolve) => {
    if (paletteCache.has(url)) { resolve(paletteCache.get(url)); return; }
    const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
    img.onload = () => {
      try {
        const S = 24, cv = document.createElement('canvas'); cv.width = cv.height = S;
        const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, S, S);
        const px = ctx.getImageData(0, 0, S, S).data; const bins = new Map();
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i], g = px[i + 1], b = px[i + 2], max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max, val = max / 255;
          if (sat < .22 || val < .22) continue;
          const key = `${r >> 5}-${g >> 5}-${b >> 5}`; const w = sat * val;
          const e = bins.get(key) || { r: 0, g: 0, b: 0, w: 0 }; e.r += r * w; e.g += g * w; e.b += b * w; e.w += w; bins.set(key, e);
        }
        const top = [...bins.values()].sort((a, b) => b.w - a.w).slice(0, 3).map((e) => `rgb(${Math.round(e.r / e.w)} ${Math.round(e.g / e.w)} ${Math.round(e.b / e.w)})`);
        const out = top.length ? [top[0], top[1] || top[0], top[2] || top[1] || top[0]] : null;
        paletteCache.set(url, out); resolve(out);
      } catch { paletteCache.set(url, null); resolve(null); } // CORS-tainted canvas -> fall back to hue palette
    };
    img.onerror = () => { paletteCache.set(url, null); resolve(null); };
    img.src = url;
  });
}

/* ---------------- title marquee (long titles scroll like Spotify) ---------------- */
function marquee(el) {
  if (!el) return;
  try { el._mq?.cancel(); } catch { /* ignore */ }
  el._mq = null; el.style.textIndent = ''; el.style.textOverflow = '';
  if (!isFull()) return;
  requestAnimationFrame(() => {
    const over = el.scrollWidth - el.clientWidth;
    if (over < 8) return;
    el.style.textOverflow = 'clip';
    const end = -(over + 16);
    el._mq = el.animate([{ textIndent: '0px', offset: 0 }, { textIndent: '0px', offset: .2 }, { textIndent: `${end}px`, offset: .8 }, { textIndent: `${end}px`, offset: 1 }],
      { duration: Math.max(7000, over * 60 + 4000), iterations: Infinity, easing: 'linear' });
  });
}

/* ---------------- track change ---------------- */
let lastTrackId = null;
function trackChanged(t) {
  if (!t) return;
  const changed = lastTrackId !== null && lastTrackId !== t.id; lastTrackId = t.id;
  const token = ++paletteToken;
  setPalette(...hueFallback());
  if (t.coverUrl) extractPalette(t.coverUrl).then((p) => { if (p && token === paletteToken) setPalette(...p); });
  if (changed && canAnimate()) {
    ['npTitle', 'npArtist', 'expandedTitle', 'expandedArtist', 'expandedAlbum'].forEach((id, i) => {
      $(id)?.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 360, delay: i % 2 * 50, easing: EASE, fill: 'backwards' });
    });
    ['npCover', 'expandedCover'].forEach((id) => {
      $(id)?.animate([{ opacity: .15, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 480, easing: EASE, fill: 'backwards' });
    });
  }
  setTimeout(() => { marquee($('npTitle')); marquee($('expandedTitle')); }, 120);
}

/* ---------------- micro-interactions ---------------- */
function pop(el) {
  if (!el || !canAnimate()) return;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  setTimeout(() => el.classList.remove('pop'), 480);
}
function burst(el) {
  if (!isFull()) return;
  const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const layer = document.createElement('div'); layer.className = 'burst-layer'; layer.setAttribute('aria-hidden', 'true');
  layer.style.left = `${cx}px`; layer.style.top = `${cy}px`; document.body.appendChild(layer);
  const N = 9;
  for (let i = 0; i < N; i++) {
    const p = document.createElement('span'); p.className = 'burst-p'; p.textContent = i % 3 === 0 ? '♥' : '';
    if (i % 3 !== 0) p.classList.add('dot');
    layer.appendChild(p);
    const ang = (Math.PI * 2 * i) / N + Math.random() * .5, dist = 26 + Math.random() * 20;
    p.animate([{ transform: 'translate(-50%,-50%) scale(.4)', opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px),calc(-50% + ${Math.sin(ang) * dist}px)) scale(${i % 3 === 0 ? 1.1 : .8})`, opacity: 0 }], { duration: 560 + Math.random() * 160, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' });
  }
  const ring = document.createElement('span'); ring.className = 'burst-ring'; layer.appendChild(ring);
  ring.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: .7 }, { transform: 'translate(-50%,-50%) scale(1.7)', opacity: 0 }], { duration: 480, easing: 'ease-out', fill: 'forwards' });
  setTimeout(() => layer.remove(), 900);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-act="like"], #npLike, #expandedLike');
  if (!b || !canAnimate()) return;
  if ((b.id === 'npLike' || b.id === 'expandedLike') && $('npTitle')?.textContent === 'Nothing playing') return;
  if (!b.classList.contains('on')) { burst(b); vibrate(12); }
  pop(b);
}, true);
document.addEventListener('click', (e) => { if (e.target.closest?.('#play, #expandedPlay, #next, #prev')) vibrate(8); }, true);

/* 3D tilt on cards (mouse only) */
const finePointer = matchMedia('(hover:hover) and (pointer:fine)');
let tiltEl = null, tiltRaf = 0;
function tiltReset() { if (tiltEl) { tiltEl.classList.remove('tilt'); tiltEl.style.removeProperty('--rx'); tiltEl.style.removeProperty('--ry'); tiltEl = null; } }
document.addEventListener('pointermove', (e) => {
  if (!isFull() || !finePointer.matches || e.pointerType !== 'mouse') { if (tiltEl) tiltReset(); return; }
  const card = e.target.closest?.('#view .card');
  if (!card) { tiltReset(); return; }
  if (tiltEl && tiltEl !== card) tiltReset();
  cancelAnimationFrame(tiltRaf);
  tiltRaf = requestAnimationFrame(() => {
    const r = card.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    card.style.setProperty('--rx', `${((.5 - py) * 8).toFixed(2)}deg`); card.style.setProperty('--ry', `${((px - .5) * 10).toFixed(2)}deg`);
    card.classList.add('tilt'); tiltEl = card;
  });
}, { passive: true });
document.addEventListener('pointerleave', tiltReset);
window.addEventListener('blur', tiltReset);

/* ---------------- sliding active-nav pill ---------------- */
function placePill() {
  const nav = document.querySelector('.side .nav, .nav'); if (!nav) return;
  let pill = nav.querySelector('.nav-pill');
  const cur = nav.querySelector('a[aria-current="page"]');
  if (!cur || !cur.offsetWidth) { pill?.classList.remove('on'); nav.classList.remove('has-pill'); return; }
  if (!pill) { pill = document.createElement('span'); pill.className = 'nav-pill'; pill.setAttribute('aria-hidden', 'true'); nav.insertBefore(pill, nav.firstChild); }
  if (getComputedStyle(nav).position === 'static') nav.style.position = 'relative';
  const first = !pill.classList.contains('on');
  if (first) pill.style.transition = 'none';
  pill.style.width = `${cur.offsetWidth}px`; pill.style.height = `${cur.offsetHeight}px`;
  pill.style.transform = `translate(${cur.offsetLeft}px,${cur.offsetTop}px)`;
  pill.classList.add('on'); nav.classList.add('has-pill');
  if (first) { void pill.offsetWidth; pill.style.transition = ''; }
}
new MutationObserver(() => requestAnimationFrame(placePill)).observe(document.body, { attributes: true, attributeFilter: ['aria-current'], subtree: true });
window.addEventListener('resize', () => requestAnimationFrame(placePill));
window.addEventListener('load', () => setTimeout(placePill, 60));

/* ---------------- track menu (right-click / long-press / Menu key) ---------------- */
let menu = null, backdrop = null, menuOrigin = null, openedAt = 0, suppressClickUntil = 0;
const ICON = {
  queue: '<path d="M3 6h12M3 12h12M3 18h7M18 14v6M15 17h6"/>',
  list: '<path d="M4 6h12M4 12h12M4 18h8M19 8v8a2 2 0 1 1-2-2"/>',
  heart: '<path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  share: '<path d="M12 4v12M7 9l5-5 5 5M5 14v5h14v-5"/>'
};
const icon = (n) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[n]}</svg>`;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function closeMenu(returnFocus = true) {
  if (!menu) return;
  const m = menu, bd = backdrop, origin = menuOrigin; menu = backdrop = menuOrigin = null;
  layerClosed('menu');
  const remove = () => { m.remove(); bd?.remove(); };
  if (canAnimate()) { m.classList.add('closing'); bd?.classList.add('closing'); setTimeout(remove, 150); } else remove();
  if (returnFocus && origin?.isConnected && origin.focus) origin.focus({ preventScroll: true });
}
function openMenu(trackId, x, y, origin, sheet) {
  const App = window.SonoraApp; const t = App?.trackById(trackId); if (!t) return;
  closeMenu(false);
  const liked = App.isLiked(trackId); const album = App.albumHash(t);
  const items = [
    ['queue', 'Add to queue', () => App.addToQueue(trackId)],
    ['list', 'Add to playlist…', () => App.addToPlaylist(trackId)],
    ['heart', liked ? 'Remove from liked songs' : 'Add to liked songs', () => App.toggleLike(trackId)],
    ['user', 'Go to artist', () => { location.hash = App.artistHash(t); }],
    ...(album ? [['disc', 'Go to album', () => { location.hash = album; }]] : []),
    ['share', navigator.share ? 'Share' : 'Copy song name', async () => {
      const text = `${t.title} — ${t.artist}`;
      try { if (navigator.share) await navigator.share({ title: t.title, text }); else { await navigator.clipboard.writeText(text); App.notify('Copied to clipboard.'); } } catch { /* cancelled */ }
    }]
  ];
  backdrop = document.createElement('div'); backdrop.className = 'ctx-backdrop' + (sheet ? ' sheet' : '');
  menu = document.createElement('div'); menu.className = 'ctx-menu' + (sheet ? ' sheet' : ''); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Options for ${t.title}`);
  menu.innerHTML = `<div class="ctx-head"><strong>${esc(t.title)}</strong><span>${esc(t.artist)}</span></div>` +
    items.map(([ic, label], i) => `<button type="button" role="menuitem" class="ctx-item" data-i="${i}">${icon(ic)}<span>${esc(label)}</span></button>`).join('');
  document.body.append(backdrop, menu); menuOrigin = origin; openedAt = Date.now();
  layerOpen('menu', () => closeMenu(false));
  if (!sheet) {
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.max(8, Math.min(x, innerWidth - w - 8)), top = Math.max(8, Math.min(y, innerHeight - h - 8));
    menu.style.left = `${left}px`; menu.style.top = `${top}px`;
    menu.style.transformOrigin = `${x - left}px ${y - top}px`;
  }
  menu.querySelector('.ctx-item')?.focus({ preventScroll: true });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.ctx-item'); if (!b) return; const fn = items[Number(b.dataset.i)][2];
    closeMenu(false); fn();
  });
  backdrop.addEventListener('pointerdown', (e) => { e.preventDefault(); closeMenu(); });
  backdrop.addEventListener('contextmenu', (e) => { e.preventDefault(); closeMenu(); });
}
document.addEventListener('keydown', (e) => {
  if (!menu) return;
  const btns = [...menu.querySelectorAll('.ctx-item')]; const i = btns.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); btns[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1].focus(); }
  else if (e.key === 'Tab') { e.preventDefault(); closeMenu(); }
}, true);
window.addEventListener('scroll', () => closeMenu(false), { passive: true, capture: true });
window.addEventListener('resize', () => closeMenu(false));
window.addEventListener('hashchange', () => closeMenu(false));

const targetOf = (e) => e.target.closest?.('#view .row[data-id], #view .card[data-id]');
const wantsSheet = (pointerType) => pointerType === 'touch' || pointerType === 'pen' || matchMedia('(max-width:700px)').matches;
document.addEventListener('contextmenu', (e) => {
  const el = targetOf(e); if (!el) return;
  e.preventDefault();
  if (Date.now() - openedAt < 800) return; // long-press already opened it
  let x = e.clientX, y = e.clientY;
  if (!x && !y) { const r = el.getBoundingClientRect(); x = r.left + Math.min(r.width / 2, 200); y = r.top + r.height / 2; }
  openMenu(el.dataset.id, x, y, el, wantsSheet(e.pointerType));
});
/* long-press for touch / pen (iOS Safari has no contextmenu event) */
let lp = null;
const lpCancel = () => { if (lp) { clearTimeout(lp.timer); lp = null; } };
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || e.button > 0) return;
  const el = targetOf(e); if (!el) return;
  lpCancel();
  lp = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
    const at = lp; lp = null; if (!at) return;
    suppressClickUntil = Date.now() + 700; vibrate(15);
    openMenu(el.dataset.id, at.x, at.y, el, true);
  }, 480) };
}, { passive: true });
document.addEventListener('pointermove', (e) => { if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) lpCancel(); }, { passive: true });
['pointerup', 'pointercancel', 'dragstart'].forEach((t) => document.addEventListener(t, lpCancel, { passive: true }));
document.addEventListener('click', (e) => { if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); } }, true);


/* =====================================================================
 * 3.27 — BACK NAVIGATION (phone), LOCK-SCREEN PLAYER, NOTIFICATIONS
 * ===================================================================== */
const App = () => window.SonoraApp;
const lsGet = (k, f) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? f; } catch { return f; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full / private mode */ } };

/* ---------- history layers: system Back / swipe-back closes player, dialogs, menus first ---------- */
const layers = [];
let cleaning = false;
function layerOpen(name, close) {
  if (layers.some((l) => l.name === name)) return;
  try { history.pushState({ sonoraLayer: name }, '', location.href); } catch { return; }
  layers.push({ name, close });
}
function layerClosed(name) {
  const i = layers.findIndex((l) => l.name === name); if (i < 0) return; // already closed by Back
  layers.splice(i, 1);
  setTimeout(() => { // drop the history entry we added, unless something else took over meanwhile
    if (history.state?.sonoraLayer === name && !layers.some((l) => l.name === name)) { cleaning = true; history.back(); setTimeout(() => { cleaning = false; }, 600); }
  }, 0);
}
function closeAllLayers() { while (layers.length) { const l = layers.pop(); try { l.close(); } catch { /* ignore */ } } }
window.addEventListener('popstate', (e) => {
  if (cleaning) { cleaning = false; return; }
  if (layers.length) { const l = layers.pop(); try { l.close(); } catch { /* ignore */ } return; }
  if (e.state?.sonoraLayer) history.back(); // landed on a stale overlay entry: skip it
});
(() => {
  const player = $('nowPlayingExpanded');
  if (player) new MutationObserver(() => {
    const open = !player.classList.contains('hidden');
    if (open) layerOpen('player', () => $('closeNowPlaying')?.click()); else layerClosed('player');
  }).observe(player, { attributes: true, attributeFilter: ['class'] });
  const dlg = $('dlg');
  if (dlg) new MutationObserver(() => { if (dlg.open) layerOpen('dialog', () => dlg.close()); else layerClosed('dialog'); }).observe(dlg, { attributes: true, attributeFilter: ['open'] });
})();

/* ---------- back button + scroll restore ---------- */
const ROOT_ROUTES = new Set(['', 'home', 'search', 'liked', 'playlists', 'albums']);
const PARENT = { album: '#/albums', playlist: '#/playlists', artist: '#/home' };
const routeName = () => String(location.hash || '').replace(/^#\/?/, '').split('/')[0].toLowerCase();
const hashOf = (u) => { try { return new URL(u).hash || '#/home'; } catch { return '#/home'; } };
const navStack = [location.hash || '#/home'];
const scrollMap = {};
function updateBackBtn() { const b = $('backBtn'); if (b) b.classList.toggle('hidden', ROOT_ROUTES.has(routeName())); }
let curHash = location.hash || '#/home';
window.addEventListener('scroll', () => { scrollMap[curHash] = window.scrollY; }, { passive: true }); // the app resets scroll before our hashchange runs, so remember it as the user scrolls
window.addEventListener('hashchange', (e) => {
  const to = hashOf(e.newURL); curHash = to;
  const isBack = navStack.length > 1 && navStack[navStack.length - 2] === to;
  if (isBack) { navStack.pop(); const y = scrollMap[to]; if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y)); }
  else navStack.push(to);
  if (navStack.length > 80) navStack.splice(0, 40);
  closeAllLayers(); updateBackBtn();
});
$('backBtn')?.addEventListener('click', () => {
  if (layers.length) { history.back(); return; }
  if (navStack.length > 1) history.back(); else location.hash = PARENT[routeName()] || '#/home';
});
updateBackBtn();

/* ---------- lock-screen / notification-shade player (Spotify / JioSaavn / Wynk style) ---------- */
const artCache = new Map();
function artworkFor(t) {
  if (!t) return [];
  if (t.coverUrl) return [96, 128, 192, 256, 384, 512].map((s) => ({ src: t.coverUrl, sizes: `${s}x${s}` }));
  if (artCache.has(t.id)) return artCache.get(t.id);
  let out = [];
  try {
    const cv = document.createElement('canvas'); cv.width = cv.height = 512; const c = cv.getContext('2d');
    const st = $('npCover')?.style;
    const h1 = parseFloat(st?.getPropertyValue('--h1')), h2 = parseFloat(st?.getPropertyValue('--h2'));
    const a = Number.isFinite(h1) ? h1 : 270, b = Number.isFinite(h2) ? h2 : (a + 60) % 360;
    const g = c.createLinearGradient(0, 0, 512, 512); g.addColorStop(0, `hsl(${a} 72% 52%)`); g.addColorStop(1, `hsl(${b} 78% 36%)`);
    c.fillStyle = g; c.fillRect(0, 0, 512, 512);
    c.strokeStyle = 'rgba(255,255,255,.22)'; c.lineWidth = 6; c.beginPath(); c.arc(256, 256, 190, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 3; c.beginPath(); c.arc(256, 256, 232, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#fff'; c.font = '800 250px system-ui,-apple-system,Segoe UI,Roboto,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText((String(t.title || 'S').trim()[0] || 'S').toUpperCase(), 256, 270);
    out = [{ src: cv.toDataURL('image/png'), sizes: '512x512', type: 'image/png' }];
  } catch { out = []; }
  artCache.set(t.id, out); if (artCache.size > 40) artCache.delete(artCache.keys().next().value);
  return out;
}
(() => {
  const audio = $('audio'); if (!audio || !('mediaSession' in navigator)) return;
  const push = () => {
    const ms = navigator.mediaSession; if (!ms.setPositionState) return;
    const d = audio.duration; if (!Number.isFinite(d) || d <= 0) return;
    try { ms.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(Math.max(audio.currentTime || 0, 0), d) }); } catch { /* unsupported combination */ }
  };
  ['loadedmetadata', 'durationchange', 'play', 'pause', 'seeked', 'ratechange'].forEach((ev) => audio.addEventListener(ev, push));
  let last = 0; audio.addEventListener('timeupdate', () => { const n = Date.now(); if (n - last > 5000) { last = n; push(); } });
})();

/* ---------- browser / status-bar colour follows the theme ---------- */
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]'); if (!meta) return;
  meta.setAttribute('content', root.dataset.theme === 'light' ? '#efeafb' : '#0b0914');
}
new MutationObserver(syncThemeColor).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
syncThemeColor();

/* ---------- notifications: bell + centre, phone notifications, new-release alerts ---------- */
const NK = 'sonora-notifs', PK = 'sonora-notif-prefs', BK = 'sonora-notif-seen';
let notifs = lsGet(NK, []); if (!Array.isArray(notifs)) notifs = [];
let prefs = { release: true, sleep: true, quiet: false, ...lsGet(PK, {}) };
const supportsNotif = () => 'Notification' in window;
const perm = () => (supportsNotif() ? Notification.permission : 'unsupported');
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const quietNow = () => { if (!prefs.quiet) return false; const h = new Date().getHours(); return h >= 22 || h < 8; };
const prefOn = (k) => (k === 'quiet' ? !!prefs.quiet : prefs[k] !== false);
const unread = () => notifs.filter((n) => !n.read).length;
function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'Just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function updateBadge() {
  const n = unread(), el = $('bellBadge');
  if (el) { el.textContent = n > 9 ? '9+' : String(n); el.classList.toggle('hidden', n === 0); }
  const bell = $('bellBtn'); if (bell) bell.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  try { if (n) navigator.setAppBadge?.(n); else navigator.clearAppBadge?.(); } catch { /* badge unsupported */ }
}
async function showSystem(n) {
  if (perm() !== 'granted') return false;
  const opts = { body: n.body, icon: 'public/icons/icon-192.png', badge: 'public/icons/icon-192.png', tag: `sonora-${n.type}`, renotify: true, data: { url: n.url || '#/home' } };
  if (n.image && /^https:/.test(n.image)) opts.image = n.image;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) { await reg.showNotification(n.title, opts); return true; }
    new Notification(n.title, opts); return true;
  } catch { return false; }
}
function addNotification(n) {
  const item = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ts: Date.now(), read: false, ...n };
  notifs.unshift(item); notifs = notifs.slice(0, 50); lsSet(NK, notifs); updateBadge();
  if (panel) renderPanel();
  return item;
}
function notifyEvent(type, title, body, opts = {}) {
  if (prefs[type] === false) return;
  const item = addNotification({ type, title, body, url: opts.url || '#/home', image: opts.image || '' });
  if (document.hidden) { if (!quietNow()) showSystem(item); }
  else if (opts.toast !== false) App()?.notify(`${title}: ${body}`);
}
async function enableNotifications() {
  if (!supportsNotif()) { App()?.notify('This browser does not support notifications.'); return; }
  if (isIOS() && !isStandalone()) { App()?.notify('On iPhone: tap Share › Add to Home Screen, open SONORA from there, then turn notifications on.'); return; }
  let res = perm();
  if (res === 'default') { try { res = await Notification.requestPermission(); } catch { res = perm(); } }
  if (res === 'granted') {
    const t = addNotification({ type: 'system', title: 'Notifications are on', body: 'You will get new releases and sleep-timer alerts here and on your phone.', url: '#/home', read: true });
    updateBadge(); showSystem(t);
  } else if (res === 'denied') App()?.notify('Notifications are blocked. Allow them for SONORA in your browser or phone settings.');
  refreshNotifUI();
}

/* bell panel (popover on desktop, bottom sheet on phones) */
let panel = null, panelBackdrop = null;
function renderPanel() {
  if (!panel) return;
  const ask = supportsNotif() && perm() === 'default';
  panel.innerHTML = `<header class="np-head"><h2>Notifications</h2><div class="np-actions">${unread() ? '<button class="link" type="button" data-n="readall">Mark all read</button>' : ''}<button class="icon-btn" type="button" data-n="close" aria-label="Close notifications"><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button></div></header>
  ${ask ? '<div class="np-ask"><div><strong>Get alerts on your phone</strong><span>New releases and sleep-timer alerts, even when SONORA is in the background.</span></div><button class="btn btn-primary" type="button" data-n="enable">Turn on</button></div>' : ''}
  ${notifs.length ? `<ul class="np-list">${notifs.map((n) => `<li><button type="button" class="np-item${n.read ? '' : ' unread'}" data-n="open" data-id="${n.id}"><span class="np-dot" aria-hidden="true"></span><span class="np-txt"><strong>${esc(n.title)}</strong><span>${esc(n.body)}</span></span><time>${ago(n.ts)}</time></button></li>`).join('')}</ul>` : '<div class="np-empty"><svg class="ic" aria-hidden="true"><use href="#i-bell"/></svg><strong>You’re all caught up</strong><span>New releases and alerts will show up here.</span></div>'}
  <footer class="np-foot">${notifs.length ? '<button class="link" type="button" data-n="clear">Clear all</button>' : '<span></span>'}<a class="link" href="#/settings" data-n="settings">Notification settings</a></footer>`;
}
function openPanel() {
  if (panel) { closePanel(); return; }
  const sheet = matchMedia('(max-width:700px)').matches;
  panelBackdrop = document.createElement('div'); panelBackdrop.className = 'ctx-backdrop' + (sheet ? ' sheet' : '');
  panel = document.createElement('section'); panel.className = 'notif-panel glass' + (sheet ? ' sheet' : ''); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Notifications');
  document.body.append(panelBackdrop, panel); renderPanel();
  if (!sheet) { const r = $('bellBtn').getBoundingClientRect(); panel.style.top = `${Math.round(r.bottom + 10)}px`; panel.style.right = `${Math.max(12, Math.round(innerWidth - r.right - 8))}px`; }
  panel.querySelector('button, a')?.focus({ preventScroll: true });
  panelBackdrop.addEventListener('pointerdown', (e) => { e.preventDefault(); closePanel(); });
  $('bellBtn').setAttribute('aria-expanded', 'true');
  layerOpen('notifs', () => closePanel(true));
}
function closePanel(fromBack = false) {
  if (!panel) return;
  const p = panel, b = panelBackdrop; panel = panelBackdrop = null;
  $('bellBtn')?.setAttribute('aria-expanded', 'false');
  const done = () => { p.remove(); b?.remove(); };
  if (canAnimate()) { p.classList.add('closing'); b?.classList.add('closing'); setTimeout(done, 160); } else done();
  if (!fromBack) { layerClosed('notifs'); $('bellBtn')?.focus({ preventScroll: true }); }
}
function gotoFromPanel(url) { // navigate first, let the route change clear the history layer (avoids a back/forward race)
  closePanel(true);
  if (location.hash === url) layerClosed('notifs'); else location.hash = url;
}
$('bellBtn')?.addEventListener('click', openPanel);
document.addEventListener('keydown', (e) => { if (panel && e.key === 'Escape') { e.preventDefault(); closePanel(); } });
window.addEventListener('hashchange', () => closePanel(true));

/* settings card + panel actions (delegated; the settings page re-renders often) */
function notifSettingsHTML() {
  const p = perm(); const ios = isIOS() && !isStandalone();
  const status = !supportsNotif() ? 'This browser can’t show phone notifications. The bell inside SONORA still works.'
    : ios ? 'On iPhone, add SONORA to your Home Screen first (Share › Add to Home Screen), then turn notifications on from there.'
    : p === 'granted' ? 'Phone notifications are on.' : p === 'denied' ? 'Notifications are blocked. Allow them for SONORA in your browser or phone settings.' : 'Phone notifications are off.';
  const chip = (k, label) => `<button class="chip pref-chip" type="button" data-n="pref" data-k="${k}" aria-pressed="${prefOn(k)}">${label}</button>`;
  return `<div class="settings-subhead notif-subhead"><div><h3>Notifications</h3><p>The lock-screen player (artwork, play, previous, next, seek bar) is always on while music plays. Alerts appear in the bell and, if allowed, as phone notifications.</p></div></div>
  <div class="notif-status" data-state="${p}"><span>${status}</span><div class="notif-btns">${supportsNotif() && p !== 'granted' && p !== 'denied' ? '<button class="btn btn-primary" type="button" data-n="enable">Turn on notifications</button>' : ''}${p === 'granted' ? '<button class="btn btn-glass" type="button" data-n="test">Send a test</button>' : ''}</div></div>
  <div class="motion-options notif-prefs" role="group" aria-label="Alert types">${chip('release', 'New releases')}${chip('sleep', 'Sleep timer')}${chip('quiet', 'Quiet hours 10pm–8am')}</div>`;
}
function refreshNotifUI() { const el = $('notifSettings'); if (el) el.innerHTML = notifSettingsHTML(); renderPanel(); }
new MutationObserver(() => { const el = $('notifSettings'); if (el && !el.firstChild) el.innerHTML = notifSettingsHTML(); }).observe($('view') || document.body, { childList: true, subtree: true });
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-n]'); if (!b) return;
  const act = b.dataset.n;
  if (act === 'enable') { e.preventDefault(); enableNotifications(); }
  else if (act === 'test') { e.preventDefault(); const t = addNotification({ type: 'system', title: 'Test notification', body: 'This is how SONORA alerts will look on your phone.', url: '#/home' }); showSystem(t); }
  else if (act === 'pref') { const k = b.dataset.k; prefs[k] = !prefOn(k); lsSet(PK, prefs); b.setAttribute('aria-pressed', String(prefOn(k))); }
  else if (act === 'readall') { notifs.forEach((n) => { n.read = true; }); lsSet(NK, notifs); updateBadge(); renderPanel(); }
  else if (act === 'clear') { notifs = []; lsSet(NK, notifs); updateBadge(); renderPanel(); }
  else if (act === 'close') closePanel();
  else if (act === 'settings') { e.preventDefault(); gotoFromPanel('#/settings'); }
  else if (act === 'open') {
    const n = notifs.find((x) => x.id === b.dataset.id); if (!n) return;
    n.read = true; lsSet(NK, notifs); updateBadge(); gotoFromPanel(n.url || '#/home');
  }
});
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'sonora-open') location.hash = String(e.data.url || '#/home').replace(/^.*#/, '#'); });

/* new-release alerts: checked while the app is open or playing in the background */
let lastCheck = 0;
async function checkReleases() {
  const app = App(); if (!app?.cloud?.() || !app.fetchLatest) return;
  lastCheck = Date.now();
  let rows = []; try { rows = await app.fetchLatest(); } catch { return; }
  if (!rows.length) return;
  const newest = rows[0].created_at; const base = localStorage.getItem(BK);
  if (!base) { localStorage.setItem(BK, newest); return; } // first run: remember what already exists, do not spam
  const fresh = rows.filter((r) => String(r.created_at) > base);
  if (!fresh.length) return;
  localStorage.setItem(BK, newest);
  const one = fresh.length === 1;
  notifyEvent('release', one ? 'New on SONORA' : `${fresh.length} new tracks on SONORA`,
    one ? `${fresh[0].title} — ${fresh[0].artist}` : `${fresh.slice(0, 3).map((r) => r.title).join(', ')}${fresh.length > 3 ? '…' : ''}`,
    { url: '#/home', image: fresh[0].cover_url || '' });
  app.refreshCatalogue?.();
}
setTimeout(checkReleases, 5000);
setInterval(() => { if (Date.now() - lastCheck > 7 * 60 * 1000) checkReleases(); }, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastCheck > 2 * 60 * 1000) checkReleases(); });
updateBadge();

/* ---------------- phone: shorter search placeholder so it is not cut off ---------------- */
(() => {
  const input = $('topSearch'); if (!input) return;
  const full = input.getAttribute('placeholder') || 'Search tracks, artists, genres';
  const mq = matchMedia('(max-width:520px)'), tiny = matchMedia('(max-width:430px)');
  const apply = () => input.setAttribute('placeholder', tiny.matches ? 'Search' : mq.matches ? 'Search songs' : full);
  apply(); mq.addEventListener?.('change', apply); tiny.addEventListener?.('change', apply);
})();

window.SonoraUX = { routeEnter, openPlayer, closePlayer, trackChanged, pop, closeMenu, artworkFor, notifyEvent, checkReleases };
})();
