/**
 * The cursor: its state and drawing, the icon under the pointer, its position kept across navigations, the file-drag
 * card, and the listeners of a drawing top document.
 */
import type { CursorKind, CursorState } from '../types.js';
import { RT } from './clock.js';
import { config } from './config.js';
import { drag, fileDrag } from './file-drag.js';
import { host } from './host.js';
import { carried, cleanups, disposed, isTop, on } from './lifecycle.js';
import { attach, buildOverlay, cursorEl, ghostEl, queueRaise, reportCursorEffect, scaleEl } from './overlay.js';
import { ripple } from './ripple.js';
import { deepClosest, deepHit, isA, styleOf } from './trees.js';

const state: CursorState = { x: 0, y: 0, visible: false, known: false, kind: 'arrow', pressed: false };
let wantVisible = true;
let ghostOn = false;
/**
 * A new document draws its cursor only once the page painted content of its own (R-ISS-08): the cursor's SVG would
 * otherwise be the document's first contentful paint — a cursor restored from sessionStorage drawn on an empty page
 * ends Chromium's paint holding and the recorder's hold of the load, and the empty page is filmed. The runner reveals
 * it after a load it waited for (`cursor.reveal`); a page that never paints content (no text, image or SVG) nobody
 * waits for shows it REVEAL_FALLBACK_MS after its load (the recorder's longest hold: an app's empty shell may wait
 * that long for its data). Only the drawing waits: the cursor's state is unchanged.
 */
let revealed = true;
const REVEAL_FALLBACK_MS = 10_000;

function render(): void {
  if (!cursorEl) return;
  const on = state.known && wantVisible;
  state.visible = on;
  cursorEl.classList.toggle('on', on && revealed);
  cursorEl.style.transform = `translate3d(${state.x}px,${state.y}px,0)`;
  cursorEl.dataset.k = state.kind;
  if (ghostEl && ghostOn) ghostEl.style.transform = `translate3d(${state.x - 30}px,${state.y - 22}px,0) rotate(-3deg)`;
}
function reveal(): void {
  if (revealed || disposed) return;
  revealed = true;
  render();
}
/** Hide the cursor until the document's first contentful paint (see `revealed`), when it has not happened yet. */
function awaitFirstPaint(): void {
  try {
    if (RT.performance.getEntriesByName('first-contentful-paint').length > 0) return;
    const po = new PerformanceObserver((list) => {
      if (list.getEntriesByName('first-contentful-paint').length === 0) return;
      po.disconnect();
      reveal();
    });
    po.observe({ type: 'paint', buffered: true });
    cleanups.push(() => po.disconnect());
  } catch {
    return; // no paint timing: draw at once
  }
  revealed = false;
  const fallback = () => {
    const t = RT.setTimeout(reveal, REVEAL_FALLBACK_MS);
    cleanups.push(() => RT.clearTimeout(t));
  };
  if (document.readyState === 'complete') fallback();
  else on(window, 'load', fallback);
}
let lastSave = 0;
function save(force = false): void {
  const now = RT.Date.now();
  if (!force && now - lastSave < 120) return;
  lastSave = now;
  try {
    sessionStorage.setItem(config.storage_key, JSON.stringify({ x: state.x, y: state.y, v: wantVisible }));
  } catch {
    /* storage unavailable (opaque origin, blocked) */
  }
}
function restore(): void {
  try {
    const raw = sessionStorage.getItem(config.storage_key);
    if (!raw) return;
    const p = JSON.parse(raw) as { x: number; y: number; v: boolean };
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      state.x = p.x;
      state.y = p.y;
      state.known = true;
      wantVisible = p.v !== false;
    }
  } catch {
    /* ignore */
  }
}
let lastKind = 0;
function computeKind(): CursorKind {
  // The innermost element under the pointer, through open shadow roots and same-origin frames.
  const el = deepHit(state.x, state.y);
  if (!el) return 'arrow';
  const cur = styleOf(el).cursor;
  if (cur === 'pointer') return 'hand';
  if (cur === 'text' || cur === 'vertical-text') return 'ibeam';
  if (cur === 'auto') {
    const ed = deepClosest(el, 'input,textarea,[contenteditable=""],[contenteditable=true]');
    if (isA(ed, 'input')) {
      return ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(ed.type) ? 'ibeam' : 'arrow';
    }
    return ed ? 'ibeam' : 'arrow';
  }
  return 'arrow';
}
let kindTimer: ReturnType<typeof setTimeout> | null = null;
/** Last icon reported to the runner (a new document reports its first one). */
let reportedKind: CursorKind | null = null;
function updateKind(force: boolean): void {
  const now = RT.performance.now();
  if (!force && now - lastKind < 50) {
    // Throttled: make sure the icon is re-evaluated once the pointer settles.
    kindTimer ??= RT.setTimeout(() => {
      kindTimer = null;
      updateKind(true);
    }, 50 - (now - lastKind));
    return;
  }
  lastKind = now;
  const kd = computeKind();
  if (kd !== state.kind) {
    state.kind = kd;
    render();
  }
  if (kd !== reportedKind) {
    reportedKind = kd;
    reportCursorEffect('icon', { icon: kd });
  }
}
export function moveTo(x: number, y: number): void {
  state.x = x;
  state.y = y;
  state.known = true;
  render();
  updateKind(false);
  save();
  if (drag) fileDrag.over(x, y);
}
export function press(down: boolean): void {
  const changed = state.pressed !== down;
  state.pressed = down;
  scaleEl?.classList.toggle('p', down);
  if (changed) reportCursorEffect(down ? 'press' : 'release');
}
export const cursorApi = {
  set(x: number, y: number, show?: boolean): void {
    if (show !== undefined) wantVisible = show;
    moveTo(x, y);
    save(true);
  },
  show(): void {
    wantVisible = true;
    render();
    save(true);
  },
  hide(): void {
    wantVisible = false;
    render();
    save(true);
  },
  ripple,
  press,
  state: (): CursorState => ({ ...state }),
  reveal,
};

