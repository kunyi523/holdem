// Small UI kit: stacked toasts (with action buttons), haptics, confirm sheet, confetti.
const reduce = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function haptic(pattern = 8) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* not supported (iOS) */ }
}

let box = null;
const live = new Map(); // key -> element (re-using a key replaces that toast instead of stacking)
function container() {
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  return box;
}
// toast('text') | toast('text', { type: 'ok'|'warn'|'err'|'info'|'money', ms, key, html, actions: [{ label, kind, onClick }] })
export function toast(msg, opts = {}) {
  if (typeof opts === 'number') opts = { ms: opts };
  const { type = 'info', ms = opts.actions ? 12000 : 2400, key, actions = [], icon } = opts;
  const c = container();
  if (key && live.has(key)) live.get(key).remove();
  const el = document.createElement('div');
  el.className = `tst ${type}`;
  const ic = icon ?? { ok: '✅', warn: '⚠️', err: '⛔', money: '💰', net: '📶' }[type] ?? '';
  el.innerHTML = `${ic ? `<span class="ti">${ic}</span>` : ''}<span class="tt">${opts.html ? msg : escH(msg)}</span>${actions.length ? `<span class="ta">${actions.map((a, i) => `<button class="tb ${a.kind || ''}" data-i="${i}">${escH(a.label)}</button>`).join('')}</span>` : ''}`;
  const close = () => { if (!el.isConnected) return; el.classList.add('out'); setTimeout(() => el.remove(), reduce() ? 0 : 220); if (key && live.get(key) === el) live.delete(key); };
  el.querySelectorAll('.tb').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); haptic(10); const a = actions[Number(b.dataset.i)]; close(); a.onClick && a.onClick(); }; });
  if (!actions.length) el.onclick = close;
  c.appendChild(el);
  while (c.children.length > 4) c.firstElementChild.remove();
  if (key) live.set(key, el);
  if (ms > 0) setTimeout(close, ms);
  return { close, el };
}
export function dropToast(key) { const el = live.get(key); if (el) { el.remove(); live.delete(key); } }

// Bottom sheet confirm: resolves true/false.
export function confirmSheet({ title, body = '', ok = '确定', cancel = '取消', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<div class="sheet ${danger ? 'danger' : ''}" role="dialog" aria-modal="true"><h3>${escH(title)}</h3>${body ? `<div class="sheet-body">${body}</div>` : ''}
      <div class="sheet-btns"><button class="btn" data-r="0">${escH(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${escH(ok)}</button></div></div>`;
    const done = (r) => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), reduce() ? 0 : 180); document.removeEventListener('keydown', onKey, true); resolve(r); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(true); } };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    wrap.querySelectorAll('[data-r]').forEach((b) => { b.onclick = () => { haptic(10); done(b.dataset.r === '1'); }; });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    setTimeout(() => wrap.querySelector('[data-r="1"]').focus(), 30);
  });
}

// Confetti burst from a point (viewport %). No-op with reduced motion.
export function confetti(x = 50, y = 45, n = 42) {
  if (reduce()) return;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  const colors = ['#f5c451', '#ffe7a6', '#3fcf7a', '#5b97ff', '#ff6b6b', '#e6a3ff', '#fff'];
  let html = '';
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 170;
    const dx = Math.cos(a) * d, dy = Math.sin(a) * d - 120;
    html += `<i style="left:${x}%;top:${y}%;--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px;--r:${(Math.random() * 720 - 360).toFixed(0)}deg;background:${colors[i % colors.length]};animation-delay:${(Math.random() * 120).toFixed(0)}ms;${i % 3 ? '' : 'border-radius:50%;'}"></i>`;
  }
  layer.innerHTML = html;
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1900);
}

// Press feedback for every button: tiny haptic tick + ripple origin at the touch point.
export function installPressFeedback() {
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.btn, .icon-btn, .tb, .net-pill');
    if (!b || b.disabled) return;
    const r = b.getBoundingClientRect();
    b.style.setProperty('--px', `${e.clientX - r.left}px`);
    b.style.setProperty('--py', `${e.clientY - r.top}px`);
    if (e.pointerType === 'touch') haptic(6);
  }, { passive: true });
}
