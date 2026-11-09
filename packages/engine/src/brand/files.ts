/**
 * Brand files of a new theme (L3.5, R-MCP-10): where a logo, a wordmark or a font may come from, and what its bytes
 * must look like before the tool copies it into a theme folder the renderer (and later the studio UI) reads.
 *
 * Sources (trust `mcp`): a path relative to the workspace root that stays in it once links are followed, never in a
 * hidden folder (`.retake/`, `.git/`…), the components folder (agent-scaffolded code) or a folder an agent can
 * write through MCP in any project (scenarios/, runs/, renders/, review/, exports/ — compared without case, macOS).
 * A human typing `retake theme create` (trust `author`) names any local file. Either way the bytes are checked:
 *
 * - raster logos: PNG / JPEG / WebP magic and the size read from the header (no decoder), 64 px high at least,
 *   8192 px at most, the format matching the extension;
 * - SVG: UTF-8 (strict, and no XML declaration of another encoding), no NUL or other C0 control character, then a
 *   conservative lexical scan of the text with character references decoded — refused (never cleaned) on scripts,
 *   event handlers, foreignObject and other embedding elements under any prefix (names are read as a parser reads
 *   them, any character but whitespace, "/" and ">", and judged by their local part after the last ":"),
 *   any href / src that is not `#…` or an embedded PNG / JPEG / WebP, `url(…)` that is not `#…` or an embedded font,
 *   `@import`, `javascript:`, SMIL animating an href, DOCTYPE / ENTITY / processing instructions and backslashes
 *   (CSS escapes). An embedded `data:font/woff2` (the starters' wordmarks: live text with its font) is accepted:
 *   in an `<img>` — how components draw logos — fonts are sanitised by the browser (OTS) and scripts never run;
 * - fonts: TrueType / OpenType (table directory, `name` and `OS/2` read), WOFF and WOFF2 (magic and header only);
 *   embedding bits of `OS/2.fsType` (restricted, preview & print, bitmap only) are warnings, never refusals.
 *
 * Converting every logo to PNG was the alternative: it needs a browser, so a create would become a worker job, and
 * the starters' vector wordmarks would lose their sharpness at 4K — the scan keeps creates synchronous and vectors
 * intact.
 */