const EXT_COLORS: Record<string, string> = {
  xlsx: '#1f8a4c', xls: '#1f8a4c', csv: '#6b7280', tsv: '#6b7280', pdf: '#d93a2b', docx: '#2b5fb8', doc: '#2b5fb8',
  pptx: '#d2602a', ppt: '#d2602a', zip: '#b8892b', png: '#7a4fc9', jpg: '#7a4fc9', jpeg: '#7a4fc9', json: '#4b5563', txt: '#6b7280',
};
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
export const ghost = {
  show(name: string, detail: string): void {
    if (!ghostEl) return;
    const ext = (name.includes('.') ? name.split('.').pop() ?? '' : '').toLowerCase().slice(0, 4);
    const color = EXT_COLORS[ext] ?? '#64748b';
    ghostEl.innerHTML =
      `<div class="b"><svg width="36" height="44" viewBox="0 0 36 44"><path d="M4 0 H24 L36 12 V40 A4 4 0 0 1 32 44 H4 A4 4 0 0 1 0 40 V4 A4 4 0 0 1 4 0 Z" fill="${color}"/>` +
      `<path d="M24 0 V8 A4 4 0 0 0 28 12 H36 Z" fill="#fff" fill-opacity=".35"/></svg><span>${esc(ext.toUpperCase())}</span></div>` +
      `<div><div class="n">${esc(name)}</div>${detail ? `<div class="d">${esc(detail)}</div>` : ''}</div>`;
    ghostOn = true;
    render();
    ghostEl.getBoundingClientRect();
    ghostEl.classList.add('on');
  },
  hide(): void {
    if (!ghostEl) return;
    ghostEl.classList.remove('on');
    const el = ghostEl;
    RT.setTimeout(() => {
      if (!el.classList.contains('on')) {
        ghostOn = false;
        el.innerHTML = '';
      }
    }, 300);
  },
};

/**
 * The cursor of this document: drawn and driven by real input in a top document (overlay, listeners, top-layer
 * patches); a sub-frame forwards its pointer input to its parent; the recorder's passive copy does nothing.
 */
export function installCursor(): void {
  if (config.passive) {
    // The recorder's copy (L3.4): in an isolated world, it draws nothing, patches nothing and listens to nothing.
  } else if (isTop) {
    buildOverlay();
    awaitFirstPaint();
    restore();
    if (carried?.known) {
      state.x = carried.x;
      state.y = carried.y;
      state.known = true;
      wantVisible = carried.visible || !carried.known;
    }
    render();
    const onMove = (e: Event) => {
      const m = e as MouseEvent;
      if (!m.isTrusted) return;
      if (m.clientX === state.x && m.clientY === state.y && state.known) return;
      moveTo(m.clientX, m.clientY);
    };
    let downAt = 0;
    const onDown = (e: Event) => {
      const m = e as MouseEvent;
      if (!m.isTrusted) return;
      const now = RT.performance.now();
      if (m.type === 'mousedown' && now - downAt < 80) return;
      downAt = now;
      moveTo(m.clientX, m.clientY);
      press(true);
      ripple(m.clientX, m.clientY);
    };
    const onUp = (e: Event) => {
      if (e.isTrusted) press(false);
    };
    on(window, 'pointermove', onMove);
    on(window, 'mousemove', onMove);
    on(window, 'pointerdown', onDown);
    on(window, 'mousedown', onDown);
    on(window, 'pointerup', onUp);
    on(window, 'mouseup', onUp);
    on(window, 'dragover', (e) => {
      const m = e as DragEvent;
      if (m.isTrusted) moveTo(m.clientX, m.clientY);
    });
    on(window, 'pagehide', () => save(true));
    on(window, 'toggle', (e) => {
      if (e.target !== host && (e as ToggleEvent).newState === 'open') queueRaise();
    });
    const timer = RT.setInterval(() => {
      if (state.visible) updateKind(true);
    }, 250);
    cleanups.push(() => RT.clearInterval(timer));

    const patch = (proto: object, name: string) => {
      const p = proto as Record<string, unknown>;
      const orig = p[name];
      if (typeof orig !== 'function') return;
      p[name] = function (this: Element, ...args: unknown[]) {
        const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
        if (this !== host && !disposed) queueRaise();
        return r;
      };
    };
    patch(HTMLDialogElement.prototype, 'showModal');
    patch(HTMLElement.prototype, 'showPopover');
    patch(HTMLElement.prototype, 'togglePopover');

    const mo = new MutationObserver(() => {
      if (!host.isConnected) attach();
    });
    const start = () => {
      if (disposed || !document.documentElement) return;
      attach();
      mo.observe(document.documentElement, { childList: true });
    };
    const docMo = new MutationObserver(() => {
      if (document.documentElement && !host.isConnected) start();
    });
    docMo.observe(document, { childList: true });
    cleanups.push(() => {
      mo.disconnect();
      docMo.disconnect();
      host.remove();
    });
    start();
  } else {
    // Sub-frames forward real pointer input to the parent, which offsets it by the frame position.
    const fwd = (type: string) => (e: Event) => {
      const m = e as MouseEvent;
      if (!m.isTrusted) return;
      try {
        window.parent.postMessage({ __retakePtr: 1, type, x: m.clientX, y: m.clientY }, '*');
      } catch {
        /* detached */
      }
    };
    on(window, 'pointermove', fwd('move'));
    on(window, 'pointerdown', fwd('down'));
    on(window, 'pointerup', fwd('up'));
  }
}
