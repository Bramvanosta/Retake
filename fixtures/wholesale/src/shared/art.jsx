// Product "photos" drawn in CSS + SVG (no external images): a coffee bag on a coloured backdrop
// with scattered roasted beans, deterministic per product. Plus small CSS flags for markets.

import { useId } from 'react';
import { Icon } from './icons.jsx';

/** c1 light → c2 deep backdrop, c3 glow; bag & label colours. */
const PALETTES = {
  apricot: { c1: '#f8dcbc', c2: '#d98a5c', c3: '#b2503a', bag: '#f4ece1', bagShade: '#d9c9b6', label: '#6e1f2b', ink: '#f6e7d8' },
  berry: { c1: '#f3cbd3', c2: '#a83a55', c3: '#5e1428', bag: '#2e1e1d', bagShade: '#1b1110', label: '#f0d5c2', ink: '#5e1428' },
  lemon: { c1: '#f9eeb9', c2: '#e2b24f', c3: '#a26c12', bag: '#fbf6ea', bagShade: '#e4d8c0', label: '#2f5a3e', ink: '#f3ead2' },
  rose: { c1: '#f7d7d3', c2: '#d0817f', c3: '#8a2f3d', bag: '#fff8f2', bagShade: '#ead8cc', label: '#8a2f3d', ink: '#fbe7e2' },
  caramel: { c1: '#f2dfc5', c2: '#bb7d4d', c3: '#6d3f1f', bag: '#d9b88f', bagShade: '#b8946a', label: '#3b2a20', ink: '#efdcc4' },
  plum: { c1: '#ead5e6', c2: '#8f4c79', c3: '#4c1d40', bag: '#f6efe9', bagShade: '#e0d2c8', label: '#4c1d40', ink: '#f0dcea' },
  violet: { c1: '#e1d8f3', c2: '#7460ab', c3: '#3b2a6b', bag: '#221c31', bagShade: '#14101e', label: '#e9e1ff', ink: '#3b2a6b' },
  mango: { c1: '#fde4b6', c2: '#f09d45', c3: '#b1501a', bag: '#fff7ea', bagShade: '#ecdcc4', label: '#1f5f5b', ink: '#dff1ee' },
  cherry: { c1: '#f7d3c8', c2: '#c64c3e', c3: '#7d1f1a', bag: '#faf3ec', bagShade: '#e6d6c7', label: '#7d1f1a', ink: '#f8e2dc' },
  cocoa: { c1: '#ead8c9', c2: '#8e5d3f', c3: '#4a2c1d', bag: '#2b1d17', bagShade: '#1a110d', label: '#ead8c9', ink: '#4a2c1d' },
  forest: { c1: '#dbe8d6', c2: '#60825c', c3: '#2f4a2e', bag: '#f4f0e6', bagShade: '#dcd5c3', label: '#2f4a2e', ink: '#e1ecdc' },
};

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let s = seed || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909);
    s ^= s >>> 16;
    return (s >>> 0) / 4294967296;
  };
}

/** Beans spread over the whole frame (the "close-up" shot). */
function scatter(seed, count) {
  const r = rng(seed);
  const out = [];
  const cols = Math.ceil(Math.sqrt(count * 1.4));
  const rows = Math.ceil(count / cols);
  for (let i = 0; i < count; i++) {
    const cx = ((i % cols) + 0.5) * (400 / cols);
    const cy = (Math.floor(i / cols) + 0.5) * (300 / rows);
    out.push({ x: cx + (r() - 0.5) * 40, y: cy + (r() - 0.5) * 34, rot: Math.round(r() * 180), s: 1.5 + r() * 0.6 });
  }
  return out;
}