import { lstat, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { BRAND_IMAGE_MAX_BYTES, BRAND_IMAGE_MIN_HEIGHT, agentWritable, brandRefSyntaxProblem, expandHome, insideFolder, printableText, realPathOf, siteRef, STATE_DIR, STATE_DIRS } from '@retake/core';
import { nodeFileFacts } from '@retake/core/io';
import type { CallerTrust } from '../caller.js';
import { EngineError } from '../errors.js';
import type { OpenedWorkspace } from '../workspace.js';

/** Who stands behind a brand's files: a caller's trust (caller.ts). */
export type BrandTrust = CallerTrust;

export const IMAGE_MAX_BYTES = BRAND_IMAGE_MAX_BYTES;
export const SVG_MAX_BYTES = 512 * 1024;
export const FONT_MAX_BYTES = 10 * 1024 * 1024;
/** Every brand file of one create, together. */
export const BRAND_TOTAL_MAX_BYTES = 25 * 1024 * 1024;
export const IMAGE_MIN_HEIGHT = BRAND_IMAGE_MIN_HEIGHT;
export const IMAGE_MAX_SIDE = 8192;

export const LOGO_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp'] as const;
export const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'] as const;

export type BrandFileKind = 'logo' | 'wordmark' | 'font';

export interface ResolvedBrandFile {
  /** As given. */
  ref: string;
  /** The file read (links followed). */
  path: string;
  /** Lower-case extension with its dot. */
  ext: string;
  bytes: Buffer;
}

function refused(message: string, fix?: string): EngineError {
  return new EngineError('refused', message, fix ? { fix } : {});
}

/**
 * Why a workspace file is not a brand source under trust `mcp`, or null. `real` is the file's path with links
 * followed; `ref` is as given (for messages).
 */
export function brandSourceProblem(ws: OpenedWorkspace, ref: string, real: string): string | null {
  const root = realPathOf(resolve(ws.root), nodeFileFacts);
  if (!insideFolder(root, real, nodeFileFacts)) return `${ref} leaves the workspace (it resolves to ${real}): brand files are files of the workspace, e.g. brand/logo.svg`;
  const rel = relative(root, real);
  const hidden = rel.split(sep).find((s) => s.startsWith('.'));
  if (hidden) return `${ref} lies in a hidden folder or file (${hidden}, e.g. .retake/ — written by the tools): put brand files in a plain folder such as brand/`;
  if (insideFolder(ws.componentsDir, real, nodeFileFacts)) return `${ref} lies in the components folder (${ws.componentsDir}), whose files an agent can scaffold: put brand files in brand/`;
  if (insideFolder(ws.projectsDir, real, nodeFileFacts)) {
    const segs = relative(realPathOf(resolve(ws.projectsDir), nodeFileFacts), real).split(sep);
    if (segs.length >= 2 && agentWritable(segs.slice(1).join('/'))) {
      return `${ref} lies in ${segs.slice(1, 2).join('')}/ of project ${segs[0]}, a folder an agent can write through MCP (scenarios, runs, renders, reviews, exports): put brand files in brand/`;
    }
  }
  return null;
}

/** A brand file reference resolved and read, after the source rules of its trust; the content is checked by the caller. */
export async function readBrandFile(ws: OpenedWorkspace, ref: string, kind: BrandFileKind, o: { trust: BrandTrust; cwd?: string; budget?: { left: number } }): Promise<ResolvedBrandFile> {
  const what = kind === 'font' ? 'font' : kind;
  // A logo candidate of a site extraction (any trust): the only way into .retake/, and only to its PNGs.
  if (siteRef(ref) || (o.trust === 'author' && ref.startsWith('site:'))) return readSiteCandidate(ws, ref, kind, what, o.budget);
  let abs: string;
  if (o.trust === 'mcp') {
    const syntax = brandRefSyntaxProblem(ref);
    if (syntax) throw refused(`${what}: ${syntax}`);
    abs = resolve(ws.root, ref);
  } else {
    abs = resolve(o.cwd ?? process.cwd(), expandHome(ref));
  }
  try {
    await lstat(abs);
  } catch {
    throw new EngineError('not_found', `${what}: ${ref} not found (${abs})`);
  }
  const real = realPathOf(abs, nodeFileFacts);
  if (o.trust === 'mcp') {
    const p = brandSourceProblem(ws, ref, real);
    if (p) throw refused(`${what}: ${p}`);
  }
  const ext = extname(real).toLowerCase() || extname(abs).toLowerCase();
  const allowed: readonly string[] = kind === 'font' ? FONT_EXTENSIONS : LOGO_EXTENSIONS;
  if (!allowed.includes(ext)) throw new EngineError('invalid', `${what}: ${ref} is not ${kind === 'font' ? 'a font file (.ttf, .otf, .woff, .woff2)' : 'an image file (.svg, .png, .jpg, .webp)'}`);
  const st = await stat(real);
  if (!st.isFile()) throw new EngineError('invalid', `${what}: ${ref} is not a file`);
  const max = kind === 'font' ? FONT_MAX_BYTES : ext === '.svg' ? SVG_MAX_BYTES : IMAGE_MAX_BYTES;
  if (st.size > max) throw new EngineError('invalid', `${what}: ${ref} is ${st.size} bytes, more than the ${max} a ${ext.slice(1).toUpperCase()} ${what} may have`);
  if (o.budget) {
    if (st.size > o.budget.left) throw new EngineError('invalid', `the brand files are more than ${BRAND_TOTAL_MAX_BYTES} bytes together`);
    o.budget.left -= st.size;
  }
  const bytes = await readFile(real);
  if (bytes.length > max) throw new EngineError('invalid', `${what}: ${ref} grew past ${max} bytes while it was read`);
  return { ref, path: real, ext, bytes };
}

/**
 * `site:<site_id>/logo-<n>` → <workspace>/.retake/site/<site_id>/logo-<n>.png: the path is built from the checked
 * id and candidate (never a path of the reference), the file must be a regular file (no link) and a PNG by its header
 * (re-sniffed: the folder is the workspace's, a file there may have been replaced). Only logos and wordmarks.
 */
async function readSiteCandidate(ws: OpenedWorkspace, ref: string, kind: BrandFileKind, what: string, budget?: { left: number }): Promise<ResolvedBrandFile> {
  const syntax = brandRefSyntaxProblem(ref);
  const site = siteRef(ref);
  if (syntax || !site) throw refused(`${what}: ${syntax ?? `${ref}: a site reference is site:<site id>/logo-<n>`}`);
  if (kind === 'font') throw refused(`${what}: ${ref} is a logo candidate of a site extraction: fonts come from font files (brand/), never from a site`);
  // No link on the way either: .retake/, site/ and the extraction's folder are real folders.
  let folder = ws.root;
  for (const seg of [STATE_DIR, STATE_DIRS.site, site.site_id]) {
    folder = join(folder, seg);
    const f = await lstat(folder).catch(() => null);
    if (f && !f.isDirectory()) throw refused(`${what}: ${ref}: ${folder} is not a plain folder (a link or a file): it is never followed`);
  }
  const file = join(folder, `${site.candidate}.png`);
  let st;
  try {
    st = await lstat(file);
  } catch {
    throw new EngineError('not_found', `${what}: ${ref} not found (the extraction was pruned, or has no such candidate): run template_from_site again`);
  }
  if (!st.isFile()) throw refused(`${what}: ${ref} is not a plain file (a link or a folder): it is never followed`);
  if (st.size > IMAGE_MAX_BYTES) throw new EngineError('invalid', `${what}: ${ref} is ${st.size} bytes, more than the ${IMAGE_MAX_BYTES} a PNG ${what} may have`);
  if (budget) {
    if (st.size > budget.left) throw new EngineError('invalid', `the brand files are more than ${BRAND_TOTAL_MAX_BYTES} bytes together`);
    budget.left -= st.size;
  }
  const bytes = await readFile(file);
  if (rasterInfo(bytes)?.format !== 'png') throw new EngineError('invalid', `${what}: ${ref} is not a PNG (its first bytes say otherwise): site candidates are PNGs the extraction made`);
  return { ref, path: file, ext: '.png', bytes };
}

// ── Images ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImageInfo {
  format: 'png' | 'jpeg' | 'webp' | 'svg';
  /** Raster sizes from the header; an SVG's from width / height or its viewBox. */
  width?: number;
  height?: number;
}

