/**
 * A design-token file read for a theme draft (R-FLD-47: template_from_tokens / `retake theme from-tokens`). Pure: the
 * text in, its colour and font-family tokens out, and a proposed role for each of the theme's colours. Nothing here is
 * written anywhere; the engine reads the file (brand/tokens.ts) and drafts the brand input.
 *
 * Two formats:
 * - a list — `{<group>: {tokens: [{name, value, …}]}}` and/or a top-level `tokens: [...]` (a token named `<group>.<name>`);
 * - DTCG (W3C design tokens) — nested groups, a token being an object with `$value`, its `$type` its own or the nearest
 *   group's; an alias `{group.token}` resolved (at most ALIAS_MAX_HOPS hops; a cycle or a longer chain refuses the file).
 * Colours: `#rgb`, `#rrggbb`, `#rrggbbaa` (an alpha other than ff skipped, counted), DTCG's `{colorSpace: "srgb",
 * components: [r, g, b]}`; anything else (rgb(), hsl(), oklch…) skipped and counted. Font families: `$type: fontFamily`,
 * a typography token's `fontFamily`, a list token whose name says font or family.
 *
 * Caps: TOKENS_MAX_CHARS of text, TOKENS_MAX_DEPTH levels (checked while walking, which is iterative), TOKENS_MAX
 * tokens. The parse is JSON.parse (own data properties: `__proto__` is a plain name), read with Object.entries, never
 * merged into another object. Token names and font families are the file's text: the engine keeps them under
 * `untrusted`; the errors here name tokens by index only.
 */

export const TOKENS_MAX_CHARS = 1024 * 1024;
export const TOKENS_MAX_DEPTH = 64;
export const TOKENS_MAX = 5000;
export const ALIAS_MAX_HOPS = 16;

export const TOKEN_ROLES = ['accent', 'paper', 'text', 'muted', 'dark'] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

export interface TokenColour {
  /** Its position among the file's colours (what the answer names it by). */
  index: number;
  /** The token's name: its path, `.` between parts (the file's text). */
  name: string;
  hex: string;
}

export interface TokenFamily {
  index: number;
  name: string;
  family: string;
}

export interface TokenFile {
  format: 'list' | 'dtcg';
  /** Tokens read (colours, families and others). */
  tokens: number;
  colours: TokenColour[];
  families: TokenFamily[];
  skipped: { alpha: number; unsupported: number; unresolved: number };
}

export class TokenFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenFileError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface RawToken {
  name: string;
  value: unknown;
  type?: string;
}

const ALIAS_RE = /^\{([^{}]{1,500})\}$/;

/** The tokens of a list-format file: groups holding `tokens: [...]`, and top-level `tokens`. */
function listTokens(root: Obj): RawToken[] | null {
  const out: RawToken[] = [];
  let found = false;
  const take = (group: string | null, list: unknown[]) => {
    found = true;
    for (const t of list) {
      if (!isObj(t) || typeof t.name !== 'string' || !('value' in t)) continue;
      out.push({ name: group ? `${group}.${t.name}` : t.name, value: t.value, ...(typeof t.type === 'string' ? { type: t.type } : {}) });
      if (out.length > TOKENS_MAX) throw new TokenFileError(`more than ${TOKENS_MAX} tokens`);
    }
  };
  for (const [k, v] of Object.entries(root)) {
    if (k === 'tokens' && Array.isArray(v)) take(null, v);
    else if (isObj(v) && Array.isArray(v.tokens)) take(k, v.tokens);
  }
  return found ? out : null;
}

/** The tokens of a DTCG file, walked without recursion: depth checked as it goes, `$type` inherited from groups. */
function dtcgTokens(root: Obj): RawToken[] {
  const out: RawToken[] = [];
  const stack: Array<{ node: Obj; path: string[]; type?: string }> = [{ node: root, path: [] }];
  while (stack.length) {
    const { node, path, type } = stack.pop()!;
    if (path.length > TOKENS_MAX_DEPTH) throw new TokenFileError(`groups nested more than ${TOKENS_MAX_DEPTH} deep`);
    const own = typeof node.$type === 'string' ? node.$type : type;
    if ('$value' in node) {
      out.push({ name: path.join('.'), value: node.$value, ...(own ? { type: own } : {}) });
      if (out.length > TOKENS_MAX) throw new TokenFileError(`more than ${TOKENS_MAX} tokens`);
      continue;
    }
    const children = Object.entries(node).filter(([k, v]) => !k.startsWith('$') && isObj(v));
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i][1] as Obj, path: [...path, children[i][0]], ...(own ? { type: own } : {}) });
  }
  return out;
}