/** Bean spots around the bag (never under it). */
function beans(seed, count) {
  const r = rng(seed);
  const spots = [
    [70, 236], [104, 262], [300, 248], [334, 228], [262, 276], [140, 280], [58, 270], [352, 268], [312, 280],
  ];
  const out = [];
  for (let i = 0; i < count; i++) {
    const [x, y] = spots[(i + Math.floor(r() * spots.length)) % spots.length];
    out.push({ x: x + (r() - 0.5) * 18, y: y + (r() - 0.5) * 10, rot: Math.round(r() * 180), s: 0.85 + r() * 0.35 });
  }
  return out;
}

const VIEWBOX = { bag: '0 0 400 300', crop: '92 44 216 216', beans: '0 0 400 300' };

/**
 * @param {{ palette?: string, seed?: string, badge?: string|null, className?: string, style?: object,
 *   beansCount?: number, variant?: 'bag'|'crop'|'beans', label?: string }} props
 *   variant: "bag" = packshot (default), "crop" = square close-up of the bag (thumbnails), "beans" = roasted beans only.
 *   label: accessible name (role=img); without it the art is decorative (aria-hidden).
 */
export function CoffeeArt({ palette = 'apricot', seed = '', badge, className = '', style, beansCount = 6, variant = 'bag', label }) {
  const p = PALETTES[palette] ?? PALETTES.apricot;
  const id = useId().replace(/:/g, '');
  const tilt = ((hash(seed) % 7) - 3) * 0.8;
  const spots = variant === 'beans' ? scatter(hash(seed), Math.max(beansCount, 12)) : beans(hash(seed), beansCount);
  return (
    <div
      className={`art ${className}`}
      style={{ '--c1': p.c1, '--c2': p.c2, '--c3': p.c3, ...style }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <svg viewBox={VIEWBOX[variant] ?? VIEWBOX.bag} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-bag`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={p.bag} />
            <stop offset="0.55" stopColor={p.bag} />
            <stop offset="1" stopColor={p.bagShade} />
          </linearGradient>
          <linearGradient id={`${id}-bean`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#7a4a2e" />
            <stop offset="1" stopColor="#3a1f13" />
          </linearGradient>
          <filter id={`${id}-blur`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>
        {variant === 'beans' ? null : (
          <ellipse cx="200" cy="268" rx="86" ry="11" fill="rgba(30,14,10,.32)" filter={`url(#${id}-blur)`} />
        )}
        <g transform={`rotate(${tilt} 200 160)`} display={variant === 'beans' ? 'none' : undefined}>
          <path d="M141 72h118l9 178a12 12 0 0 1-12 12H144a12 12 0 0 1-12-12z" fill={`url(#${id}-bag)`} />
          <path d="M141 72h118l1.6 32H139.4z" fill={p.bagShade} opacity="0.55" />
          <rect x="139" y="52" width="122" height="24" rx="3" fill={p.bagShade} />
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
            <path key={i} d={`M${147 + i * 10.6} 55v18`} stroke={p.bag} strokeOpacity="0.35" strokeWidth="1.2" />
          ))}
          <circle cx="200" cy="96" r="6.5" fill={p.bagShade} />
          <circle cx="200" cy="96" r="2.6" fill={p.bag} />
          <rect x="153" y="126" width="94" height="104" rx="7" fill={p.label} />
          <rect x="159" y="132" width="82" height="92" rx="4" fill="none" stroke={p.ink} strokeOpacity="0.45" />
          <g transform="translate(200 160)">
            <ellipse rx="10" ry="14" transform="rotate(30)" fill="none" stroke={p.ink} strokeWidth="2.2" />
            <path d="M4 -11c-6 5-2 10-5 15-1.5 2.6-3.5 3.3-4.5 6" fill="none" stroke={p.ink} strokeWidth="2" strokeLinecap="round" />
          </g>
          <rect x="172" y="186" width="56" height="5" rx="2.5" fill={p.ink} opacity="0.85" />
          <rect x="180" y="197" width="40" height="3.5" rx="1.75" fill={p.ink} opacity="0.55" />
          <rect x="186" y="206" width="28" height="3.5" rx="1.75" fill={p.ink} opacity="0.4" />
          <path d="M141 72 132 250" stroke="#fff" strokeOpacity="0.28" strokeWidth="3" />
        </g>
        {spots.map((b, i) => (
          <g key={i} transform={`translate(${b.x} ${b.y}) rotate(${b.rot}) scale(${b.s})`}>
            <ellipse rx="9" ry="12.5" fill={`url(#${id}-bean)`} />
            <path d="M2.5 -10c-5 4-1 8.5-4 13-1.3 2-2.6 2.6-3.4 4" fill="none" stroke="#24120a" strokeWidth="1.8" strokeLinecap="round" />
            <ellipse rx="9" ry="12.5" fill="none" stroke="#fff" strokeOpacity="0.12" />
          </g>
        ))}
      </svg>
      {badge ? (
        <span className="art-badge">
          <Icon name="award" size={14} strokeWidth={2} />
          {badge}
        </span>
      ) : null}
    </div>
  );
}

