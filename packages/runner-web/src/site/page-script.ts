/**
 * What a site extraction reads of the page (L3.5), run in a CDP isolated world (the page's own scripts cannot replace
 * `getComputedStyle`, `elementFromPoint` or the canvas used to normalise colours there). The functions are serialised
 * with `Function.prototype.toString`: self-contained, no import, no closure.
 */

export interface SampledColors {
  /** Painted background at grid points of the viewport: normalised `#rrggbb` → points. */
  background: Record<string, number>;
  /** Text colour weighted by characters. */
  text: Record<string, number>;
  /** Backgrounds, borders and text of links, buttons and `[role=button]`, weighted by area / characters. */
  interactive: Record<string, number>;
  /** Backgrounds of large blocks (sections, header, footer) by area. */
  sections: Record<string, number>;
  /** Points over an image, a video or a canvas (not counted). */
  media_points: number;
  points: number;
}

/** Colours of the viewport as it is scrolled now (the caller scrolls). */
export function sampleColors(cfg: { step: number }): SampledColors {
  const out: SampledColors = { background: {}, text: {}, interactive: {}, sections: {}, media_points: 0, points: 0 };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const hexOf = (c: string): { hex: string; alpha: number } | null => {
    if (!ctx || !c || c === 'transparent') return null;
    ctx.fillStyle = '#000000';
    ctx.fillStyle = c;
    const v = String(ctx.fillStyle);
    if (/^#[0-9a-f]{6}$/i.test(v)) return { hex: v.toLowerCase(), alpha: 1 };
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(v);
    if (!m) return null;
    const hex = `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
    return { hex, alpha: m[4] === undefined ? 1 : Number(m[4]) };
  };
  const add = (rec: Record<string, number>, hex: string, w: number) => {
    if (w > 0) rec[hex] = (rec[hex] ?? 0) + w;
  };
  const visible = (el: Element): boolean => {
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const W = innerWidth;
  const H = innerHeight;
  const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED']);
  const rootBg = (): string => {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const c = hexOf(getComputedStyle(el).backgroundColor);
      if (c && c.alpha >= 0.5) return c.hex;
    }
    return '#ffffff';
  };
  const canvasBg = rootBg();
  // Painted background at grid points: the first ancestor with an opaque enough background.
  for (let y = Math.floor(cfg.step / 2); y < H; y += cfg.step) {
    for (let x = Math.floor(cfg.step / 2); x < W; x += cfg.step) {
      out.points++;
      let el = document.elementFromPoint(x, y);
      if (el && MEDIA.has(el.tagName)) {
        out.media_points++;
        continue;
      }
      let hex: string | null = null;
      while (el) {
        const c = hexOf(getComputedStyle(el).backgroundColor);
        if (c && c.alpha >= 0.5) {
          hex = c.hex;
          break;
        }
        if (getComputedStyle(el).backgroundImage !== 'none' && el !== document.documentElement && el !== document.body) {
          hex = null;
          out.media_points++;
          break;
        }
        el = el.parentElement;
      }
      if (el === null) hex = canvasBg;
      if (hex) add(out.background, hex, 1);
    }
  }
  // Text colours of the text in view, by characters.
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = walker.nextNode(); t && n < 5000; t = walker.nextNode()) {
    const text = (t.textContent ?? '').trim();
    const el = t.parentElement;
    if (!text || !el || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > H || r.width < 1 || r.height < 1) continue;
    n++;
    const c = hexOf(getComputedStyle(el).color);
    if (c && c.alpha >= 0.5) add(out.text, c.hex, Math.min(200, text.length));
  }
  // Links, buttons: their fills, borders and text.
  for (const el of Array.from(document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button]')).slice(0, 400)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > H || r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    const bg = hexOf(s.backgroundColor);
    if (bg && bg.alpha >= 0.5) add(out.interactive, bg.hex, Math.round((r.width * r.height) / 100));
    const bw = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
    const bc = hexOf(s.borderTopColor);
    if (bw >= 1 && bc && bc.alpha >= 0.5) add(out.interactive, bc.hex, Math.round(((r.width + r.height) * bw) / 50));
    const tc = hexOf(s.color);
    const len = Math.min(60, (el.textContent ?? '').trim().length);
    if (tc && tc.alpha >= 0.5 && len) add(out.interactive, tc.hex, len);
  }
  // Large blocks: header, footer, sections.
  for (const el of Array.from(document.querySelectorAll('header, footer, section, nav, main, aside, [role=banner], [role=contentinfo], body > div')).slice(0, 300)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < W * 0.5 || r.height < 40) continue;
    const c = hexOf(getComputedStyle(el).backgroundColor);
    if (c && c.alpha >= 0.5) add(out.sections, c.hex, Math.round((r.width * Math.min(r.height, 2 * H)) / 1000));
  }
  return out;
}

export interface PageFacts {
  title: string;
  description: string;
  site_name: string;
  lang: string;
  /** First family of the computed font-family, per role, with how many elements use it. */
  fonts: { display: Record<string, number>; body: Record<string, number> };
  /** document.fonts faces: names only. */
  faces: Array<{ family: string; weight: string; style: string; status: string }>;
  candidates: LogoCandidate[];
  scroll_height: number;
}

export type LogoCandidate =
  | { kind: 'img'; url: string; alt: string; width: number; height: number; score: number; where: string }
  | { kind: 'svg'; markup: string; alt: string; width: number; height: number; score: number; where: string }
  | { kind: 'icon' | 'og'; url: string; alt: string; width: number; height: number; score: number; where: string };

/**
 * Title, description, fonts and logo candidates (the caller rasterises them, never in this page). Every string the page
 * controls is cut to a size here (family names 200, a candidate URL `urlMax`, a data: URL `dataUrlMax`): what comes
 * back over CDP stays small whatever the page holds.
 */
export function readFacts(cfg: { maxCandidates: number; svgMax: number; urlMax: number; dataUrlMax: number }): PageFacts {
  const meta = (sel: string) => (document.querySelector(sel)?.getAttribute('content') ?? '').trim();
  const firstFamily = (f: string) =>
    (String(f).slice(0, 2000).split(',')[0] ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .slice(0, 200);
  const fonts = { display: {} as Record<string, number>, body: {} as Record<string, number> };
  const visible = (el: Element): boolean => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  for (const [role, sel] of [
    ['display', 'h1, h2, h3'],
    ['body', 'p, li'],
  ] as const) {
    let n = 0;
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (n >= 200) break;
      if (!(el.textContent ?? '').trim() || !visible(el)) continue;
      n++;
      const fam = firstFamily(getComputedStyle(el).fontFamily);
      if (fam) fonts[role][fam] = (fonts[role][fam] ?? 0) + 1;
    }
  }
  const faces = Array.from(document.fonts ?? [])
    .slice(0, 40)
    .map((f) => ({ family: firstFamily(f.family), weight: String(f.weight).slice(0, 40), style: String(f.style).slice(0, 40), status: String(f.status).slice(0, 20) }));
  const here = location.href;
  const abs = (u: string | null) => {
    try {
      const href = u ? new URL(u, here).href : '';
      return href.length <= (href.startsWith('data:') ? cfg.dataUrlMax : cfg.urlMax) ? href : '';
    } catch {
      return '';
    }
  };
  const label = (el: Element) =>
    [el.id, el.getAttribute('class'), el.getAttribute('alt'), el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('src'), el.closest('a')?.getAttribute('aria-label')].join(' ');
  const toRoot = (el: Element) => {
    const a = el.closest('a[href]');
    if (!a) return false;
    try {
      const u = new URL(a.getAttribute('href') ?? '', here);
      return u.origin === location.origin && (u.pathname === '/' || u.pathname === '');
    } catch {
      return false;
    }
  };
  const seen = new Set<Element>();
  const cands: LogoCandidate[] = [];
  const inline = (svg: SVGSVGElement): string => {
    // A standalone copy: computed paint inlined (page CSS and currentColor do not follow it), <use> targets copied in.
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const src = [svg, ...Array.from(svg.querySelectorAll('*'))];
    const dst = [clone, ...Array.from(clone.querySelectorAll('*'))];
    src.forEach((el, i) => {
      const d = dst[i];
      if (!d) return;
      const s = getComputedStyle(el);
      for (const p of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'color', 'font-family', 'font-size', 'font-weight']) {
        const v = s.getPropertyValue(p);
        if (v) d.setAttribute(p, v);
      }
    });
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    for (const u of Array.from(svg.querySelectorAll('use'))) {
      const ref = u.getAttribute('href') ?? u.getAttribute('xlink:href') ?? '';
      if (!ref.startsWith('#')) continue;
      const target = document.getElementById(ref.slice(1));
      if (target && !svg.contains(target)) defs.appendChild(target.cloneNode(true));
    }
    if (defs.childNodes.length) clone.insertBefore(defs, clone.firstChild);
    const r = svg.getBoundingClientRect();
    if (!clone.getAttribute('viewBox') && r.width && r.height) clone.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(clone);
  };
  const consider = (el: Element, where: string, base: number) => {
    const target = el.tagName.toLowerCase() === 'picture' ? el.querySelector('img') : el;
    if (!target || seen.has(target) || !visible(target)) return;
    const r = target.getBoundingClientRect();
    if (r.width < 16 || r.height < 12 || r.top > innerHeight * 2) return;
    seen.add(target);
    const text = label(target).toLowerCase();
    const score = base + (/logo|brand|wordmark/.test(text) ? 3 : 0) + (toRoot(target) ? 2 : 0) + (r.top < innerHeight / 3 ? 1 : 0);
    const alt = (target.getAttribute('alt') ?? target.getAttribute('aria-label') ?? target.querySelector('title')?.textContent ?? '').trim().slice(0, 300);
    if (target instanceof SVGSVGElement) {
      const markup = inline(target);
      if (markup.length <= cfg.svgMax) cands.push({ kind: 'svg', markup, alt, width: Math.round(r.width), height: Math.round(r.height), score, where });
    } else if (target instanceof HTMLImageElement) {
      const url = abs(target.currentSrc || target.getAttribute('src'));
      if (url.startsWith('https:') || url.startsWith('data:image/')) cands.push({ kind: 'img', url, alt, width: Math.round(r.width), height: Math.round(r.height), score, where });
    }
  };
  for (const scope of Array.from(document.querySelectorAll('header, nav, [role=banner]'))) {
    for (const el of Array.from(scope.querySelectorAll('img, svg, picture')).slice(0, 40)) {
      if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) continue;
      consider(el, 'header', 2);
    }
  }
  for (const el of Array.from(document.querySelectorAll('img, svg')).slice(0, 400)) {
    if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) continue;
    if (/logo|brand|wordmark/i.test(label(el)) || toRoot(el)) consider(el, 'page', 0);
  }
  const icons = Array.from(document.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i], link[rel~="mask-icon" i]'));
  for (const l of icons.slice(0, 6)) {
    const url = abs(l.getAttribute('href'));
    const size = /(\d+)x(\d+)/.exec(l.getAttribute('sizes') ?? '');
    if (url.startsWith('https:') || url.startsWith('data:image/'))
      cands.push({
        kind: 'icon',
        url,
        alt: '',
        width: size ? Number(size[1]) : 0,
        height: size ? Number(size[2]) : 0,
        score: -1 + (size ? Math.min(2, Number(size[2]) / 128) : 0),
        where: (l.getAttribute('rel') ?? 'icon').toLowerCase().slice(0, 40),
      });
  }
  const og = abs(meta('meta[property="og:image" i]') || meta('meta[name="og:image" i]'));
  if (og.startsWith('https:')) cands.push({ kind: 'og', url: og, alt: '', width: 0, height: 0, score: -3, where: 'og:image' });
  const seenUrl = new Set<string>();
  const ranked = cands
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i)
    .map((x) => x.c)
    .filter((c) => {
      const key = c.kind === 'svg' ? c.markup : c.url;
      if (seenUrl.has(key)) return false;
      seenUrl.add(key);
      return true;
    });
  return {
    title: (document.title ?? '').trim().slice(0, 2000),
    description: (meta('meta[name="description" i]') || meta('meta[property="og:description" i]')).slice(0, 2000),
    site_name: meta('meta[property="og:site_name" i]').slice(0, 300),
    lang: (document.documentElement.getAttribute('lang') ?? '').slice(0, 20),
    fonts,
    faces,
    candidates: ranked.slice(0, cfg.maxCandidates * 2),
    scroll_height: Math.round(document.scrollingElement?.scrollHeight ?? 0),
  };
}

export function scrollToY(y: number): number {
  window.scrollTo(0, y);
  return Math.round(window.scrollY);
}
