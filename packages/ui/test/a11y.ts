/**
 * L4.9 part A: the Studio's accessibility checker (a test helper, no dependency): rules over the page's computed styles
 * and Chromium's accessibility tree, each with a stable id, each finding naming the element (`tag#id[data-testid].class`)
 * and its numbers.
 * - `contrast` — every visible text (each control's value, a submit button's value, a `::before` / `::after` quoted
 *   `content`) against what is painted under it: every ancestor's background composited from the page up, each
 *   ancestor's opacity applied as a group (the text and what is under it faded together over what is below that
 *   ancestor); a gradient → its worst colour stop; an image background → unmeasured (counted, budgeted per station); a
 *   colour the checker cannot parse (`oklch()`, `color-mix()` …) → a finding, never a transparent pass; media (img /
 *   video / canvas / iframe) painted under the text inside its nearest opaque box (`elementsFromPoint` when on screen) →
 *   the translucent layers composited over both black and white, the worse ratio kept (no translucent layer at all →
 *   unmeasured). 4.5:1, 3:1 for ≥ 24 px or ≥ 18.66 px bold; the text of a disabled control itself (WCAG: inactive) is
 *   exempt and counted — never the rest of a disabled container.
 * - `placeholder` — an empty field's `::placeholder` colour (its own opacity too) on the field's background, 4.5:1.
 * - `name` — a control of the accessibility tree with no name, or named only by its placeholder or title (CDP); a
 *   focusable element inside `aria-hidden` (a screen reader cannot reach what the keyboard lands on); an `<img>` with no
 *   `alt`.
 * - `reachable` — an element with an interactive role the keyboard cannot reach, native or not (tabIndex < 0) and not
 *   the item of a composite whose tab stop is one of its own items, or the composite itself with an active descendant
 *   inside it, or a listbox that a focusable combobox controls with `aria-activedescendant` (L5.9: the palette). Composites of one family sharing one tab stop (the scenes' step lists) are listed in `stats.families`:
 *   `familyWalk` proves with the arrow keys that the stop reaches each of them.
 * - `focus-ring` (tabWalk) — each Tab stop must show a real indicator on the element, its active option or one of its
 *   two nearest visible ancestors, focused vs blurred: an outline, shadow or border part of ≥ 3:1 against what it is
 *   drawn on (and, for a border, against its unfocused colour) adding up to ≥ 2 CSS px, or a background change of ≥ 3:1
 *   — a transparent outline, a faint shadow, a 1 % tint fail; the focused element must not be entirely covered (its
 *   centre and four inner corners under another element); text that shows only while focused (a pin's tooltip) is
 *   contrast-checked then. A walk that never comes back to its first stop before its cap is a finding (`walk`).
 * - `colour-only` — the status families (every token of `--danger*`, `--warning*`, `--info*`, `--success*`,
 *   `--online*` and the kit's `--ui-ok*`, `--ui-warn*`, `--ui-fail*`, `--ui-record*`, `--ui-danger*`, declared by any rule
 *   of `:root` or of a `[data-appearance]` scope — inside `@media` or a cascade layer too — and resolved on the element's
 *   own scope: L5.9, critique H1) on a background, border, outline, shadow, a glyph-only text's colour or a `::before` / `::after`: a mark
 *   with no letters (a dot, a bar, a ●) needs a state word in its own or its row's visible text — never any word, never a
 *   label only a screen reader hears; a glyph other than a dot (◆ ✂ · ✓) says it by its shape; rows (of a table, a list,
 *   a listbox) that differ from their siblings by a status colour (diff rows) must start with a sign (+ − ✓ ✗ …) or say a
 *   state word.
 * - `selected` — every selected / current / pressed / checked state (aria-selected, aria-pressed, aria-checked off
 *   native inputs, aria-current, the classes `selected`, `is-selected`, `current`, `is-current`, `is-checked`) must
 *   differ from an unselected peer (same tag, role and first class, up to four levels up, not holding the focus; aria-current
 *   only on a link or control — a breadcrumb's place says it) by more than colour: a weight
 *   ≥ 200 heavier, an underline, a mark (border, outline, shadow) ≥ 2 px thicker on one side at ≥ 3:1 against both
 *   backgrounds, a fill ≥ 3:1 from the peer's, a `::before` / `::after` marker, or a marker child — on the element or its
 *   matching children (two levels): it survives greyscale.
 * - `headings` — exactly one level-1 heading (`h1` or `role=heading`), none hidden counted; no level skipped downwards.
 * - `overflow` — no sideways scroll of the page or of `main`.
 * Out of reach (BL-122): `filter` and `mix-blend-mode`, `-webkit-text-fill-color`, `display: contents` text, a dark
 * sibling layer painted under the text (not an ancestor), text clipped by an `overflow: hidden` panel, label-in-name.
 * The in-page part is installed by `page.evaluate` (the test's own code, never the app's: the app runs no code from a
 * string).
 */
import type { Locator, Page } from 'playwright-core';

export type Rule = 'contrast' | 'placeholder' | 'name' | 'reachable' | 'focus-ring' | 'walk' | 'colour-only' | 'selected' | 'headings' | 'overflow';

export interface Finding {
  rule: Rule;
  /** The element: `tag#id[data-testid=…].class`. */
  el: string;
  detail: string;
  text?: string;
}

export interface AuditStats {
  /** Texts and control values measured. */
  texts: number;
  /** Of which painted over media (composited over black and white). */
  overMedia: number;
  placeholders: number;
  /** Texts of disabled controls (exempt). */
  exempt: number;
  /** Texts whose background could not be measured (an image background, media with nothing translucent between). */
  unmeasured: string[];
  /** Controls of the accessibility tree checked for a name. */
  controls: number;
  /** Selected / current / pressed states compared with an unselected peer; and those with no peer (or holding the focus). */
  selected: number;
  selectedAlone: number;
  /** Composite families sharing one tab stop (a CSS selector each): `familyWalk` must reach every group of each. */
  families: string[];
  /** L5.9: status colours the colour-only rule resolved on the document's root (0 means it watched nothing). */
  statusTokens: number;
}

export interface Audit {
  findings: Finding[];
  stats: AuditStats;
}

export interface AuditOptions {
  /** The status colour families the colour-only rule watches (default: the Studio's four families + online, and the kit's). */
  status?: string[];
  /** Skip the accessibility-tree rule (a browser without CDP). */
  noTree?: boolean;
}

export interface TabWalk {
  stops: number;
  /** Stops that were frames (skipped: their document is not the app's). */
  frames: number;
  findings: Finding[];
}

/** The status families: every `:root` token named so, or starting with the name and a dash. */
export const STATUS_TOKENS = ['--danger', '--warning', '--info', '--success', '--online', '--ui-ok', '--ui-warn', '--ui-fail', '--ui-record', '--ui-recording', '--ui-danger', '--ui-idle', '--ui-waiting'];
/** The Tab walk's default cap: nearly four times the largest screen measured (the library: 104 stops). */
export const WALK_MAX = 400;

/** Roles the keyboard must reach and the accessibility tree must name. */
const CONTROL_ROLES = ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'option', 'listbox'];