/** Size of a PNG, JPEG or WebP from its header; undefined when the bytes are none of them. */
export function rasterInfo(b: Buffer): ImageInfo | undefined {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') {
    return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return undefined;
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { format: 'webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return undefined;
}

const RASTER_EXT: Record<string, ImageInfo['format']> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };

/** Check a logo / wordmark's bytes against its extension; returns its format and size, else throws `invalid`. */
export function checkImage(f: Pick<ResolvedBrandFile, 'ref' | 'ext' | 'bytes'>, what: string): ImageInfo {
  if (f.ext === '.svg') {
    const r = scanSvg(f.bytes);
    if (r.problems.length) {
      throw new EngineError('invalid', `${what}: ${f.ref} is an SVG this tool does not copy — ${r.problems.join('; ')}`, {
        fix: 'export a plain SVG (shapes and text, no script, links or external files; text as outlines when in doubt) or a PNG',
      });
    }
    return { format: 'svg', ...(r.width !== undefined ? { width: r.width } : {}), ...(r.height !== undefined ? { height: r.height } : {}) };
  }
  const info = rasterInfo(f.bytes);
  if (!info) throw new EngineError('invalid', `${what}: ${f.ref} is not a PNG, JPEG or WebP image (its first bytes say otherwise)`);
  if (info.format !== RASTER_EXT[f.ext]) throw new EngineError('invalid', `${what}: ${f.ref} is a ${info.format.toUpperCase()} named ${f.ext}: rename it to its format`);
  const { width = 0, height = 0 } = info;
  if (height < IMAGE_MIN_HEIGHT) throw new EngineError('invalid', `${what}: ${f.ref} is ${width}×${height} px: a logo needs ${IMAGE_MIN_HEIGHT} px of height at least (an SVG or a larger export)`);
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE || width < 1) throw new EngineError('invalid', `${what}: ${f.ref} is ${width}×${height} px: at most ${IMAGE_MAX_SIDE} px a side`);
  return info;
}