// ── Flags ────────────────────────────────────────────────────────────────────

const band = (dir, from, to, color) => `linear-gradient(${dir}, transparent ${from}%, ${color} ${from}%, ${color} ${to}%, transparent ${to}%)`;
const nordic = (bg, cross, inner) =>
  [
    inner && band('to right', 32.5, 43.5, inner),
    inner && band('to bottom', 43, 57, inner),
    band('to right', 28, 48, cross),
    band('to bottom', 36, 64, cross),
    bg,
  ]
    .filter(Boolean)
    .join(', ');
const h3 = (a, b, c) => `linear-gradient(to bottom, ${a} 0 33.4%, ${b} 33.4% 66.7%, ${c} 66.7%)`;
const v3 = (a, b, c) => `linear-gradient(to right, ${a} 0 33.4%, ${b} 33.4% 66.7%, ${c} 66.7%)`;

const FLAGS = {
  IS: nordic('#02529c', '#ffffff', '#dc1e35'),
  SE: nordic('#006aa7', '#fecc00'),
  NO: nordic('#ba0c2f', '#ffffff', '#00205b'),
  DK: nordic('#c8102e', '#ffffff'),
  FI: nordic('#ffffff', '#002f6c'),
  EE: h3('#0072ce', '#111111', '#ffffff'),
  LV: 'linear-gradient(to bottom, #9e3039 0 40%, #ffffff 40% 60%, #9e3039 60%)',
  LT: h3('#fdb913', '#006a44', '#c1272d'),
  DE: h3('#111111', '#dd0000', '#ffce00'),
  FR: v3('#002395', '#ffffff', '#ed2939'),
  NL: h3('#ae1c28', '#ffffff', '#21468b'),
  BE: v3('#111111', '#fdda24', '#ef3340'),
  AT: h3('#ed2939', '#ffffff', '#ed2939'),
  CH: 'linear-gradient(#fff,#fff) center / 3px 9px no-repeat, linear-gradient(#fff,#fff) center / 9px 3px no-repeat, #d52b1e',
  PL: 'linear-gradient(to bottom, #ffffff 0 50%, #dc143c 50%)',
  IE: v3('#169b62', '#ffffff', '#ff883e'),
};

export function Flag({ code, title }) {
  return <span className="flag" style={{ background: FLAGS[code] ?? '#ddd' }} title={title} aria-hidden="true" />;
}

export const COUNTRY_CODES = {
  Iceland: 'IS',
  Sweden: 'SE',
  Norway: 'NO',
  Denmark: 'DK',
  Finland: 'FI',
  Estonia: 'EE',
  Latvia: 'LV',
  Lithuania: 'LT',
  Germany: 'DE',
  France: 'FR',
  Netherlands: 'NL',
  Belgium: 'BE',
  Austria: 'AT',
  Switzerland: 'CH',
  Poland: 'PL',
  Ireland: 'IE',
};