/** The in-page half: installs `window.__a11y` (idempotent). Self-contained: it runs in the page. */
function install(): void {
  const w = window as unknown as { __a11y?: unknown };
  if (w.__a11y) return;
  type RGBA = [number, number, number, number];
  type Found = { rule: string; el: string; detail: string; text?: string };
  type Layer = { e: Element | null; alts: RGBA[] | null; op: number };
  type Chain = { layers: Layer[]; bases: RGBA[]; overMedia: boolean };
  const WHITE: RGBA = [255, 255, 255, 1];
  const BLACK: RGBA = [0, 0, 0, 1];
  /** A computed colour, or null when the checker cannot read it (a colour space it does not convert). */
  const parse = (c: string | null | undefined): RGBA | null => {
    if (!c) return null;
    const s = c.trim();
    if (s === 'transparent') return [0, 0, 0, 0];
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (hex) {
      const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join('') : hex[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    const srgb = /^color\(srgb\s+([^)]+)\)$/.exec(s);
    if (srgb) {
      const p = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
      if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const COLOUR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\((?:[^()]|\([^()]*\))*\)/g;
  const over = (top: RGBA, bottom: RGBA): RGBA => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const ch = (i: number) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
    return [ch(0), ch(1), ch(2), a];
  };
  /** A group of opacity `o` laid over its backdrop. */
  const mix = (x: RGBA, b: RGBA, o: number): RGBA => [0, 1, 2].map((i) => x[i] * o + b[i] * (1 - o)).concat(1) as RGBA;
  const lum = (c: RGBA) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: RGBA, b: RGBA) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  /** The worst ratio of every pairing of two lists of opaque colours. */
  const minRatio = (as: RGBA[], bs: RGBA[]) => Math.min(...as.flatMap((a) => bs.map((b) => ratio(a, b))));
  /** The worst ratio of colour `c` (maybe translucent) painted over each of `bgs`. */
  const markRatio = (c: RGBA, bgs: RGBA[]) => Math.min(...bgs.map((b) => ratio(over(c, b), b)));
  const round = (n: number) => Math.round(n * 100) / 100;
  const css = (c: RGBA) => `rgb(${c.slice(0, 3).map(Math.round).join(',')})`;
  const desc = (el: Element) => {
    const t = el.getAttribute('data-testid');
    const cls = typeof (el as HTMLElement).className === 'string' && (el as HTMLElement).className.trim() ? '.' + (el as HTMLElement).className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${t ? `[data-testid=${t}]` : ''}${cls}`;
  };
  const opacityOf = (el: Element) => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const shown = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const NATIVE_CONTROL = 'button, input, select, textarea, option, optgroup';
  const ROLE_CONTROL = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'treeitem', 'gridcell']);
  /** Text of an inactive control itself (a disabled button, input, option, label of a disabled field, an aria-disabled control). */
  const inactive = (el: Element) => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      if (e.matches(NATIVE_CONTROL) && e.matches(':disabled')) return true;
      const role = e.getAttribute('role');
      if (role && ROLE_CONTROL.has(role) && e.getAttribute('aria-disabled') === 'true') return true;
      if (e.tagName === 'LABEL') {
        const c = (e as HTMLLabelElement).control;
        if (c && c.matches(':disabled')) return true;
      }
    }
    return false;
  };

  /**
   * What is painted under `el`: every ancestor's background (alternatives: gradient stops) and opacity, page first; or why
   * it cannot be measured (`unmeasured`, budgeted) or read (`unparseable`, a finding).
   */
  const MEDIA = 'img, video, canvas, iframe';
  const chainOf = (el: Element, rect: DOMRect | null, extra?: Layer): Chain | { unmeasured: string } | { unparseable: string } => {
    const layers: Layer[] = [];
    let opaque: Element | null = null;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      let bc = parse(cs.backgroundColor);
      if (!bc) {
        // Hidden under an opaque layer, an unreadable colour does not matter.
        if (!opaque) return { unparseable: `background ${cs.backgroundColor} on ${desc(e)}` };
        bc = [0, 0, 0, 0];
      }
      let alts: RGBA[] = [bc];
      const bi = cs.backgroundImage;
      if (!opaque && bi && bi !== 'none') {
        if (/url\(/.test(bi)) return { unmeasured: `an image background on ${desc(e)}` };
        const fns = bi.match(COLOUR_FN) ?? [];
        const stops = fns.map(parse);
        if (stops.some((s) => s === null)) return { unparseable: `a gradient stop ${fns[stops.indexOf(null)]} on ${desc(e)}` };
        if (stops.length === 0) return { unmeasured: `a background image on ${desc(e)}` };
        alts = (stops as RGBA[]).map((s) => over(s, bc!));
      }
      layers.push({ e, alts, op: Number(cs.opacity) });
      if (!opaque && alts.every((a) => a[3] >= 1)) opaque = e;
    }
    // Media painted under the text inside its opaque box (a picture with an overlay on it, never its ancestor).
    let media: Element | null = null;
    if (rect) {
      for (const m of document.querySelectorAll(MEDIA)) {
        if (opaque && !opaque.contains(m)) continue;
        if (m === el || !shown(m)) continue;
        const r = m.getBoundingClientRect();
        const x0 = Math.max(r.left, rect.left);
        const x1 = Math.min(r.right, rect.right);
        const y0 = Math.max(r.top, rect.top);
        const y1 = Math.min(r.bottom, rect.bottom);
        if (x1 - x0 < 1 || y1 - y0 < 1) continue;
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
          const stack = document.elementsFromPoint(cx, cy);
          const im = stack.indexOf(m);
          const it = stack.indexOf(el);
          // The media painted above the text hides it: not under.
          if (im >= 0 && it >= 0 && im < it) continue;
        }
        media = m;
        break;
      }
    }
    if (media) {
      // Over media, only the layers painted above it count (an ancestor's background is under the picture).
      for (const l of layers) if (l.e && l.e.contains(media)) l.alts = null;
      if (!layers.some((l) => l.alts && l.alts.some((a) => a[3] > 0)) && !(extra?.alts ?? []).some((a) => a[3] > 0)) return { unmeasured: `text straight on media (${desc(el)})` };
    }
    if (extra) layers.unshift(extra);
    return { layers: layers.reverse(), bases: media ? [BLACK, WHITE] : [WHITE], overMedia: media !== null };
  };

  /** The chain painted: every base × every combination of alternatives (capped), each as (background, text) pixels. */
  const paint = (c: Chain, fg: RGBA | null): Array<{ bg: RGBA; fg: RGBA | null }> => {
    let combos: Array<Array<RGBA | null>> = [[]];
    for (const l of c.layers) {
      const alts: Array<RGBA | null> = l.alts && l.alts.some((a) => a[3] > 0) ? l.alts : [null];
      combos = combos.flatMap((k) => alts.map((a) => [...k, a])).slice(0, 64);
    }
    const out: Array<{ bg: RGBA; fg: RGBA | null }> = [];
    for (const base of c.bases) {
      for (const combo of combos) {
        const backdrops: RGBA[] = [];
        let bg = base;
        c.layers.forEach((_l, i) => {
          backdrops.push(bg);
          const a = combo[i];
          if (a) bg = over(a, bg);
        });
        let f = fg ? over(fg, bg) : null;
        // Opacity groups, innermost first: the group (its text with it) laid over what is below it.
        for (let i = c.layers.length - 1; i >= 0; i--) {
          const o = c.layers[i].op;
          if (o < 1) {
            bg = mix(bg, backdrops[i], o);
            if (f) f = mix(f, backdrops[i], o);
          }
        }
        out.push({ bg, fg: f });
      }
    }
    return out;
  };
  /** The colours a box shows (its own background over everything under it), or null when unreadable. */
  const bgOf = (el: Element | null): RGBA[] | null => {
    if (!el) return [WHITE];
    const c = chainOf(el, null);
    return 'layers' in c ? paint(c, null).map((p) => p.bg) : null;
  };

  const need = (cs: CSSStyleDeclaration) => {
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    return size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
  };
  /** The quoted strings of a `content` value (counters, attr() and images are not text the checker reads). */
  const contentText = (content: string) => [...content.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join('');

  /** The contrast rule over `root`'s texts and control values. */
  const contrastIn = (root: Element, stats: { texts: number; overMedia: number; exempt: number; unmeasured: string[] }, out: Found[], seen = new Set<Element>()) => {
    const check = (el: Element, sample: string, rect: DOMRect, pseudo?: CSSStyleDeclaration) => {
      seen.add(el);
      if (inactive(el)) {
        stats.exempt++;
        return;
      }
      const cs = pseudo ?? getComputedStyle(el);
      if (opacityOf(el) * (pseudo ? Number(pseudo.opacity) : 1) === 0) return;
      const fg0 = parse(cs.color);
      if (!fg0) {
        out.push({ rule: 'contrast', el: desc(el), text: sample.slice(0, 40), detail: `unmeasured: the text colour ${cs.color} cannot be read` });
        return;
      }
      const extra: Layer | undefined = pseudo ? { e: null, alts: [parse(pseudo.backgroundColor) ?? [0, 0, 0, 0]], op: Number(pseudo.opacity) } : undefined;
      const c = chainOf(el, rect, extra);
      if ('unparseable' in c) {
        out.push({ rule: 'contrast', el: desc(el), text: sample.slice(0, 40), detail: `unmeasured: ${c.unparseable} cannot be read` });
        return;
      }
      if ('unmeasured' in c) {
        stats.unmeasured.push(c.unmeasured);
        return;
      }
      stats.texts++;
      if (c.overMedia) stats.overMedia++;
      const min = need(cs);
      let worst = Infinity;
      let worstBg: RGBA = WHITE;
      for (const p of paint(c, fg0)) {
        const r = ratio(p.fg!, p.bg);
        if (r < worst) {
          worst = r;
          worstBg = p.bg;
        }
      }
      const op = opacityOf(el);
      if (worst < min) out.push({ rule: 'contrast', el: desc(el) + (pseudo ? '::pseudo' : ''), text: sample.slice(0, 40), detail: `${round(worst)}:1 < ${min}:1 (${cs.color} on ${css(worstBg)}${c.overMedia ? ', over media' : ''}${op < 1 ? `, opacity ${round(op)}` : ''}, ${cs.fontSize})` });
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.nodeValue ?? '').trim();
      if (!text) continue;
      const el = n.parentElement;
      if (!el || seen.has(el)) continue;
      if (el.closest('svg, script, style, noscript, template, option, optgroup, select, .sr-only')) continue;
      if (!shown(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      check(el, text, rect);
    }
    // Control values: a text field's value, a select's shown option, a submit / button input's value.
    for (const el of root.querySelectorAll('input, textarea, select')) {
      if (seen.has(el) || !shown(el)) continue;
      const i = el as HTMLInputElement;
      if (el.tagName === 'INPUT' && /^(checkbox|radio|range|color|file|hidden|image)$/.test(i.type)) continue;
      const value = el.tagName === 'SELECT' ? ((el as HTMLSelectElement).selectedOptions[0]?.textContent ?? '') : i.value;
      if (!value.trim()) continue;
      check(el, value.trim(), el.getBoundingClientRect());
    }
    // ::before / ::after text (quoted content).
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.closest('svg, script, style, template, .sr-only') || !shown(el)) continue;
      for (const which of ['::before', '::after']) {
        const pc = getComputedStyle(el, which);
        if (!pc.content || pc.content === 'none' || pc.content === 'normal' || pc.display === 'none' || pc.visibility !== 'visible') continue;
        const text = contentText(pc.content).trim();
        if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
        check(el, `${which} ${text}`, el.getBoundingClientRect(), pc);
      }
    }
  };

  /** The text a sighted person sees in `e` (no visually hidden text; aria-hidden glyphs are seen). */
  const visibleText = (e: Element) => {
    let s = '';
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest('.sr-only, svg, script, style, template') || !shown(p)) continue;
      s += ` ${n.nodeValue ?? ''}`;
    }
    for (const which of ['::before', '::after']) {
      const pc = getComputedStyle(e, which);
      if (pc.content && pc.content !== 'none' && pc.content !== 'normal') s = which === '::before' ? `${contentText(pc.content)} ${s}` : `${s} ${contentText(pc.content)}`;
    }
    return s.replace(/\s+/g, ' ').trim();
  };
  /** A sign that says the state by its shape (added / removed, done / failed, a warning). */
  const SIGN = /^[+−\-✓✔✗✘✕×!⚠∅]$/;
  /** The status dot glyphs: a dot says nothing but its colour (a marker's ◆, a cut's ✂, a space's · say it by their shape). */
  const DOT = /[\u25cf\u2022\u2b24\u25c9]/;
  /** The state words a status colour may stand beside (the badges' and notices' vocabulary). */
  const STATE_WORDS = new Set('failed failure fails error errors warning warnings note notes ok okay succeeded success done passed clean online offline connected connecting ended live running queued waiting pending cancelled canceled stopped paused interrupted blocked stale missing changed conflict added removed deleted new applied resolved open outdated invalid required unsaved saved broken ready expired recording idle busy disconnected unreachable skipped superseded rejected accepted draft locked readonly read-only valid'.split(' '));
  const saysState = (text: string) => text.toLowerCase().split(/[^\p{L}-]+/u).some((wd) => STATE_WORDS.has(wd));
  const startsWithSign = (text: string) => SIGN.test(text.trim().split(/\s+/)[0] ?? '');

  /** The selected / current / pressed state of an element, or null. */
  const SEL_CLASS = /^(?:selected|is-selected|current|is-current|is-checked)$/;
  const selectedState = (e: Element): string | null => {
    for (const k of ['aria-selected', 'aria-pressed', 'aria-checked'] as const) if (e.getAttribute(k) === 'true' && !(k === 'aria-checked' && e.matches('input'))) return `${k}=true`;
    const cur = e.getAttribute('aria-current');
    if (cur && cur !== 'false') return `aria-current=${cur}`;
    const c = [...e.classList].find((x) => SEL_CLASS.test(x));
    return c ? `.${c}` : null;
  };
  const baseClass = (e: Element) => [...e.classList].find((c) => !SEL_CLASS.test(c)) ?? '';
  const signature = (e: Element) => `${e.tagName}|${e.getAttribute('role') ?? ''}|${baseClass(e)}|${baseClass(e) ? '' : (e.getAttribute('data-testid') ?? '')}`;
  const peerOf = (e: Element): Element | null => {
    const sig = signature(e);
    let a = e.parentElement;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) {
      for (const c of a.querySelectorAll(e.tagName)) {
        // (A peer holding the focus shows its ring: not the look to compare with.)
        if (c === e || c.contains(e) || e.contains(c) || signature(c) !== sig || selectedState(c) || !shown(c) || c.matches(':focus-within')) continue;
        return c;
      }
    }
    return null;
  };
  type Shadow = { c: RGBA | null; x: number; y: number; blur: number; spread: number; inset: boolean };
  const shadowsOf = (v: string): Shadow[] => {
    if (!v || v === 'none') return [];
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of v) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => {
      const colour = p.match(COLOUR_FN)?.[0] ?? null;
      const nums = p.replace(COLOUR_FN, ' ').match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
      return { c: colour ? parse(colour) : null, x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, inset: /\binset\b/.test(p) };
    });
  };
  const SIDES = ['top', 'right', 'bottom', 'left'] as const;
  /** Per side, the thickness of the marks drawn on a box that reach 3:1 against every colour of `bgs`. */
  const marksOf = (e: Element, bgs: RGBA[]): number[] => {
    const cs = getComputedStyle(e);
    const t = [0, 0, 0, 0];
    SIDES.forEach((s, i) => {
      const wd = parseFloat(cs.getPropertyValue(`border-${s}-width`));
      const st = cs.getPropertyValue(`border-${s}-style`);
      const c = parse(cs.getPropertyValue(`border-${s}-color`));
      if (wd > 0 && st !== 'none' && st !== 'hidden' && c && markRatio(c, bgs) >= 3) t[i] += wd;
    });
    const ow = parseFloat(cs.outlineWidth);
    const oc = parse(cs.outlineColor);
    if (cs.outlineStyle !== 'none' && ow > 0 && oc && markRatio(oc, bgs) >= 3) for (let i = 0; i < 4; i++) t[i] += ow;
    for (const s of shadowsOf(cs.boxShadow)) {
      if (!s.c || markRatio(s.c, bgs) < 3) continue;
      const k = Math.max(0, s.spread) + (s.blur > 0 ? s.blur / 2 : 0);
      t[0] += k + Math.max(0, s.inset ? s.y : -s.y);
      t[1] += k + Math.max(0, s.inset ? -s.x : s.x);
      t[2] += k + Math.max(0, s.inset ? -s.y : s.y);
      t[3] += k + Math.max(0, s.inset ? s.x : -s.x);
    }
    return t;
  };
  const visibleChildren = (e: Element) => [...e.children].filter((k) => shown(k) && !k.matches('.sr-only'));
  /** How `a` (selected) differs from `b` (its peer) by more than colour, or null. */
  const cueOf = (a: Element, b: Element, depth: number): string | null => {
    const ca = getComputedStyle(a);
    const cb = getComputedStyle(b);
    if ((Number(ca.fontWeight) || 400) - (Number(cb.fontWeight) || 400) >= 200) return `weight ${ca.fontWeight} vs ${cb.fontWeight}`;
    if (ca.textDecorationLine !== cb.textDecorationLine && ca.textDecorationLine !== 'none') return `${ca.textDecorationLine}`;
    const ba = bgOf(a);
    const bb = bgOf(b);
    if (ba && bb) {
      if (minRatio(ba, bb) >= 3) return `fill ${round(minRatio(ba, bb))}:1`;
      const both = [...ba, ...bb];
      const ma = marksOf(a, both);
      const mb = marksOf(b, both);
      for (let i = 0; i < 4; i++) if (ma[i] - mb[i] >= 2) return `a ${ma[i] - mb[i]} px mark (${SIDES[i]})`;
    }
    for (const which of ['::before', '::after']) {
      const pa = getComputedStyle(a, which).content;
      if (pa && pa !== 'none' && pa !== 'normal' && pa !== getComputedStyle(b, which).content) return `a ${which} marker`;
    }
    if (depth < 2) {
      const ka = visibleChildren(a);
      const kb = visibleChildren(b);
      for (let i = 0; i < Math.min(ka.length, kb.length, 12); i++) {
        if (ka[i].tagName !== kb[i].tagName) continue;
        const r = cueOf(ka[i], kb[i], depth + 1);
        if (r) return `${r} on ${desc(ka[i])}`;
      }
      const extra = ka.slice(kb.length).find((k) => k.matches('svg, img, [aria-hidden="true"]') || SIGN.test(visibleText(k)));
      if (extra && ka.length > kb.length) return `a marker ${desc(extra)}`;
    }
    return null;
  };

  const audit = (o: { status: string[] }) => {
    const out: Found[] = [];
    const stats = { texts: 0, overMedia: 0, placeholders: 0, exempt: 0, unmeasured: [] as string[], selected: 0, selectedAlone: 0, families: [] as string[], statusTokens: 0 };
    contrastIn(document.body, stats, out);

    // Placeholders: the app's own ::placeholder colour (and opacity) on the field.
    for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
      const f = el as HTMLInputElement;
      if (!shown(el) || f.value || !f.placeholder.trim() || f.matches(':disabled')) continue;
      const pc = getComputedStyle(el, '::placeholder');
      const c = parse(pc.color);
      const ch = chainOf(el, el.getBoundingClientRect());
      if (!c || 'unparseable' in ch) {
        out.push({ rule: 'placeholder', el: desc(el), text: f.placeholder.slice(0, 40), detail: `unmeasured: ${!c ? `the colour ${pc.color}` : (ch as { unparseable: string }).unparseable} cannot be read` });
        continue;
      }
      if ('unmeasured' in ch) {
        stats.unmeasured.push(`placeholder of ${desc(el)}`);
        continue;
      }
      stats.placeholders++;
      const worst = Math.min(...paint(ch, [c[0], c[1], c[2], c[3] * Number(pc.opacity || '1')]).map((p) => ratio(p.fg!, p.bg)));
      if (worst < 4.5) out.push({ rule: 'placeholder', el: desc(el), text: f.placeholder.slice(0, 40), detail: `${round(worst)}:1 < 4.5:1 (${pc.color}, opacity ${pc.opacity || '1'})` });
    }

    // Name (in the page): focusable inside aria-hidden; a picture with no alt.
    for (const el of document.querySelectorAll('[aria-hidden="true"] :is(a[href], button, input, select, textarea, [tabindex], [contenteditable="true"])')) {
      const h = el as HTMLElement;
      if (!shown(el) || h.tabIndex < 0 || el.matches(':disabled')) continue;
      out.push({ rule: 'name', el: desc(el), text: (el.textContent ?? '').trim().slice(0, 40), detail: 'focusable inside aria-hidden: the keyboard lands where a screen reader hears nothing' });
    }
    for (const el of document.querySelectorAll('img:not([alt])')) {
      if (!shown(el) || el.closest('[aria-hidden="true"]') || /^(presentation|none)$/.test(el.getAttribute('role') ?? '')) continue;
      out.push({ rule: 'name', el: desc(el), detail: 'img with no alt (alt="" for a decorative picture)' });
    }

    // Reachable: an interactive role the keyboard cannot reach.
    const ROLES = ['button', 'link', 'tab', 'radio', 'checkbox', 'switch', 'option', 'slider', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'treeitem'];
    const ITEM = '[role="radio"], [role="option"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"], [role="gridcell"], [role="row"]';
    const COMPOSITE = '[role="radiogroup"], [role="tablist"], [role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="grid"]';
    for (const el of document.querySelectorAll(ROLES.map((r) => `[role="${r}"]`).join(','))) {
      if (!shown(el) || inactive(el)) continue;
      const h = el as HTMLElement;
      if (h.tabIndex >= 0) continue;
      const group = el.closest(COMPOSITE) as HTMLElement | null;
      if (group) {
        // The tab stop is one of the group's own items …
        if ([...group.querySelectorAll(ITEM)].some((i) => (i as HTMLElement).tabIndex >= 0 && i.closest(COMPOSITE) === group && shown(i))) continue;
        // … or the group itself, its active descendant one of its items.
        const ad = group.getAttribute('aria-activedescendant');
        if (group.tabIndex >= 0 && group.hasAttribute('aria-activedescendant') && (!ad || group.contains(document.getElementById(ad)))) continue;
        // … or, L5.10a fixes (review A-L6: never an empty reference), a focusable listbox with nothing selected yet: no
        // aria-activedescendant at all, the listbox itself the tab stop (its arrows select the first option).
        if (group.tabIndex >= 0 && group.getAttribute('role') === 'listbox' && !group.hasAttribute('aria-activedescendant') && !group.querySelector('[aria-selected="true"]')) continue;
        // … or a focusable combobox controlling the listbox with an active descendant (the focus stays in its input).
        if (group.id && [...document.querySelectorAll('[role="combobox"][aria-activedescendant]')].some((c) => (c as HTMLElement).tabIndex >= 0 && (c.getAttribute('aria-controls') ?? '').split(/\s+/).includes(group.id) && shown(c))) continue;
        // Composites of one family (same role and class, each focusable by script) sharing one tab stop: the scenes'
        // step lists; familyWalk proves the arrows cross them.
        if (group.hasAttribute('tabindex') && typeof group.className === 'string' && group.className.trim()) {
          const family = `[role="${group.getAttribute('role')}"].${group.className.trim().split(/\s+/).join('.')}`;
          if (document.querySelector(`${family}[tabindex="0"]`)) {
            if (!stats.families.includes(family)) stats.families.push(family);
            continue;
          }
        }
      }
      out.push({ rule: 'reachable', el: desc(el), text: (el.textContent ?? '').trim().slice(0, 40), detail: `role ${el.getAttribute('role')} with no tab stop (tabIndex ${h.tabIndex}) and no composite whose own item holds one` });
    }

    // Colour-only: the status families on a mark with no state word, or on rows that differ by it alone. The token
    // names come from every rule of `:root` or of a `[data-appearance]` scope (in @media and cascade layers too); their
    // colours are resolved on the element's own scope (a dark page may hold a light column: the gallery).
    const names = new Set<string>();
    const collect = (rules: CSSRuleList) => {
      for (const r of rules) {
        if (r instanceof CSSStyleRule) {
          if (/:root|\[data-appearance/.test(r.selectorText)) for (const n of r.style) if (n.startsWith('--') && o.status.some((p) => n === p || n.startsWith(`${p}-`))) names.add(n);
        } else if ('cssRules' in r) collect((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      collect(rules);
    }
    const scopeMaps = new Map<Element, Map<string, string>>();
    const tokensFor = (el: Element): Map<string, string> => {
      const scope = el.closest('[data-appearance]') ?? document.documentElement;
      let m = scopeMaps.get(scope);
      if (!m) {
        m = new Map<string, string>();
        const st = getComputedStyle(scope);
        for (const n of names) {
          const fam = o.status.find((p) => n === p || n.startsWith(`${p}-`))!;
          const c = parse(st.getPropertyValue(n).trim());
          if (c && c[3] > 0) m.set(css(c), fam);
        }
        scopeMaps.set(scope, m);
      }
      return m;
    };
    let tokens = tokensFor(document.documentElement);
    const famOf = (v: string) => {
      const c = parse(v);
      return c && c[3] > 0.1 ? tokens.get(css(c)) : undefined;
    };
    /** The families on an element's own box (or glyph-only text), and on its ::before / ::after. */
    const hitsOf = (el: Element): { own: string[]; pseudo: string[]; all: string } => {
      tokens = tokensFor(el);
      const own = new Set<string>();
      const pseudo = new Set<string>();
      let hits = own;
      const look = (cs: CSSStyleDeclaration, glyph: boolean) => {
        const add = (f: string | undefined) => f && hits.add(f);
        add(famOf(cs.backgroundColor));
        for (const s of SIDES) if (parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0 && cs.getPropertyValue(`border-${s}-style`) !== 'none') add(famOf(cs.getPropertyValue(`border-${s}-color`)));
        if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) add(famOf(cs.outlineColor));
        for (const s of shadowsOf(cs.boxShadow)) if (s.c && s.c[3] > 0.1) add(tokens.get(css(s.c)));
        if (glyph) add(famOf(cs.color));
      };
      const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue ?? '').join('').trim();
      // An <svg> mark draws in its colour (currentColor paths: review A-L7) — a glyph, like a sign in text; inside a
      // control it is the control's icon (its words say what it does, as a badge's or a button's own words do).
      const svgMark = el.tagName.toLowerCase() === 'svg' && !el.closest('button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]');
      look(getComputedStyle(el), svgMark || (text !== '' && !/[\p{L}\p{N}]/u.test(text)));
      hits = pseudo;
      for (const which of ['::before', '::after']) {
        const pc = getComputedStyle(el, which);
        if (!pc.content || pc.content === 'none' || pc.content === 'normal' || pc.display === 'none') continue;
        const t = contentText(pc.content).trim();
        look(pc, t !== '' && !/[\p{L}\p{N}]/u.test(t));
      }
      return { own: [...own].sort(), pseudo: [...pseudo].sort(), all: [...new Set([...own, ...pseudo])].sort().join(', ') };
    };
    if (names.size > 0) {
      const hitCache = new Map<Element, ReturnType<typeof hitsOf>>();
      const hitsCached = (e: Element) => {
        let h = hitCache.get(e);
        if (!h) hitCache.set(e, (h = hitsOf(e)));
        return h;
      };
      for (const el of document.querySelectorAll('body *')) {
        if ((el.closest('svg') && el.tagName.toLowerCase() !== 'svg') || el.closest('.sr-only')) continue;
        if (!shown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) continue;
        const hits = hitsCached(el);
        if (!hits.all) continue;
        const text = visibleText(el);
        const lettered = /[\p{L}\p{N}]/u.test(text);
        if (hits.pseudo.length > 0 || !lettered) {
          // A mark (a box with no letters, a ::before / ::after): a sign says it by its shape; else a state word in its
          // own (a pseudo mark) or its row's visible text (three levels up) — never any word.
          if (!lettered && text && !DOT.test(text)) continue;
          if (lettered && hits.own.length === 0 && saysState(text)) continue;
          let carrier: Element | null = hits.own.length === 0 ? el : el.parentElement;
          let said = false;
          let words = '';
          for (let i = 0; carrier && i < 3 && !said; i++, carrier = carrier.parentElement) {
            words = visibleText(carrier);
            said = saysState(words);
            if (/[\p{L}\p{N}]/u.test(words)) break;
          }
          if (!said) out.push({ rule: 'colour-only', el: desc(el), detail: `${hits.all} on a mark with no state word${words ? ` beside it (its row says "${words.slice(0, 40)}")` : ''}` });
          continue;
        }
        // A row (of a table, a list, a listbox) that differs from its siblings by a status colour: it starts with a sign
        // or says a state word. (A badge or a button says what it is in its own words.)
        const parent = el.parentElement;
        if (!parent || !el.matches('tr, li, [role="row"], [role="option"], [role="listitem"]')) continue;
        const sig = signature(el);
        const differs = [...parent.children].some((s) => s !== el && signature(s) === sig && shown(s) && hitsCached(s).all !== hits.all);
        if (differs && !startsWithSign(text) && !saysState(text)) out.push({ rule: 'colour-only', el: desc(el), text: text.slice(0, 40), detail: `${hits.all}: differs from its siblings by colour only (no sign, no state word)` });
      }
    }
    // The status colours watched, in every appearance scope the page holds (review A-L7: not the root's alone).
    tokensFor(document.documentElement);
    for (const scope of document.querySelectorAll('[data-appearance]')) tokensFor(scope);
    stats.statusTokens = new Set([...scopeMaps.values()].flatMap((m) => [...m.keys()])).size;

    // Selected / current / pressed: more than colour against an unselected peer.
    for (const el of document.querySelectorAll('[aria-selected="true"], [aria-pressed="true"], [aria-checked="true"], [aria-current]:not([aria-current="false"]), .selected, .is-selected, .current, .is-current, .is-checked')) {
      if (!selectedState(el) || !shown(el) || el.closest('.sr-only')) continue;
      // aria-current on plain text (a breadcrumb's last crumb, after the links): its place says it, not a look.
      if (selectedState(el)!.startsWith('aria-current') && !el.matches('a[href], button, [role="link"], [role="tab"], [role="option"], [role="menuitem"], [role="treeitem"]')) continue;
      // A selected element holding the focus shows its ring too: compared once the focus has gone (the walk blurs).
      const peer = el.matches(':focus-within') ? null : peerOf(el);
      if (!peer) {
        stats.selectedAlone++;
        continue;
      }
      stats.selected++;
      if (!cueOf(el, peer, 0)) out.push({ rule: 'selected', el: desc(el), text: visibleText(el).slice(0, 40), detail: `${selectedState(el)} differs from its peer ${desc(peer)} by colour only (no weight, mark ≥ 2 px at 3:1, fill at 3:1 or marker)` });
    }

    // Headings: one level-1 heading, no level skipped downwards (hidden ones not counted).
    const visibleNow = (h: Element) => {
      const v = h as unknown as { checkVisibility?: (o: object) => boolean };
      return v.checkVisibility ? v.checkVisibility({ checkVisibilityCSS: true }) : shown(h);
    };
    const levelOf = (h: Element) => (h.matches('h1, h2, h3, h4, h5, h6') ? Number(h.tagName[1]) : Number(h.getAttribute('aria-level') ?? '2') || 2);
    const heads = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].filter(visibleNow);
    const h1 = heads.filter((h) => levelOf(h) === 1);
    if (h1.length !== 1) out.push({ rule: 'headings', el: h1.map(desc).join(' ') || 'document', detail: `${h1.length} level-1 headings (one expected)` });
    let prev = 1;
    for (const h of heads) {
      const level = levelOf(h);
      if (level > prev + 1) out.push({ rule: 'headings', el: desc(h), text: (h.textContent ?? '').trim().slice(0, 40), detail: `h${level} after h${prev}` });
      prev = level;
    }

    // Overflow: no sideways scroll.
    const se = document.scrollingElement ?? document.documentElement;
    if (se.scrollWidth > document.documentElement.clientWidth + 1) {
      const wide = [...document.querySelectorAll('body *')].filter((e) => shown(e) && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(-3).map(desc);
      out.push({ rule: 'overflow', el: 'document', detail: `scrollWidth ${se.scrollWidth} > ${document.documentElement.clientWidth} (${wide.join(', ')})` });
    }
    const main = document.querySelector('main');
    if (main && getComputedStyle(main).overflowX !== 'visible' && main.scrollWidth > main.clientWidth + 1) out.push({ rule: 'overflow', el: desc(main), detail: `main scrolls sideways: ${main.scrollWidth} > ${main.clientWidth}` });
    return { findings: out, stats };
  };

  /** A box's looks for the focus-ring verdict: its outline, shadows, borders and the colours under and around it. */
  type Looks = { outline: { w: number; style: string; c: RGBA | null; offset: number }; shadows: Shadow[]; shadowText: string; borders: Array<{ w: number; style: string; c: RGBA | null }>; bg: RGBA[] | null; around: RGBA[] | null };
  let boxes: Element[] = [];
  let focusedLooks: Looks[] = [];
  const looks = (e: Element): Looks => {
    const cs = getComputedStyle(e);
    return {
      outline: { w: parseFloat(cs.outlineWidth) || 0, style: cs.outlineStyle, c: parse(cs.outlineColor), offset: parseFloat(cs.outlineOffset) || 0 },
      shadows: shadowsOf(cs.boxShadow),
      shadowText: cs.boxShadow,
      borders: SIDES.map((s) => ({ w: parseFloat(cs.getPropertyValue(`border-${s}-width`)) || 0, style: cs.getPropertyValue(`border-${s}-style`), c: parse(cs.getPropertyValue(`border-${s}-color`)) })),
      bg: bgOf(e),
      around: bgOf(e.parentElement),
    };
  };
  /** Is the focused look a real indicator against the blurred one? The thickness of its ≥ 3:1 parts, or a ≥ 3:1 fill. */
  const ringOf = (f: Looks, b: Looks): { ok: boolean; why: string } => {
    const bg = f.bg ?? [WHITE];
    const around = f.around ?? [WHITE];
    const parts: string[] = [];
    let thick = 0;
    if (b.bg && f.bg && minRatio(f.bg, b.bg) >= 3) return { ok: true, why: 'fill' };
    const ow = f.outline.style !== 'none' && f.outline.style !== 'hidden' && f.outline.c ? f.outline.w : 0;
    const was = b.outline.style !== 'none' && b.outline.style !== 'hidden' && b.outline.c ? b.outline : null;
    if (ow > 0 && f.outline.style === 'auto' && b.outline.style !== 'auto') {
      // The browser's own ring: two colours, ≥ 2 px, visible on any background.
      parts.push('the browser ring');
      thick += Math.max(ow, 2);
    } else if (ow > 0) {
      // Drawn outside the box (offset ≥ 0): on what is around it; inside (offset ≤ −width): on the box; between: both.
      const on = f.outline.offset >= 0 ? around : f.outline.offset <= -ow ? bg : [...around, ...bg];
      const r = markRatio(f.outline.c!, on);
      const same = was && was.c && ratio(over(was.c, around[0]), over(f.outline.c!, around[0])) < 3 && was.w >= ow && was.offset === f.outline.offset;
      if (!same) {
        parts.push(`outline ${ow} px at ${round(r)}:1`);
        if (r >= 3) thick += ow - (was && was.c && markRatio(was.c, on) >= 3 && was.offset === f.outline.offset ? Math.min(was.w, ow) : 0);
      }
    }
    for (const s of f.shadows) {
      if (b.shadows.some((x) => x.c && s.c && css(x.c) === css(s.c) && x.c[3] === s.c[3] && x.x === s.x && x.y === s.y && x.blur === s.blur && x.spread === s.spread && x.inset === s.inset)) continue;
      if (!s.c) continue;
      const r = markRatio(s.c, s.inset ? bg : around);
      const k = Math.max(0, s.spread) + Math.max(Math.abs(s.x), Math.abs(s.y)) + (s.blur > 0 ? s.blur / 2 : 0);
      parts.push(`shadow ${round(k)} px at ${round(r)}:1`);
      if (r >= 3) thick += k;
    }
    let border = 0;
    f.borders.forEach((x, i) => {
      const y = b.borders[i];
      if (x.w <= 0 || x.style === 'none' || x.style === 'hidden' || !x.c) return;
      const fc = over(x.c, bg[0]);
      const bc = y.c && y.w > 0 && y.style !== 'none' ? over(y.c, bg[0]) : bg[0];
      if (css(fc) === css(bc) && x.w <= y.w) return;
      const r = Math.min(ratio(fc, bc), markRatio(x.c, bg));
      parts.push(`border ${x.w} px at ${round(r)}:1`);
      if (r >= 3) border = Math.max(border, x.w > y.w && css(fc) === css(bc) ? x.w - y.w : x.w);
    });
    thick += border;
    if (b.bg && f.bg && minRatio(f.bg, b.bg) > 1.001) parts.push(`fill ${round(minRatio(f.bg, b.bg))}:1`);
    if (thick >= 2) return { ok: true, why: parts.join(', ') };
    return { ok: false, why: parts.length ? `focus indicator too faint: ${parts.join(', ')} (needs ≥ 2 px at 3:1 or a 3:1 fill)` : 'no visible change on focus' };
  };
  const visibleBox = (e: Element) => {
    if (!shown(e) || opacityOf(e) === 0) return false;
    const r = e.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  };
  /** Is the focused element entirely covered by another element (its centre and four inner corners)? */
  const obscured = (el: Element): string | null => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return null;
    const ix = Math.min(4, r.width / 4);
    const iy = Math.min(4, r.height / 4);
    const points: Array<[number, number]> = [[(r.left + r.right) / 2, (r.top + r.bottom) / 2], [r.left + ix, r.top + iy], [r.right - ix, r.top + iy], [r.left + ix, r.bottom - iy], [r.right - ix, r.bottom - iy]];
    let cover: Element | null = null;
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
      const top = document.elementFromPoint(x, y);
      if (!top || top === el || el.contains(top) || top.contains(el) || (el as HTMLInputElement).labels?.[0]?.contains(top)) return null;
      cover = top;
    }
    return cover ? desc(cover) : null;
  };
  let seenStops = new WeakSet<Element>();
  const focusState = () => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { stop: null };
    if (seenStops.has(el)) return { stop: desc(el), repeat: true };
    seenStops.add(el);
    if (el.tagName === 'IFRAME') return { stop: desc(el), frame: true };
    boxes = [];
    if (visibleBox(el)) boxes.push(el);
    const ad = el.getAttribute('aria-activedescendant');
    const active = ad ? document.getElementById(ad) : null;
    if (active && visibleBox(active)) boxes.push(active);
    let n = 0;
    for (let e = el.parentElement; e && e !== document.body && n < 2; e = e.parentElement) {
      if (visibleBox(e)) {
        boxes.push(e);
        n++;
      }
    }
    focusedLooks = boxes.map(looks);
    // Text shown only while focused (a tooltip): its contrast now.
    const out: Found[] = [];
    const stats = { texts: 0, overMedia: 0, exempt: 0, unmeasured: [] as string[] };
    if (el.parentElement) contrastIn(el.parentElement, stats, out);
    return { stop: desc(el), text: (el.textContent ?? '').trim().slice(0, 40), boxes: boxes.map(desc), contrast: out, obscured: obscured(active ?? el) };
  };
  /** Blurs the stop and judges each box: the first real indicator wins; else the reasons. */
  const ringVerdict = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const why: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const v = ringOf(focusedLooks[i], looks(boxes[i]));
      if (v.ok) return { ok: true, why: [] as string[] };
      if (v.why !== 'no visible change on focus') why.push(`${desc(boxes[i])}: ${v.why}`);
    }
    return { ok: false, why };
  };
  /** A new walk: no stop seen yet (a WeakSet has no clear). */
  const resetStops = () => {
    seenStops = new WeakSet();
  };
  w.__a11y = {
    ratio: (a: string, b: string) => {
      const x = parse(a);
      const y = parse(b);
      return x && y ? ratio(over(x, WHITE), over(y, WHITE)) : null;
    },
    audit,
    focusState,
    ringVerdict,
    resetStops,
  };
}

declare global {
  interface Window {
    __a11y: {
      ratio(a: string, b: string): number | null;
      audit(o: { status: string[] }): { findings: Finding[]; stats: Omit<AuditStats, 'controls'> };
      focusState(): { stop: string | null; repeat?: boolean; frame?: boolean; text?: string; boxes?: string[]; contrast?: Finding[]; obscured?: string | null };
      ringVerdict(): { ok: boolean; why: string[] };
      resetStops(): void;
    };
  }
}

/** Installs the in-page half (after every full navigation; a hash route keeps it). */
export async function installA11y(page: Page): Promise<void> {
  await page.evaluate(install);
}

/** The contrast ratio the page computes for two CSS colours (the checker's own maths, for its unit test). */
export async function pageRatio(page: Page, a: string, b: string): Promise<number | null> {
  await installA11y(page);
  return page.evaluate(([x, y]) => window.__a11y.ratio(x, y), [a, b] as const);
}

interface AxValue {
  value?: unknown;
}
interface AxSource {
  type?: string;
  attribute?: string;
  value?: AxValue;
  superseded?: boolean;
}
interface AxNode {
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue & { sources?: AxSource[] };
  backendDOMNodeId?: number;
}

/** The name rule, over Chromium's accessibility tree (CDP). */
async function nameRule(page: Page): Promise<{ findings: Finding[]; controls: number }> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] };
    const findings: Finding[] = [];
    let controls = 0;
    for (const n of nodes) {
      const role = String(n.role?.value ?? '');
      if (n.ignored || !CONTROL_ROLES.includes(role)) continue;
      controls++;
      const name = String(n.name?.value ?? '').trim();
      const used = (n.name?.sources ?? []).find((s) => s.value?.value !== undefined && String(s.value.value).trim() !== '' && !s.superseded);
      const weak = used && (used.type === 'placeholder' || used.attribute === 'placeholder' || used.attribute === 'title');
      if (name && !weak) continue;
      let el = `${role} (node ${n.backendDOMNodeId ?? '?'})`;
      if (n.backendDOMNodeId !== undefined) {
        const d = (await cdp.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId }).catch(() => null)) as { node?: { nodeName?: string; attributes?: string[] } } | null;
        const attrs = d?.node?.attributes ?? [];
        const get = (k: string) => {
          const i = attrs.indexOf(k);
          return i >= 0 && i % 2 === 0 ? attrs[i + 1] : undefined;
        };
        const id = get('id');
        const testid = get('data-testid');
        const cls = get('class')?.trim().split(/\s+/).slice(0, 3).join('.');
        el = `${(d?.node?.nodeName ?? role).toLowerCase()}${id ? '#' + id : ''}${testid ? `[data-testid=${testid}]` : ''}${cls ? '.' + cls : ''}`;
      }
      findings.push({ rule: 'name', el, detail: name ? `${role} named only by its ${used?.attribute ?? used?.type} ("${name.slice(0, 30)}")` : `${role} with no name` });
    }
    return { findings, controls };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Every rule but the focus ring, on the page as it stands. */
export async function auditPage(page: Page, o: AuditOptions = {}): Promise<Audit> {
  await installA11y(page);
  const r = await page.evaluate((status) => window.__a11y.audit({ status }), o.status ?? STATUS_TOKENS);
  const tree = o.noTree ? { findings: [], controls: 0 } : await nameRule(page);
  return { findings: [...r.findings, ...tree.findings], stats: { ...r.stats, controls: tree.controls } };
}

/**
 * The focus-ring rule: Tab from the top of the document (inside an open modal dialog: its own controls) until it comes
 * back to a stop already seen; each stop must show a real indicator and not be entirely covered. Reaching `max` stops
 * without coming back is a finding (the rest of the page was never checked). Leaves nothing focused.
 */
export async function tabWalk(page: Page, o: { max?: number } = {}): Promise<TabWalk> {
  await installA11y(page);
  // A fresh walk from the top of the document.
  await page.evaluate(() => {
    window.__a11y.resetStops();
    (document.activeElement as HTMLElement | null)?.blur();
    // (L5.9: the centre pane scrolls, not the window.)
    document.getElementById('main')?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  const findings: Finding[] = [];
  let stops = 0;
  let frames = 0;
  let empty = 0;
  let done = false;
  const max = o.max ?? WALK_MAX;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => window.__a11y.focusState());
    if (s.stop === null) {
      if (++empty > 1) {
        done = true;
        break;
      }
      continue;
    }
    if (s.repeat) {
      done = true;
      break;
    }
    stops++;
    if (s.frame) {
      frames++;
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      continue;
    }
    for (const f of s.contrast ?? []) if (!findings.some((x) => x.el === f.el && x.text === f.text)) findings.push(f);
    if (s.obscured) findings.push({ rule: 'focus-ring', el: s.stop, text: s.text, detail: `entirely covered by ${s.obscured} when focused` });
    const v = await page.evaluate(() => window.__a11y.ringVerdict());
    if (!v.ok) findings.push({ rule: 'focus-ring', el: s.stop, text: s.text, detail: v.why.length ? v.why.join('; ') : (s.boxes ?? []).length ? `no visible change on focus (boxes: ${(s.boxes ?? []).join(', ')})` : 'no visible box to draw a ring on' });
  }
  if (!done) findings.push({ rule: 'walk', el: 'document', detail: `Tab walk truncated at ${max} stops: it never came back to its first stop (raise the station's cap)` });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return { stops, frames, findings };
}

/**
 * A family of composites sharing one tab stop (`family`: a selector from `stats.families`): from its tab stop, ArrowDown
 * must take the focus (or the active descendant) into every group of the family. Changes the selection (the arrows'
 * own job); leaves nothing focused.
 */
export async function familyWalk(page: Page, family: string): Promise<Finding[]> {
  const groups = await page.locator(family).count();
  const items = await page.locator(`${family} [role]`).count();
  await page.locator(`${family}[tabindex="0"]`).first().focus();
  const visited = new Set<number>();
  for (let i = 0; i < items + groups + 2; i++) {
    visited.add(
      await page.evaluate((f) => {
        const a = document.activeElement;
        const ad = a?.getAttribute('aria-activedescendant');
        const at = (ad && document.getElementById(ad)) || a;
        return [...document.querySelectorAll(f)].findIndex((g) => g === at || g.contains(at));
      }, family),
    );
    if (visited.size >= groups + (visited.has(-1) ? 1 : 0)) break;
    await page.keyboard.press('ArrowDown');
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const missed = [...Array(groups).keys()].filter((k) => !visited.has(k));
  return missed.length ? [{ rule: 'reachable', el: family, detail: `the shared tab stop's arrows never reach group${missed.length > 1 ? 's' : ''} ${missed.map((k) => k + 1).join(', ')} of ${groups}` }] : [];
}

/** A native dialog's keyboard contract: opened from `opener`, it is modal and focus is inside it; Escape closes it; focus is back on the opener. */
export async function dialogCheck(page: Page, opener: Locator, open: () => Promise<void>): Promise<string[]> {
  const problems: string[] = [];
  await opener.focus();
  await open();
  await page.locator('dialog[open]').first().waitFor({ timeout: 15_000 });
  if (!(await page.evaluate(() => [...document.querySelectorAll('dialog[open]')].some((d) => d.matches(':modal'))))) problems.push('the dialog is not modal (show(), not showModal(): the page behind stays live)');
  if (!(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog[open]'))))) problems.push('focus is not inside the open dialog');
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 3_000 }).catch(async () => {
    if ((await page.locator('dialog[open]').count()) > 0) problems.push('Escape did not close the dialog');
  });
  if (!(await opener.evaluate((el) => el === document.activeElement))) problems.push(`focus did not return to the opener (it is on ${await page.evaluate(() => document.activeElement?.tagName ?? 'nothing')})`);
  return problems;
}

/** What still says it is loading: the app's busy markers and its `<Loading>` messages (a status starting "Loading"); `toured`: a busy state the tour holds on purpose. */
function stillLoading(toured: string | null): string[] {
  const busy = [...document.querySelectorAll('[aria-busy="true"], [data-loading="yes"]')].filter((e) => !toured || !e.matches(toured));
  const loading = [...document.querySelectorAll('[role="status"]')].filter((e) => /^\s*Loading\b/.test(e.textContent ?? ''));
  return [...busy, ...loading].map((e) => `${e.tagName.toLowerCase()}${e.getAttribute('data-testid') ? `[data-testid=${e.getAttribute('data-testid')}]` : ''} "${(e.textContent ?? '').trim().slice(0, 40)}"`);
}

/**
 * Nothing busy or loading on the page, then a frame painted. Waits up to `timeout` ms; returns what was still loading
 * then (the caller makes it a finding: an audit of a half-loaded screen is not an audit). `toured`: the selector of a
 * busy element the tour holds on purpose (L5.9, review A-L2: the steps while a write is in flight) — not waited for.
 */
export async function settle(page: Page, timeout = 30_000, toured: string | null = null): Promise<string[]> {
  const until = Date.now() + timeout;
  let left = await page.evaluate(stillLoading, toured);
  while (left.length > 0 && Date.now() < until) {
    await page.waitForTimeout(100);
    left = await page.evaluate(stillLoading, toured);
  }
  // L5.9 (critique M3): the bundled fonts swap in once loaded — measure the page in them, not in the fallback.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return left;
}

/** Findings as lines a failing test prints. */
export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `[${f.rule}] ${f.el}${f.text ? ` "${f.text}"` : ''}: ${f.detail}`).join('\n');
}
