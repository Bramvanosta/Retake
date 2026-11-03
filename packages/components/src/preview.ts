/**
 * Committed component previews (R-CMP-12/13/14): every component folder holds a generated `preview.png` (960×540, the
 * editorial theme by default, the manifest's preview samples), a `preview.json` sidecar and a README.md showing it.
 * This module is the Node-side bookkeeping — which files a preview depends on (manifest + entry + local imports), their
 * hash, the sidecar, staleness, the README block. The rendering itself lives in @retake/editor
 * (`renderComponentPreviews`, `retake components preview`).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { MANIFEST_FILE, parseManifest } from './manifest.js';
import { paramDefaults } from './json-schema.js';
import type { JsonSchemaNode } from './json-schema.js';
import { PACKAGE_DIR } from './paths.js';
import type { ComponentManifest } from './types.js';

/** The committed preview image of a component folder. */
export const PREVIEW_FILE = 'preview.png';
/** Its sidecar: what the image was rendered from (source hash, theme, moment). */
export const PREVIEW_META_FILE = 'preview.json';
/** Size of preview.png (half of 1920×1080: the same layout as a video frame). */
export const PREVIEW_SIZE = { width: 960, height: 540 } as const;
/** Largest committed preview. */
export const PREVIEW_MAX_BYTES = 200 * 1024;
/** Theme of the committed previews of the built-in components. */
export const PREVIEW_THEME = 'editorial';
/** Bump when the preview composition or sidecar changes in a way that invalidates every preview. */
export const PREVIEW_FORMAT = 1;
/** The neutral sample screens shown by layout / caption / overlay / transition previews. */
export const PREVIEW_SAMPLES_DIR = join(PACKAGE_DIR, 'preview');

export interface PreviewMeta {
  /** PREVIEW_FORMAT. */
  format: number;
  component: string;
  version: string;
  kind: string;
  /** Theme (template name) the image was rendered with. */
  theme: string;
  /** Second of the component shown (the last `preview.at`). */
  at: number;
  /** Sample screen used (layouts, captions, overlays, transitions). */
  screen?: string;
  /** Files the image depends on (relative to the component folder, sorted). */
  files: string[];
  /** sha256 (16 hex) of those files (see componentSourceHash). */
  source_hash: string;
  image: { file: string; width: number; height: number };
}

const CODE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function resolveLocal(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, ...CODE_EXTS.map((e) => base + e), ...CODE_EXTS.map((e) => base.replace(/\.(m?js|jsx)$/, e)), ...CODE_EXTS.map((e) => join(base, `index${e}`))];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // next candidate
    }
  }
  return undefined;
}

function posix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * The files a component's preview depends on: component.yaml, the entry and every file it imports with a relative
 * path (recursively, inside the folder) — not README.md, not the preview itself. Relative to `dir`, sorted.
 */
export function componentSourceFiles(dir: string, manifest?: Pick<ComponentManifest, 'entry'>): string[] {
  const root = resolve(dir);
  let entry = manifest?.entry;
  if (entry === undefined) {
    const text = readFileSync(join(root, MANIFEST_FILE), 'utf8');
    // The entry of a valid manifest, else whatever `entry:` says (an invalid manifest still has sources to hash).
    entry = parseManifest(text, MANIFEST_FILE).manifest?.entry ?? /^entry\s*:\s*['"]?([^'"\s#]+)/m.exec(text)?.[1];
  }
  const files = new Set<string>([MANIFEST_FILE]);
  const queue = [resolve(root, entry ?? 'index.tsx')];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const rel = posix(relative(root, file));
    if (rel.startsWith('..')) continue;
    files.add(rel);
    if (!CODE_EXTS.some((e) => file.endsWith(e))) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveLocal(file, m[1] ?? m[2]);
      if (target) queue.push(target);
    }
  }
  return [...files].sort();
}

/** sha256 (first 16 hex) of the source files (path + content, line endings normalised). */
export function componentSourceHash(dir: string, files = componentSourceFiles(dir)): string {
  const h = createHash('sha256');
  h.update(`preview-format ${PREVIEW_FORMAT}\0`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    h.update(`${f}\0${text.length}\0${text}\0`);
  }
  return h.digest('hex').slice(0, 16);
}

export function readPreviewMeta(dir: string): PreviewMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, PREVIEW_META_FILE), 'utf8')) as PreviewMeta;
  } catch {
    return undefined;
  }
}

export interface PreviewStatus {
  state: 'fresh' | 'missing' | 'stale';
  /** Why it is missing or stale. */
  reason?: string;
  meta?: PreviewMeta;
  hash: string;
}

/** Whether a component folder's committed preview matches its sources (and, when given, the theme). */
export function previewStatus(dir: string, opts: { theme?: string } = {}): PreviewStatus {
  const hash = componentSourceHash(dir);
  const meta = readPreviewMeta(dir);
  if (!existsSync(join(dir, PREVIEW_FILE))) return { state: 'missing', reason: `${PREVIEW_FILE} is missing`, hash };
  if (!meta) return { state: 'missing', reason: `${PREVIEW_META_FILE} is missing or invalid`, hash };
  if (meta.format !== PREVIEW_FORMAT) return { state: 'stale', reason: `rendered with preview format ${meta.format} (now ${PREVIEW_FORMAT})`, meta, hash };
  if (meta.source_hash !== hash) return { state: 'stale', reason: `the sources changed since the preview was rendered (${meta.source_hash} → ${hash})`, meta, hash };
  if (opts.theme && meta.theme !== opts.theme) return { state: 'stale', reason: `rendered with theme "${meta.theme}", not "${opts.theme}"`, meta, hash };
  return { state: 'fresh', meta, hash };
}