/** The depth of a parsed value, at most TOKENS_MAX_DEPTH + 1 (iterative). */
function tooDeep(v: unknown): boolean {
  const stack: Array<[unknown, number]> = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (d > TOKENS_MAX_DEPTH) return true;
    if (x && typeof x === 'object') for (const c of Object.values(x as Obj)) if (c && typeof c === 'object') stack.push([c, d + 1]);
  }
  return false;
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');

/** A colour value as `#rrggbb`, `alpha` (translucent: skipped) or null (not a colour this reads). */
export function tokenColour(v: unknown): string | 'alpha' | null {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(s);
    if (m) return m[4] !== undefined && m[4] !== 'f' ? 'alpha' : `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
    if (m) return m[2] !== undefined && m[2] !== 'ff' ? 'alpha' : `#${m[1]}`;
    return null;
  }
  if (isObj(v) && v.colorSpace === 'srgb' && Array.isArray(v.components) && v.components.length === 3 && v.components.every((c) => typeof c === 'number' && c >= 0 && c <= 1)) {
    if (typeof v.alpha === 'number' && v.alpha < 1) return 'alpha';
    return `#${(v.components as number[]).map((c) => hex2(c * 255)).join('')}`;
  }
  return null;
}

/** An alias's target followed to a value: at most ALIAS_MAX_HOPS hops; a cycle or a longer chain refuses the file. */
function resolveValue(byName: Map<string, RawToken>, t: RawToken, index: number): { value: unknown; type?: string } | null {
  let cur = t;
  const seen = new Set<string>([cur.name]);
  for (let hop = 0; ; hop++) {
    const m = typeof cur.value === 'string' ? ALIAS_RE.exec(cur.value.trim()) : null;
    if (!m) return { value: cur.value, ...((t.type ?? cur.type) ? { type: t.type ?? cur.type } : {}) };
    if (hop >= ALIAS_MAX_HOPS) throw new TokenFileError(`token #${index}: an alias chain longer than ${ALIAS_MAX_HOPS} hops`);
    const next = byName.get(m[1]);
    if (!next) return null;
    if (seen.has(next.name)) throw new TokenFileError(`token #${index}: an alias cycle`);
    seen.add(next.name);
    cur = next;
  }
}

const FAMILY_NAME_RE = /font|family/i;

/** A design-token file's colours and font families (see the module comment). TokenFileError when it is refused. */
export function parseTokenFile(text: string): TokenFile {
  if (text.length > TOKENS_MAX_CHARS) throw new TokenFileError(`more than ${TOKENS_MAX_CHARS} characters`);
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new TokenFileError('not JSON');
  }
  if (!isObj(root)) throw new TokenFileError('not a JSON object of tokens');
  if (tooDeep(root)) throw new TokenFileError(`nested more than ${TOKENS_MAX_DEPTH} levels deep`);
  const list = listTokens(root);
  const raw = list ?? dtcgTokens(root);
  const format = list ? 'list' : 'dtcg';
  const byName = new Map<string, RawToken>();
  for (const t of raw) if (!byName.has(t.name)) byName.set(t.name, t);
  const out: TokenFile = { format, tokens: raw.length, colours: [], families: [], skipped: { alpha: 0, unsupported: 0, unresolved: 0 } };
  raw.forEach((t, i) => {
    const r = resolveValue(byName, t, i);
    if (!r) {
      out.skipped.unresolved++;
      return;
    }
    const type = r.type?.toLowerCase();
    if (type === 'fontfamily' || (format === 'list' && FAMILY_NAME_RE.test(t.name) && typeof r.value === 'string' && tokenColour(r.value) === null)) {
      const fam = Array.isArray(r.value) ? r.value.find((x) => typeof x === 'string') : r.value;
      if (typeof fam === 'string' && fam.trim()) out.families.push({ index: out.families.length, name: t.name, family: fam.trim().slice(0, 200) });
      return;
    }
    if (type === 'typography' && isObj(r.value)) {
      const f = r.value.fontFamily;
      const fam = Array.isArray(f) ? f.find((x) => typeof x === 'string') : f;
      if (typeof fam === 'string' && fam.trim()) out.families.push({ index: out.families.length, name: t.name, family: fam.trim().slice(0, 200) });
      return;
    }
    if (type !== undefined && type !== 'color') return;
    const c = tokenColour(r.value);
    if (c === 'alpha') out.skipped.alpha++;
    else if (c) out.colours.push({ index: out.colours.length, name: t.name, hex: c });
    else if (type === 'color' || typeof r.value === 'string') out.skipped.unsupported++;
  });
  return out;
}

