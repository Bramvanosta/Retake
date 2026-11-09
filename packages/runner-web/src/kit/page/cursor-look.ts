/** The cursor's look: its icons (arrow, hand, I-beam) and the overlay's style sheet and markup. */
import { config } from './config.js';

// ───────────────────────────── cursor overlay ─────────────────────────────
const S = Math.max(12, config.cursor.size || 26);
const k = S / 24;
const light = config.cursor.style === 'arrow-light';
const debug = config.cursor.style === 'debug';
const arrowFill = light ? '#fff' : '#111';
const arrowStroke = light ? '#111' : '#fff';
const svg = (cls: string, hx: number, hy: number, body: string) =>
  `<svg class="${cls}" width="${S}" height="${S}" viewBox="0 0 24 24" style="left:${-hx * k}px;top:${-hy * k}px">${body}</svg>`;
const arrowSvg = svg(
  'arrow',
  4,
  2,
  `<path d="M4 2 L4 19 L8.5 14.8 L11.6 21.6 L14.6 20.3 L11.6 13.6 L17.8 13.6 Z" fill="${arrowFill}" stroke="${arrowStroke}" stroke-width="1.4" stroke-linejoin="round"/>`,
);
const fingers: Array<[number, number, number, number, number]> = [
  [9.6, 3.0, 9.6, 13.0, 2.8],
  [12.35, 9.5, 12.35, 14.0, 2.7],
  [15.0, 10.4, 15.0, 14.5, 2.6],
  [17.5, 11.6, 17.5, 15.0, 2.4],
  [8.7, 17.4, 5.7, 14.2, 2.6],
];
const palm = 'M8.25 12.2 H18.7 V16.6 C18.7 19.7 16.7 21.7 13.7 21.7 H12.6 C10.9 21.7 9.8 21 8.9 19.8 L8.25 18.9 Z';
const capsules = (color: string, extra: number) =>
  fingers
    .map(([x1, y1, x2, y2, wd]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${wd + extra}" stroke-linecap="round"/>`)
    .join('');
const handSvg = svg(
  'hand',
  9.6,
  1.9,
  `${capsules('#111', 2.2)}<path d="${palm}" fill="#111" stroke="#111" stroke-width="2.2" stroke-linejoin="round"/>` +
    `${capsules('#fff', 0)}<path d="${palm}" fill="#fff"/>` +
    `<path d="M11 11.9 V13.8 M13.68 12.3 V14.3 M16.25 12.9 V14.6" stroke="#111" stroke-width=".7" stroke-linecap="round"/>`,
);
const ibeamPath = 'M9.6 4.6 C11 4.6 12 5.1 12 6.4 C12 5.1 13 4.6 14.4 4.6 M12 6.4 V17.6 M9.6 19.4 C11 19.4 12 18.9 12 17.6 C12 18.9 13 19.4 14.4 19.4 M10.4 12 H13.6';
const ibeamSvg = svg(
  'ibeam',
  12,
  12,
  `<path d="${ibeamPath}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="${ibeamPath}" fill="none" stroke="#111" stroke-width="1.3" stroke-linecap="round"/>`,
);
/** The overlay's look (also handed to the raw export's cursor layer, L2.13: `api.cursorLook`). */
export const lookCss = `
    :host{all:initial}
    .c{position:absolute;left:0;top:0;display:none;will-change:transform}
    .c.on{display:block}
    .s{position:absolute;left:0;top:0;transform-origin:0 0;transition:transform 90ms ease-out}
    .s.p{transform:scale(.9)}
    .c svg{position:absolute;display:none;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
    .c[data-k=arrow] svg.arrow,.c[data-k=hand] svg.hand,.c[data-k=ibeam] svg.ibeam{display:block}
    .dbg{position:absolute;left:-3px;top:-3px;width:6px;height:6px;background:#FF00FF}
    .rp{position:absolute;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;
        background:${config.cursor.ripple_color};pointer-events:none;
        box-shadow:0 0 0 1.1px rgba(255,255,255,.95),0 0 0 2px rgba(17,17,17,.3);
        animation:dsr-t 500ms cubic-bezier(.2,.7,.2,1) forwards,dsr-o 550ms ease-out forwards}
    @keyframes dsr-t{from{transform:var(--p) scale(.4)}to{transform:var(--p) scale(5.5)}}
    @keyframes dsr-o{from{opacity:1}to{opacity:0}}
    .g{position:absolute;left:0;top:0;display:flex;align-items:center;gap:12px;padding:10px 16px 10px 10px;
       background:#fff;border:1px solid rgba(31,20,19,.12);border-radius:12px;
       box-shadow:0 16px 36px rgba(31,20,19,.22),0 2px 6px rgba(31,20,19,.08);
       font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;
       opacity:0;transition:opacity .25s ease-out;white-space:nowrap;transform-origin:30px 22px}
    .g.on{opacity:1}
    .g .b{position:relative;width:36px;height:44px;flex:none}
    .g .b svg{display:block}
    .g .b span{position:absolute;left:0;right:0;bottom:6px;text-align:center;color:#fff;font-size:10px;font-weight:700;letter-spacing:.02em}
    .g .n{font-size:15px;font-weight:600;color:#1f1413;line-height:1.25}
    .g .d{font-size:12px;color:#6b605d;line-height:1.3;margin-top:2px}
  `;
export const lookHtml =
  `<div class="rps"></div><div class="g"></div>` +
  `<div class="c" data-k="arrow"><div class="s">${arrowSvg}${handSvg}${ibeamSvg}</div>${debug ? '<div class="dbg"></div>' : ''}</div>`;
// Raw capture without the cursor (L2.13): the pointer, its icon, presses and ripples keep working and are reported,
// nothing of them is drawn (the file-drag ghost card stays: it is the page's content being dragged).
export const css = lookCss + (config.cursor.hidden ? '.c,.rps{display:none!important}' : '');