// ── SVG scan ───────────────────────────────────────────────────────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Numeric character references and the five XML entities decoded, repeatedly (double encodings too). */
function decodeReferences(text: string): string {
  let s = text;
  for (let round = 0; round < 4; round++) {
    const next = s.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));?/gi, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (name !== undefined) return XML_ENTITIES[name.toLowerCase()] ?? m;
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec!, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\u0000';
    });
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Elements that run code or embed another document, matched by local name under any namespace prefix. */
const FORBIDDEN_ELEMENTS = ['script', 'foreignobject', 'iframe', 'embed', 'object', 'handler', 'listener', 'frame', 'frameset', 'applet', 'link', 'meta', 'base', 'portal', 'audio', 'video', 'canvas', 'include'];
/** A tag name as a parser reads it: any characters up to whitespace, "/" or ">" (a prefix may be any letters: `é:script`). */
const ELEMENT_RE = /<\s*\/?\s*([^\s/>!?]+)/g;
/** An attribute name (any characters but whitespace, "=", "/", ">" and quotes) after whitespace, a slash or a quote, and "=". */
const ATTR_RE = /[\s/"']([^\s=/>"']+)\s*=\s*/g;
/** The local part of a qualified name (after the last ":"), lower-case: what the rules judge. */
const localName = (name: string) => name.slice(name.lastIndexOf(':') + 1).toLowerCase();
const ALLOWED_LINK = /^(?:#[\w.:-]*|data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]*)$/i;
const URL_FN_RE = /url\s*\(/gi;
const ALLOWED_URL = /^(?:#[\w.:-]*|data:font\/(?:woff2|woff|ttf|otf|sfnt);base64,[a-z0-9+/=\s]*|data:application\/(?:font-woff2?|x-font-(?:woff|ttf|otf));base64,[a-z0-9+/=\s]*|data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]*)$/i;

export interface SvgScan {
  problems: string[];
  width?: number;
  height?: number;
}

/**
 * The scan's problems are the tool's sentences only: a name or a value of the file (third-party text) is never quoted
 * in them — they reach an agent as an error message.
 */
function scanText(s: string, problems: Set<string>): void {
  if (/<!DOCTYPE/i.test(s) || /<!ENTITY/i.test(s)) problems.add('it declares a DOCTYPE or entities');
  for (const m of s.matchAll(/<\?\s*([^\s?>]*)/g)) if (m[1].toLowerCase() !== 'xml' || m.index !== s.search(/\S/)) problems.add('it holds a processing instruction (only the XML declaration, first, is accepted)');
  for (const m of s.matchAll(ELEMENT_RE)) {
    const local = localName(m[1]);
    if (FORBIDDEN_ELEMENTS.includes(local)) problems.add(`it has a <${local}> element`);
  }
  for (const m of s.matchAll(ATTR_RE)) {
    const local = localName(m[1]);
    if (local.startsWith('on')) {
      problems.add('it has an event handler attribute (on…=)');
      continue;
    }
    if (local !== 'href' && local !== 'src') continue;
    const rest = s.slice(m.index + m[0].length);
    const q = rest[0];
    if (q !== '"' && q !== "'") {
      problems.add(`an unquoted ${local} attribute`);
      continue;
    }
    const end = rest.indexOf(q, 1);
    const value = (end < 0 ? rest.slice(1) : rest.slice(1, end)).trim();
    if (!ALLOWED_LINK.test(value)) problems.add(`a ${local} to something other than a fragment (#…) or an embedded PNG / JPEG / WebP`);
  }
  for (const m of s.matchAll(URL_FN_RE)) {
    // CSS: a quoted string (which may hold ")") or everything up to ")".
    let i = m.index + m[0].length;
    while (i < s.length && /\s/.test(s[i])) i++;
    const q = s[i];
    const end = q === '"' || q === "'" ? s.indexOf(q, i + 1) : s.indexOf(')', i);
    if (end < 0) {
      problems.add('an unterminated url(');
      continue;
    }
    const value = (q === '"' || q === "'" ? s.slice(i + 1, end) : s.slice(i, end)).trim();
    if (!ALLOWED_URL.test(value)) problems.add('a url(…) to something other than a fragment or an embedded font / image');
  }
  if (/image-set\s*\(|cross-fade\s*\(|element\s*\(/i.test(s)) problems.add('a CSS image-set(), cross-fade() or element()');
  if (/@import/i.test(s)) problems.add('a CSS @import');
  if (/-moz-binding|behavior\s*:|expression\s*\(/i.test(s)) problems.add('a CSS binding or expression');
  const squashed = s.replace(/[\s\u0000-\u001f]+/g, '');
  if (/(?:java|vb)script:/i.test(squashed)) problems.add('a javascript: URL');
  if (/data:text\/html/i.test(squashed) || /data:image\/svg/i.test(squashed)) problems.add('an embedded HTML or SVG document');
  if (/attributeName\s*=\s*["']?\s*(?:[^\s"'=>]*:)?(?:href|src|on)/i.test(s)) problems.add('an animation of an href, src or event attribute');
  if (s.includes('\\')) problems.add('a backslash (CSS escapes are not accepted)');
}

/** Scan an SVG file's bytes; `problems` empty = accepted. Never cleans anything. */
export function scanSvg(bytes: Buffer): SvgScan {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { problems: ['it is not UTF-8 text'] };
  }
  if (text.includes('\u0000')) return { problems: ['it holds a NUL character'] };
  const problems = new Set<string>();
  // An XML declaration of another encoding makes a browser decode the bytes differently from this scan
  // (ISO-2022-JP escapes split a name: `<scr\x1b(Bipt>`); C0 controls have no place in an SVG either.
  const decl = /^\s*<\?xml\b([^>]*)>/.exec(text);
  const encoding = decl ? /\bencoding\s*=\s*["']([^"']*)["']/i.exec(decl[1])?.[1] : undefined;
  if (encoding !== undefined && !/^utf-?8$/i.test(encoding.trim())) problems.add('its XML declaration names another encoding than UTF-8');
  // eslint-disable-next-line no-control-regex
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) problems.add('it holds a control character');
  const decoded = decodeReferences(text);
  if (decoded.includes('\u0000')) problems.add('a character reference to an invalid character');
  // As written (an encoded quote can end an attribute value early once decoded) and decoded (what a parser reads).
  scanText(text, problems);
  scanText(decoded, problems);
  // Comments removed too: what a comment split could join (`<scr<!-- -->ipt>`) is scanned as joined.
  scanText(decoded.replace(/<!--[\s\S]*?-->/g, ''), problems);
  const root = /<\s*(?:[a-z_][\w.-]*:)?svg\b([^>]*)>/i.exec(decoded);
  if (!root) return { problems: [...problems, 'no <svg> element'] };
  const attr = (name: string) => new RegExp(`[\\s"']${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root[1])?.[1];
  const num = (v: string | undefined) => (v !== undefined && /^\s*[\d.]+\s*(?:px)?\s*$/.test(v) ? Number.parseFloat(v) : undefined);
  const vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  let width = num(attr('width'));
  let height = num(attr('height'));
  if (vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    width ??= vb[2];
    height ??= vb[3];
  } else if (width === undefined || height === undefined) problems.add('no viewBox and no width / height on <svg>');
  return { problems: [...problems], ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
}

// ── Fonts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2';

export interface FontInfo {
  format: FontFormat;
  /** OS/2 usWeightClass (TrueType / OpenType only). */
  weight?: number;
  /** OS/2 fsSelection bit 0 (TrueType / OpenType only). */
  italic?: boolean;
  /** OS/2 fsType (TrueType / OpenType only). */
  fs_type?: number;
  /** Strings of the `name` table: text the font's maker wrote (third-party text). */
  names: { family?: string; subfamily?: string; copyright?: string; licence?: string; licence_url?: string; version?: string };
  /** Licence notes from fsType (restricted, preview & print, bitmap only). */
  licence_notes: string[];
}

const NAME_IDS: Record<number, keyof FontInfo['names']> = { 0: 'copyright', 1: 'family', 2: 'subfamily', 5: 'version', 13: 'licence', 14: 'licence_url', 16: 'family', 17: 'subfamily' };
const NAME_MAX = 400;

function cleanName(s: string): string {
  // C0 / C1 controls and bidirectional formatting characters out: the strings are printed by the CLI and LICENSES.md.
  const t = printableText(s);
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX)}…` : t;
}

function utf16be(b: Buffer): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
  return s;
}

function readNames(b: Buffer, off: number, len: number): FontInfo['names'] {
  const out: FontInfo['names'] = {};
  if (len < 6 || off + len > b.length) return out;
  const count = b.readUInt16BE(off + 2);
  const strings = off + b.readUInt16BE(off + 4);
  const rank = (platform: number, lang: number) => (platform === 3 ? (lang === 0x409 ? 0 : 1) : platform === 0 ? 2 : platform === 1 ? 3 : 9);
  const best: Partial<Record<number, { r: number; text: string }>> = {};
  for (let i = 0; i < count; i++) {
    const rec = off + 6 + i * 12;
    if (rec + 12 > off + len) break;
    const platform = b.readUInt16BE(rec);
    const lang = b.readUInt16BE(rec + 4);
    const id = b.readUInt16BE(rec + 6);
    const l = b.readUInt16BE(rec + 8);
    const o = strings + b.readUInt16BE(rec + 10);
    if (!(id in NAME_IDS) || o + l > b.length) continue;
    const r = rank(platform, lang);
    if (r === 9 || (best[id] && best[id]!.r <= r)) continue;
    const raw = b.subarray(o, o + l);
    best[id] = { r, text: platform === 1 ? raw.toString('latin1') : utf16be(raw) };
  }
  // Typographic family / subfamily (16, 17) win over the legacy ones (1, 2).
  for (const id of [0, 1, 2, 5, 13, 14, 16, 17]) {
    const v = best[id];
    if (v && cleanName(v.text)) out[NAME_IDS[id]] = cleanName(v.text);
  }
  return out;
}

const FS_TYPE_NOTES: Array<[number, string]> = [
  [0x0002, 'restricted licence embedding (OS/2 fsType bit 1): the maker does not allow embedding it without permission'],
  [0x0004, 'preview & print embedding only (OS/2 fsType bit 2)'],
  [0x0200, 'bitmap embedding only (OS/2 fsType bit 9)'],
];

/** A font file's format and what its header says; throws `invalid` when it is not a font of its extension. */
export function sniffFont(f: Pick<ResolvedBrandFile, 'ref' | 'ext' | 'bytes'>, what = 'font'): FontInfo {
  const b = f.bytes;
  const notFont = (why: string) => new EngineError('invalid', `${what}: ${f.ref} is not a usable font (${why})`);
  if (b.length < 12) throw notFont('too short');
  const tag = b.toString('latin1', 0, 4);
  const magic = b.readUInt32BE(0);
  if (tag === 'ttcf') throw notFont('a font collection (.ttc): give one face per file');
  let format: FontFormat;
  if (magic === 0x00010000 || tag === 'true') format = 'ttf';
  else if (tag === 'OTTO') format = 'otf';
  else if (tag === 'wOFF') format = 'woff';
  else if (tag === 'wOF2') format = 'woff2';
  else throw notFont('no TrueType, OpenType, WOFF or WOFF2 signature');
  const extOk = f.ext === '.woff' ? format === 'woff' : f.ext === '.woff2' ? format === 'woff2' : format === 'ttf' || format === 'otf';
  if (!extOk) throw notFont(`a ${format.toUpperCase()} file named ${f.ext}`);
  const info: FontInfo = { format, names: {}, licence_notes: [] };
  if (format === 'woff' || format === 'woff2') {
    const header = format === 'woff' ? 44 : 48;
    if (b.length < header) throw notFont('a truncated header');
    if (b.readUInt32BE(8) !== b.length) throw notFont('its header gives another length than the file\'s');
    const n = b.readUInt16BE(12);
    if (n < 1 || n > 128) throw notFont('a table count out of range');
    if (format === 'woff') {
      if (header + n * 20 > b.length) throw notFont('a truncated table directory');
      for (let i = 0; i < n; i++) {
        const rec = header + i * 20;
        const off = b.readUInt32BE(rec + 4);
        const comp = b.readUInt32BE(rec + 8);
        if (off + comp > b.length) throw notFont('a table beyond the end of the file');
      }
    }
    return info;
  }
  const n = b.readUInt16BE(4);
  if (n < 1 || n > 128) throw notFont('a table count out of range');
  if (12 + n * 16 > b.length) throw notFont('a truncated table directory');
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const t = b.toString('latin1', rec, rec + 4);
    const off = b.readUInt32BE(rec + 8);
    const len = b.readUInt32BE(rec + 12);
    if (off + len > b.length) throw notFont('a table lies beyond the end of the file');
    tables.set(t, { off, len });
  }
  for (const req of ['cmap', 'head']) if (!tables.has(req)) throw notFont(`no ${req} table`);
  if (!tables.has('glyf') && !tables.has('CFF ') && !tables.has('CFF2')) throw notFont('no glyph outlines (glyf / CFF)');
  const name = tables.get('name');
  if (name) info.names = readNames(b, name.off, name.len);
  const os2 = tables.get('OS/2');
  if (os2 && os2.len >= 64) {
    info.weight = b.readUInt16BE(os2.off + 4);
    info.fs_type = b.readUInt16BE(os2.off + 8);
    info.italic = (b.readUInt16BE(os2.off + 62) & 1) === 1;
    for (const [bit, note] of FS_TYPE_NOTES) if ((info.fs_type & bit) !== 0) info.licence_notes.push(note);
  }
  return info;
}

/** Names of the weights as fontFileFace (components theme.ts) reads them back from a file name. */
export const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

/** A weight rounded to a hundred in 100…900. */
export function standardWeight(w: number): number {
  return Math.min(900, Math.max(100, Math.round(w / 100) * 100));
}

/** The copy's file name: `fonts/<role>-<Weight>[Italic].<ext>` — the family never in it (its words would read as a weight). */
export function fontCopyName(role: 'display' | 'body', weight: number, italic: boolean, ext: string): string {
  return join('fonts', `${role}-${WEIGHT_NAMES[standardWeight(weight)]}${italic ? 'Italic' : ''}${ext}`).split(sep).join('/');
}