// ── The proposal ──────────────────────────────────────────────────────────────────────────────────────────────────

const ROLE_WORDS: Record<string, TokenRole> = {
  primary: 'accent',
  accent: 'accent',
  brand: 'accent',
  background: 'paper',
  bg: 'paper',
  paper: 'paper',
  surface: 'paper',
  canvas: 'paper',
  text: 'text',
  foreground: 'text',
  fg: 'text',
  ink: 'text',
  muted: 'muted',
  secondary: 'muted',
  subtle: 'muted',
  dark: 'dark',
  night: 'dark',
  inverse: 'dark',
};
const MUTED_WORDS = new Set(['muted', 'secondary', 'subtle', 'tertiary']);
const MAIN_WORDS = new Set(['primary', 'default', 'base', 'main']);

/** The lower-case words of a token name: its parts split at `.`, `-`, `_`, `/`, spaces and camelCase. */
export function tokenWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The role a name says, or null: its first role word from the left (`color.text.primary` → text, `brand.primary` →
 * accent); text with a muted word after it is muted (`text.secondary`); paper with one is no paper (a second surface).
 * A role word right after `on` names what is drawn ON that role: `on-background` / `on-surface` are text, `on-primary`
 * (white on the accent) is no role. `main`: nothing after the role word, or a main word (primary, default, base, main) —
 * a numeric step (`primary.500`) is not main.
 */
