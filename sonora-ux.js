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

/* ---------------- phone: shorter search placeholder so it is not cut off ---------------- */
(() => {
  const input = $('topSearch'); if (!input) return;
  const full = input.getAttribute('placeholder') || 'Search tracks, artists, genres';
  const mq = matchMedia('(max-width:520px)');
  const apply = () => input.setAttribute('placeholder', mq.matches ? 'Search songs' : full);
  apply(); mq.addEventListener?.('change', apply);
})();

window.SonoraUX = { routeEnter, openPlayer, closePlayer, trackChanged, pop, closeMenu };
})();