/** Pixel size of a PNG (IHDR), undefined when the file is not a PNG. */
export function pngSize(file: string): { width: number; height: number } | undefined {
  try {
    const b = readFileSync(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return undefined;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return undefined;
  }
}

/** Markers of the generated block of a README (the rest of the file is the author's). */
export const README_BEGIN = '<!-- studio:component-preview:begin (generated by `retake components preview`; edit component.yaml instead) -->';
export const README_END = '<!-- studio:component-preview:end -->';
/**
 * How a block is found: its begin marker up to the first space — whatever the rest of the comment says (the command it
 * names changed with L5.13: a block written before then is replaced, never doubled).
 */
export const README_BEGIN_PREFIX = '<!-- studio:component-preview:begin';

function cell(v: unknown): string {
  const s = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** The generated README block: name, id, kind, description, the preview image, slots, params, duration, variants. */
export function previewReadmeBlock(manifest: ComponentManifest, meta?: Pick<PreviewMeta, 'theme' | 'at' | 'screen'>): string {
  const m = manifest;
  const lines: string[] = [README_BEGIN, `# ${m.name}`, '', `\`${m.id}\` · ${m.kind} · v${m.version}`, '', m.description, ''];
  const shot = meta ? ` — ${meta.theme} theme, at ${meta.at} s${meta.screen ? `, ${meta.screen} sample screen` : ''}` : '';
  lines.push(`![${m.name} preview${shot}](${PREVIEW_FILE})`, '');
  if (meta) lines.push(`*Preview: the ${meta.theme} theme, ${meta.at} s into the component${meta.screen ? `, over the ${meta.screen} sample screen` : ''}; the manifest's preview samples.*`, '');
  const slots = Object.entries(m.slots);
  lines.push('## Slots', '');
  if (slots.length === 0) lines.push('None.', '');
  else {
    lines.push('| slot | type | default from | max chars | description |', '|---|---|---|---|---|');
    for (const [name, s] of slots) {
      lines.push(`| \`${name}\`${s.required ? ' (required)' : ''} | ${s.type} | ${cell(s.default_from)} | ${cell(s.max_chars)} | ${cell(s.description)} |`);
    }
    lines.push('');
  }
  const props = ((m.params as JsonSchemaNode | undefined)?.properties ?? {}) as Record<string, JsonSchemaNode>;
  const defaults = paramDefaults(m.params as JsonSchemaNode | undefined);
  lines.push('## Params', '');
  if (Object.keys(props).length === 0) lines.push('None.', '');
  else {
    lines.push('| param | type | default | description |', '|---|---|---|---|');
    for (const [name, p] of Object.entries(props)) {
      const type = Array.isArray(p.enum) ? (p.enum as unknown[]).map((v) => `\`${String(v)}\``).join(' \\| ') : cell(p.type);
      const range = typeof p.minimum === 'number' || typeof p.maximum === 'number' ? ` (${p.minimum ?? '…'}–${p.maximum ?? '…'})` : '';
      lines.push(`| \`${name}\` | ${type}${range} | ${cell(defaults[name])} | ${cell(p.description)} |`);
    }
    lines.push('');
  }
  const facts: string[] = [];
  if (m.duration) facts.push(`duration ${m.duration.default} s${m.duration.min !== undefined || m.duration.max !== undefined ? ` (${m.duration.min ?? '…'}–${m.duration.max ?? '…'} s)` : ''}`);
  if (m.variants) facts.push(`variants: ${m.variants.join(', ')}`);
  if (m.tokens && m.tokens.length > 0) facts.push(`theme tokens: ${m.tokens.map((t) => `\`${t}\``).join(', ')}`);
  if (m.kind === 'layout') facts.push('geometry: see `component.yaml` (values may follow the params and the capture aspect)');
  if (facts.length > 0) lines.push(...facts.map((f) => `- ${f}`), '');
  lines.push('Regenerate the preview and this block with `retake components preview ' + m.id + '`.', README_END);
  return lines.join('\n');
}

/**
 * The README with its generated block replaced (or added at the top when the author's README has none); a missing
 * README becomes the block alone.
 */
export function mergePreviewReadme(existing: string | undefined, block: string): string {
  if (!existing || existing.trim() === '') return `${block}\n`;
  const a = existing.indexOf(README_BEGIN_PREFIX);
  const b = existing.indexOf(README_END);
  if (a >= 0 && b > a) return `${existing.slice(0, a)}${block}${existing.slice(b + README_END.length)}`;
  return `${block}\n\n${existing.replace(/^\s+/, '')}`;
}

/** Write/update `<dir>/README.md` with the generated block. Returns the file. */
export async function writePreviewReadme(dir: string, manifest: ComponentManifest, meta?: Pick<PreviewMeta, 'theme' | 'at' | 'screen'>): Promise<string> {
  const file = join(dir, 'README.md');
  const existing = existsSync(file) ? await readFile(file, 'utf8') : undefined;
  await writeFile(file, mergePreviewReadme(existing, previewReadmeBlock(manifest, meta)), 'utf8');
  return file;
}

/** The moment a preview shows: the last `preview.at` (seconds), else 1 s (or the middle of a short component). */
export function previewMoment(manifest: Pick<ComponentManifest, 'preview' | 'duration'>): number {
  const at = manifest.preview?.at;
  if (at && at.length > 0) return at[at.length - 1];
  const d = manifest.duration?.default;
  return d !== undefined && d < 2 ? d / 2 : 1;
}