export function nameRole(name: string): { role: TokenRole; main: boolean } | null {
  const words = tokenWords(name);
  const at = words.findIndex((w) => ROLE_WORDS[w] !== undefined);
  if (at < 0) return null;
  const role = ROLE_WORDS[words[at]];
  const rest = words.slice(at + 1);
  const main = rest.length === 0 || rest.some((w) => MAIN_WORDS.has(w));
  if (words[at - 1] === 'on') return role === 'paper' ? { role: 'text', main } : null;
  const mutedAfter = rest.some((w) => MUTED_WORDS.has(w));
  if (role === 'text' && mutedAfter) return { role: 'muted', main: false };
  if (role === 'paper' && mutedAfter) return null;
  return { role, main };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
/** WCAG relative luminance of a `#rrggbb`. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** WCAG contrast ratio of two `#rrggbb`. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Chroma, 0–255: the spread of a colour's channels (0: a grey). */
function chroma(hex: string): number {
  const c = rgb(hex);
  return Math.max(...c) - Math.min(...c);
}
const NEUTRAL_CHROMA = 30;
/** An accent needs this contrast with the paper (the theme's own threshold). */
export const ACCENT_MIN_CONTRAST = 3;

export interface ProposedRole {
  index: number;
  hex: string;
  why: 'name' | 'colour' | 'map';
}

/** The contrast with the paper a role's named token should reach (a ramp's step that does is preferred). */
const ROLE_MIN_CONTRAST: Partial<Record<TokenRole, number>> = { accent: ACCENT_MIN_CONTRAST, text: 4.5, muted: 3 };

/**
 * A role for each of the theme's colours. The paper first: by name (nameRole: a main token first, else the first), else
 * by colour (the most extreme neutral — the lightest, unless every neutral is dark — among the tokens no name gives a
 * role). Then the other roles by name, a main token first: among a role's tokens (a ramp `primary.50…900`) the first
 * that reaches its contrast on the paper (accent 3:1, text 4.5:1, muted 3:1), else the first. A named accent below 3:1
 * gives way to the accent by colour (said in `notes`). Then by colour for the roles still empty: accent the most
 * saturated colour with at least ACCENT_MIN_CONTRAST on it, text the colour of highest contrast with the paper, dark the
 * darkest neutral of a light paper. A token gives one role at most. Muted stays empty unless a name says it (a theme
 * derives it). A heuristic: the person confirms the roles.
 */
export function proposeRoles(colours: readonly TokenColour[], notes: string[] = []): Partial<Record<TokenRole, ProposedRole>> {
  const out: Partial<Record<TokenRole, ProposedRole>> = {};
  const used = new Set<number>();
  const pick = (role: TokenRole, c: TokenColour, why: ProposedRole['why']) => {
    out[role] = { index: c.index, hex: c.hex, why };
    used.add(c.index);
  };
  const roles = colours.map((c) => ({ c, r: nameRole(c.name) }));
  const named = (role: TokenRole) => {
    const of = roles.filter((x) => x.r?.role === role && !used.has(x.c.index));
    return [...of.filter((x) => x.r!.main), ...of.filter((x) => !x.r!.main)].map((x) => x.c);
  };
  const paperNamed = named('paper')[0];
  if (paperNamed) pick('paper', paperNamed, 'name');
  else {
    const unnamed = colours.filter((c) => !roles[c.index]?.r);
    const neutrals = unnamed.filter((c) => chroma(c.hex) <= NEUTRAL_CHROMA);
    const pool = neutrals.length ? neutrals : unnamed;
    const light = pool.filter((c) => luminance(c.hex) >= 0.5);
    const p = (light.length ? light : pool).reduce<TokenColour | undefined>((a, c) => (!a ? c : light.length ? (luminance(c.hex) > luminance(a.hex) ? c : a) : luminance(c.hex) < luminance(a.hex) ? c : a), undefined);
    if (p) pick('paper', p, 'colour');
  }
  const paper = out.paper?.hex;
  let weakAccent: TokenColour | undefined;
  for (const role of TOKEN_ROLES) {
    if (role === 'paper') continue;
    const list = named(role);
    if (!list.length) continue;
    const min = ROLE_MIN_CONTRAST[role];
    const passing = paper && min !== undefined ? list.find((c) => contrast(c.hex, paper) >= min) : undefined;
    if (role === 'accent' && paper && !passing) {
      weakAccent = list[0];
      continue;
    }
    pick(role, passing ?? list[0], 'name');
  }
  const free = () => colours.filter((c) => !used.has(c.index));
  if (!paper) return out;
  if (!out.accent) {
    const a = free()
      .filter((c) => chroma(c.hex) > NEUTRAL_CHROMA && contrast(c.hex, paper) >= ACCENT_MIN_CONTRAST && c !== weakAccent)
      .reduce<TokenColour | undefined>((x, c) => (!x || chroma(c.hex) > chroma(x.hex) ? c : x), undefined);
    if (a) pick('accent', a, 'colour');
    if (weakAccent && a) notes.push(`the accent the file names (token #${weakAccent.index}) is below ${ACCENT_MIN_CONTRAST}:1 on the paper: token #${a.index} is proposed by its colour instead`);
    else if (weakAccent) {
      pick('accent', weakAccent, 'name');
      notes.push(`the accent the file names (token #${weakAccent.index}) is below ${ACCENT_MIN_CONTRAST}:1 on the paper, and no other colour reaches it: a create will suggest another accent`);
    }
  }
  if (!out.text) {
    const t = free().reduce<TokenColour | undefined>((a, c) => (!a || contrast(c.hex, paper) > contrast(a.hex, paper) ? c : a), undefined);
    if (t) pick('text', t, 'colour');
  }
  if (!out.dark && luminance(paper) >= 0.5) {
    const d = free()
      .filter((c) => chroma(c.hex) <= NEUTRAL_CHROMA && luminance(c.hex) < 0.2)
      .reduce<TokenColour | undefined>((x, c) => (!x || luminance(c.hex) < luminance(x.hex) ? c : x), undefined);
    if (d) pick('dark', d, 'colour');
  }
  return out;
}

/** Up to `n` names of `names` nearest to `want` (shared words, then edit distance): for an error's untrusted `near`. */
export function nearestNames(want: string, names: readonly string[], n = 5): string[] {
  const w = new Set(tokenWords(want));
  const dist = (a: string, b: string) => {
    if (Math.abs(a.length - b.length) > 40) return 99;
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0];
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = d[j];
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = t;
      }
    }
    return d[b.length];
  };
  return [...names]
    .map((name) => ({ name, shared: tokenWords(name).filter((x) => w.has(x)).length, d: dist(want.toLowerCase(), name.toLowerCase()) }))
    .sort((a, b) => b.shared - a.shared || a.d - b.d)
    .slice(0, n)
    .map((x) => x.name);
}
