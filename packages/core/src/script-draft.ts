/**
 * Script → draft (L3.3, `scenario_from_script`, R-MCP-22): a deterministic aid — no model, no network, nothing written.
 * A timecoded Markdown table (one GFM pipe table; English or French headers) becomes an outline (scenes, beats, times,
 * durations, captions, pages) and a draft scenario: one `hold` per beat, sized to its duration, with the script's action
 * as its `note`. The draft validates and dry-runs, but it films nothing until the steps are written (page_inspect gives
 * the targets): it is a skeleton for whoever writes the scenario, never the scenario itself.
 *
 * Columns (header aliases, case and accents ignored): time (`M:SS` or a range `M:SS–M:SS`), end, duration (`5`, `5s`,
 * `M:SS`), scene, action, caption, kicker, page (an environment page key, `key:/path`, a `/path`, or a URL of one of the
 * environment's pages or display hosts — mapped to its page key: a draft never carries a URL), type (scene,
 * interstitial, title, outro).
 */
import { Document, isMap, isPair, isScalar, visit } from 'yaml';
import { inspectPathProblem } from './inspect.js';
import type { ResolvedEnvironment } from './types.js';
import { didYouMean } from './validation/suggest.js';

export type ScriptColumn = 'time' | 'end' | 'duration' | 'scene' | 'action' | 'caption' | 'kicker' | 'page' | 'type';
export type ScriptRowType = 'scene' | 'interstitial' | 'title' | 'outro';

/** A problem of the script, positioned in the Markdown (1-based line and column). */
export interface ScriptIssue {
  severity: 'error' | 'warning';
  line: number;
  col?: number;
  message: string;
}

export interface OutlineBeat {
  /** Line of its row in the Markdown. */
  line: number;
  start_s: number;
  duration_s: number;
  action?: string;
  caption?: { kicker?: string; text: string };
}

export interface OutlineScene {
  kind: 'scene' | 'interstitial';
  /** The scene id written in the draft (interstitials keep their default id). */
  id?: string;
  /** The scene name as the script writes it. */
  name?: string;
  line: number;
  start_s: number;
  duration_s: number;
  page?: string;
  path?: string;
  /** Interstitial text. */
  text?: string;
  kicker?: string;
  beats: OutlineBeat[];
}

export interface ScriptOutline {
  /** Header of each recognised column, as written. */
  columns: Partial<Record<ScriptColumn, string>>;
  rows: number;
  title?: { line: number; kicker?: string; text: string; duration_s: number };
  outro?: { line: number; text: string; duration_s: number };
  scenes: OutlineScene[];
  /** Sum of the rows' durations (title and outro included). */
  total_s: number;
}

export interface ScriptDraft {
  outline: ScriptOutline;
  /** The draft scenario ("" when the script has no usable table). */
  yaml: string;
  issues: ScriptIssue[];
}

export interface ScriptDraftOptions {
  /** The environment whose page keys (and URLs, display hosts) the `page` column maps to. */
  env: Pick<ResolvedEnvironment, 'name' | 'pages' | 'display'>;
  /** The draft's `video` (default "draft"). */
  video?: string;
}

/** Longest script read. */
export const SCRIPT_MARKDOWN_MAX = 100_000;
/** Most rows a table may have. */
export const SCRIPT_ROWS_MAX = 500;
/** Seconds given to a row whose duration nothing says. */
export const SCRIPT_DEFAULT_ROW_S = 5;
/** Timing targets of the reference look (review's default rules): video 60–120 s (± 25 %), scene 4–25 s, < 2 s unreadable. */
export const SCRIPT_TIMING = Object.freeze({ video_min_s: 45, video_max_s: 150, scene_min_s: 4, scene_max_s: 25, scene_too_short_s: 2 });

/** Lower case, no accents, no Markdown emphasis, no "(…)" note, single spaces, straight apostrophes. */
function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[*_:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIASES: Record<ScriptColumn, string[]> = {
  time: ['time', 'timecode', 'tc', 'start', 'temps', 'debut', 'minutage'],
  end: ['end', 'fin'],
  duration: ['duration', 'length', 'duree'],
  scene: ['scene', 'section', 'chapter', 'sequence', 'chapitre'],
  action: ['action', 'on screen', 'screen', 'visual', "a l'ecran", 'ecran', 'visuel'],
  caption: ['caption', 'text', 'subtitle', 'voice-over', 'voice over', 'vo', 'texte', 'legende', 'sous-titre', 'voix off'],
  kicker: ['kicker', 'surtitre'],
  page: ['page', 'url'],
  type: ['type', 'kind'],
};

const TYPES: Record<ScriptRowType, string[]> = {
  scene: ['', 'scene', 'sequence'],
  interstitial: ['interstitial', 'intertitre', 'carton'],
  title: ['title', 'titre', 'intro'],
  outro: ['outro', 'end', 'fin', 'conclusion'],
};

function columnOf(header: string): ScriptColumn | undefined {
  const h = norm(header);
  for (const [col, names] of Object.entries(ALIASES) as Array<[ScriptColumn, string[]]>) if (names.includes(h)) return col;
  return undefined;
}

interface Cell {
  text: string;
  /** 1-based column of the cell's text (or of where it would be). */
  col: number;
}

/** The cells of a table line: optional outer pipes, `\|` for a pipe inside a cell, trimmed texts with their columns. */
function cells(line: string): Cell[] {
  const out: Cell[] = [];
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i++;
  if (line[i] === '|') i++;
  let text = '';
  let start = i;
  const push = () => {
    const lead = text.length - text.trimStart().length;
    out.push({ text: text.trim(), col: start + lead + 1 });
  };
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') {
      text += '|';
      i++;
    } else if (c === '|') {
      push();
      text = '';
      start = i + 1;
    } else text += c;
  }
  if (text.trim() !== '' || !/\|\s*$/.test(line)) push();
  return out;
}

const SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Seconds of `M:SS` (minutes may exceed 59); null when it is not that. */
function clock(s: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** `M:SS` or a range `M:SS–M:SS` (en dash, hyphen, em dash, arrow, "to", "à"). */
function timeCell(s: string): { start: number; end?: number } | null {
  const parts = s.trim().split(/\s*(?:–|—|→|->|-)\s*|\s+(?:to|à|a)\s+/i).filter((p) => p !== '');
  if (parts.length === 1) {
    const start = clock(parts[0]);
    return start === null ? null : { start };
  }
  if (parts.length === 2) {
    const start = clock(parts[0]);
    const end = clock(parts[1]);
    return start === null || end === null ? null : { start, end };
  }
  return null;
}

/** `5`, `5s`, `5 s`, `4.5` or `M:SS`. */
function durationCell(s: string): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*s?$/i.exec(s.trim());
  if (m) return Number(m[1].replace(',', '.'));
  return clock(s);
}

const round = (n: number) => Math.round(n * 100) / 100;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

interface Row {
  line: number;
  get(c: ScriptColumn): Cell | undefined;
  type: ScriptRowType;
  start: number;
  duration: number;
}

interface Table {
  header: number;
  columns: Map<ScriptColumn, number>;
  written: Partial<Record<ScriptColumn, string>>;
  lines: Array<{ line: number; cells: Cell[] }>;
}

/** Every pipe table of the Markdown (header line, separator, body lines up to the first non-table line). */
function tables(lines: string[]): Table[] {
  const out: Table[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes('|') || !SEPARATOR_RE.test(lines[i + 1]) || !lines[i + 1].includes('-')) continue;
    const head = cells(lines[i]);
    const columns = new Map<ScriptColumn, number>();
    const written: Partial<Record<ScriptColumn, string>> = {};
    head.forEach((c, k) => {
      const col = columnOf(c.text);
      if (col && !columns.has(col)) {
        columns.set(col, k);
        written[col] = c.text;
      }
    });
    const body: Table['lines'] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].includes('|') && lines[j].trim() !== ''; j++) body.push({ line: j + 1, cells: cells(lines[j]) });
    out.push({ header: i + 1, columns, written, lines: body });
    i = j - 1;
  }
  return out;
}

const usable = (t: Table) =>
  (t.columns.has('time') || t.columns.has('duration')) && (t.columns.has('scene') || t.columns.has('action') || t.columns.has('caption'));

/** A slug-like scene id from a scene name ("" when nothing is left). */
function sceneSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * The page key and path of a page cell: a page key, `key:/path`, `key /path`, a `/path` (on `current`), or a URL (or
 * a bare host) of one of the environment's pages or display bases. A string otherwise: why it maps to nothing.
 */
function pageCell(v: string, env: ScriptDraftOptions['env'], current: string | undefined): { page: string; path: string } | string {
  const keys = Object.keys(env.pages);
  const key = (k: string) => keys.find((x) => x.toLowerCase() === k.toLowerCase());
  const checked = (page: string, path: string) => {
    const problem = inspectPathProblem(path);
    return problem ? `page "${v}": ${problem}` : { page, path };
  };
  const exact = key(v);
  if (exact) return { page: exact, path: '/' };
  const m = /^([A-Za-z_][\w-]*)\s*(?::|\s)\s*(\/.*)$/.exec(v);
  if (m && key(m[1])) return checked(key(m[1])!, m[2]);
  if (v.startsWith('/') && !v.startsWith('//')) {
    if (!current) return `page "${v}": a path, but no page key before it (write "<page key>:${v}")`;
    return checked(current, v);
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
  if (hasScheme || /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]\S*)?$/i.test(v)) {
    let url: URL;
    try {
      url = new URL(hasScheme ? v : `https://${v}`);
    } catch {
      return `page "${v}": not a URL`;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `page "${v}": only http(s) URLs of the environment's pages map to a page`;
    const under = (base: string) => url.pathname === base || url.pathname.startsWith(`${base}/`) || (base === '' && url.pathname === '/');
    let best: { page: string; base: string } | undefined;
    const consider = (page: string, baseUrl: string, sameSite: (b: URL) => boolean) => {
      let b: URL;
      try {
        b = new URL(baseUrl);
      } catch {
        return;
      }
      const base = b.pathname.replace(/\/+$/, '');
      if (sameSite(b) && under(base) && (!best || base.length > best.base.length)) best = { page, base };
    };
    // A URL with a scheme: the exact origin of a page; a bare host: its host. A display base: its host.
    for (const [page, base] of Object.entries(env.pages)) consider(page, base, (b) => (hasScheme ? b.origin === url.origin : b.host === url.host));
    for (const [page, base] of Object.entries(env.display ?? {})) consider(page, base, (b) => b.host === url.host);
    if (best) return checked(best.page, `${url.pathname.slice(best.base.length) || '/'}${url.search}`);
    return `page "${v}" is not on one of environment ${env.name}'s pages (${keys.join(', ') || 'none'}): left out — a draft never carries a URL`;
  }
  const near = didYouMean(v, keys);
  return `page "${v}" is not a page key of environment ${env.name} (${keys.join(', ') || 'none'})${near ? ` — did you mean "${near}"?` : ''}`;
}

/** Turn a timecoded Markdown table into an outline and a draft scenario (see the module comment). Pure. */
export function draftScenarioFromScript(markdown: string, opts: ScriptDraftOptions): ScriptDraft {
  const issues: ScriptIssue[] = [];
  const outline: ScriptOutline = { columns: {}, rows: 0, scenes: [], total_s: 0 };
  const fail = (line: number, message: string): ScriptDraft => {
    issues.push({ severity: 'error', line, message });
    return { outline, yaml: '', issues };
  };
  if (markdown.length > SCRIPT_MARKDOWN_MAX) return fail(1, `the script is longer than ${SCRIPT_MARKDOWN_MAX} characters`);
  const lines = markdown.split(/\r?\n/);
  const all = tables(lines);
  const table = all.find(usable);
  if (!table) {
    return fail(
      all[0]?.header ?? 1,
      all.length
        ? `no table with a time (or duration) column and a scene, action or caption column: headers like | Time | Scene | Action | Caption | (or | Temps | Scène | À l'écran | Texte |)`
        : 'no Markdown table found: write one pipe table with a header row, e.g. | Time | Scene | Action | Caption |',
    );
  }
  for (const other of all) {
    if (other !== table && usable(other)) issues.push({ severity: 'warning', line: other.header, message: `another script table: only the first one (line ${table.header}) is read` });
  }
  outline.columns = table.written;
  if (table.lines.length > SCRIPT_ROWS_MAX) return fail(table.lines[SCRIPT_ROWS_MAX].line, `more than ${SCRIPT_ROWS_MAX} rows`);

  // Cells, types and explicit times.
  const parsed: Array<{ line: number; get(c: ScriptColumn): Cell | undefined; type: ScriptRowType; start?: number; end?: number; duration?: number }> = [];
  for (const { line, cells: cs } of table.lines) {
    if (cs.every((c) => c.text === '')) continue;
    const get = (c: ScriptColumn): Cell | undefined => {
      const k = table.columns.get(c);
      const cell = k === undefined ? undefined : cs[k];
      if (!cell || cell.text === '') return undefined;
      if (cell.text.includes('{{')) {
        issues.push({ severity: 'warning', line, col: cell.col, message: `${c}: a {{…}} template is not taken from a script: cell left out` });
        cell.text = '';
        return undefined;
      }
      return cell;
    };
    const typeCell = get('type');
    let type: ScriptRowType = 'scene';
    if (typeCell) {
      const t = norm(typeCell.text);
      const found = (Object.entries(TYPES) as Array<[ScriptRowType, string[]]>).find(([, names]) => names.includes(t));
      if (found) type = found[0];
      else issues.push({ severity: 'warning', line, col: typeCell.col, message: `type "${typeCell.text}": not one of scene, interstitial, title, outro — read as a scene` });
    }
    const row: (typeof parsed)[number] = { line, get, type };
    const time = get('time');
    if (time) {
      const t = timeCell(time.text);
      if (t) {
        row.start = t.start;
        if (t.end !== undefined) row.end = t.end;
      } else issues.push({ severity: 'warning', line, col: time.col, message: `time "${time.text}": expected M:SS or a range M:SS–M:SS — the row starts where the previous one ends` });
    }
    const end = get('end');
    if (end) {
      const e = clock(end.text);
      if (e === null) issues.push({ severity: 'warning', line, col: end.col, message: `end "${end.text}": expected M:SS` });
      else if (row.end === undefined) row.end = e;
    }
    const dur = get('duration');
    if (dur) {
      const d = durationCell(dur.text);
      if (d === null || d <= 0) issues.push({ severity: 'warning', line, col: dur.col, message: `duration "${dur.text}": expected seconds (5, 5s) or M:SS` });
      else row.duration = d;
    }
    parsed.push(row);
  }
  if (!parsed.length) return fail(table.header, 'the script table has no rows');

  // Starts and durations: a range or an end, else the duration column, else up to the next row's start, else a default.
  const rows: Row[] = [];
  let prevEnd = 0;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const start = p.start ?? prevEnd;
    if (p.start !== undefined && i > 0 && p.start < prevEnd - 0.001) {
      issues.push({ severity: 'warning', line: p.line, col: p.get('time')?.col, message: `starts at ${fmt(p.start)}, before the previous row ends (${fmt(prevEnd)})` });
    }
    let duration: number | undefined;
    if (p.end !== undefined) {
      duration = p.end - start;
      if (p.duration !== undefined && Math.abs(p.duration - duration) > 0.5) {
        issues.push({ severity: 'warning', line: p.line, col: p.get('duration')?.col, message: `duration ${p.duration} s, but the times say ${round(duration)} s: the times win` });
      }
    } else if (p.duration !== undefined) duration = p.duration;
    else {
      // Up to the next row with a time; rows without one in between share that span.
      const j = parsed.findIndex((q, k) => k > i && q.start !== undefined);
      if (j > 0) duration = (parsed[j].start! - start) / (j - i);
    }
    if (duration === undefined || duration <= 0) {
      issues.push({
        severity: 'warning',
        line: p.line,
        message: duration === undefined ? `no end or duration: ${SCRIPT_DEFAULT_ROW_S} s assumed` : `ends at or before its start (${fmt(start)}): ${SCRIPT_DEFAULT_ROW_S} s assumed`,
      });
      duration = SCRIPT_DEFAULT_ROW_S;
    }
    rows.push({ line: p.line, get: p.get, type: p.type, start, duration: round(duration) });
    prevEnd = start + duration;
  }
  outline.rows = rows.length;
  outline.total_s = round(rows.reduce((s, r) => s + r.duration, 0));

  // Rows → outline entries.
  const ids = new Set<string>();
  let current: OutlineScene | undefined;
  let page: string | undefined;
  const firstPage = Object.keys(opts.env.pages)[0];
  const captionOf = (r: Row): { kicker?: string; text: string } | undefined => {
    const text = r.get('caption')?.text;
    const kicker = r.get('kicker')?.text;
    if (!text) {
      if (kicker) issues.push({ severity: 'warning', line: r.line, col: r.get('kicker')!.col, message: 'a kicker without a caption: left out' });
      return undefined;
    }
    return kicker ? { kicker, text } : { text };
  };
  for (const r of rows) {
    const sceneName = r.get('scene')?.text;
    const action = r.get('action')?.text;
    if (r.type === 'title' || r.type === 'outro') {
      const text = r.get('caption')?.text ?? action ?? sceneName;
      if (!text) {
        issues.push({ severity: 'warning', line: r.line, message: `a ${r.type} row with no text: left out` });
        continue;
      }
      if (r.type === 'title') {
        if (outline.title) issues.push({ severity: 'warning', line: r.line, message: `a second title row: line ${outline.title.line} is kept` });
        else outline.title = { line: r.line, ...(r.get('kicker') ? { kicker: r.get('kicker')!.text } : {}), text, duration_s: r.duration };
      } else if (outline.outro) issues.push({ severity: 'warning', line: r.line, message: `a second outro row: line ${outline.outro.line} is kept` });
      else outline.outro = { line: r.line, text, duration_s: r.duration };
      continue;
    }
    if (r.type === 'interstitial') {
      const text = r.get('caption')?.text ?? action ?? sceneName;
      if (!text) {
        issues.push({ severity: 'warning', line: r.line, message: 'an interstitial row with no text: left out' });
        continue;
      }
      outline.scenes.push({ kind: 'interstitial', line: r.line, start_s: r.start, duration_s: r.duration, text, ...(r.get('kicker') ? { kicker: r.get('kicker')!.text } : {}), beats: [] });
      current = undefined;
      continue;
    }
    // A capture scene: a new one when the row names another scene (or nothing came before).
    const pageText = r.get('page');
    let at: { page: string; path: string } | undefined;
    if (pageText) {
      const m = pageCell(pageText.text, opts.env, page);
      if (typeof m === 'string') issues.push({ severity: 'warning', line: r.line, col: pageText.col, message: m });
      else at = m;
    }
    const same = current && (!sceneName || norm(sceneName) === norm(current.name ?? ''));
    if (!current || !same) {
      const name = sceneName ?? `Scene ${outline.scenes.filter((s) => s.kind === 'scene').length + 1}`;
      let base = sceneSlug(name) || `scene-${outline.scenes.length + 1}`;
      if (!/^[a-z0-9]/.test(base)) base = `scene-${base}`;
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      current = { kind: 'scene', id, name, line: r.line, start_s: r.start, duration_s: 0, beats: [] };
      if (!at && page === undefined && firstPage) at = { page: firstPage, path: '/' };
      if (at) {
        current.page = at.page;
        current.path = at.path;
        page = at.page;
      }
      outline.scenes.push(current);
    } else if (at) {
      issues.push({
        severity: 'warning',
        line: r.line,
        col: pageText!.col,
        message: `a page inside scene "${current.name}" (it opens at its first row): give this row its own scene name to open ${at.page}:${at.path}`,
      });
    }
    if (!action) issues.push({ severity: 'warning', line: r.line, message: 'no action: the beat holds with no note' });
    const caption = captionOf(r);
    current.beats.push({ line: r.line, start_s: r.start, duration_s: r.duration, ...(action ? { action } : {}), ...(caption ? { caption } : {}) });
    current.duration_s = round(current.duration_s + r.duration);
  }

  // Timing against the reference look.
  const t = SCRIPT_TIMING;
  if (outline.total_s < t.video_min_s || outline.total_s > t.video_max_s) {
    issues.push({ severity: 'warning', line: table.header, message: `the script lasts ${fmt(outline.total_s)} (${outline.total_s} s): the reference look targets 1:00–2:00` });
  }
  for (const s of outline.scenes) {
    if (s.kind !== 'scene') continue;
    if (s.duration_s < t.scene_too_short_s) issues.push({ severity: 'warning', line: s.line, message: `scene "${s.name}" lasts ${s.duration_s} s: too short to read (under ${t.scene_too_short_s} s)` });
    else if (s.duration_s < t.scene_min_s) issues.push({ severity: 'warning', line: s.line, message: `scene "${s.name}" lasts ${s.duration_s} s: short (the look: ${t.scene_min_s}–${t.scene_max_s} s per scene)` });
    else if (s.duration_s > t.scene_max_s) issues.push({ severity: 'warning', line: s.line, message: `scene "${s.name}" lasts ${s.duration_s} s: long — split it (the look: ${t.scene_min_s}–${t.scene_max_s} s per scene)` });
  }
  if (!outline.scenes.some((s) => s.kind === 'scene')) return fail(table.header, 'the script has no scene row (only title, outro or interstitial rows): a scenario needs at least one captured scene');

  issues.sort((a, b) => a.line - b.line || (a.col ?? 0) - (b.col ?? 0));
  return { outline, yaml: draftYaml(outline, opts.video ?? 'draft'), issues };
}

/** The draft scenario of an outline: stable key order, captions in flow style, a header comment saying what it is. */
function draftYaml(o: ScriptOutline, video: string): string {
  const value: Record<string, unknown> = { version: 1, video };
  if (o.title) value.title = o.title.kicker ? { kicker: o.title.kicker, text: o.title.text } : { text: o.title.text };
  if (o.title) value.intro = { duration: o.title.duration_s };
  if (o.outro) value.outro = { tagline: o.outro.text, duration: o.outro.duration_s };
  value.scenes = o.scenes.map((s) => {
    if (s.kind === 'interstitial') return { interstitial: { ...(s.kicker ? { kicker: s.kicker } : {}), text: s.text, duration: s.duration_s } };
    const [first, ...rest] = s.beats;
    return {
      id: s.id,
      ...(first.caption ? { caption: first.caption } : {}),
      ...(s.page ? { page: s.page, open: s.path } : {}),
      steps: [first, ...rest].map((b, i) => ({
        hold: b.duration_s,
        ...(b.action ? { note: b.action } : {}),
        ...(i > 0 && b.caption ? { caption: b.caption } : {}),
      })),
    };
  });
  const doc = new Document(value);
  doc.commentBefore = [
    ' Draft from a timecoded script (scenario_from_script): a skeleton, not a video yet.',
    ' Each beat is a `hold` as long as the script says, with the script\'s action as its `note`: replace the holds with',
    ' real steps (page_inspect gives verified targets), then scenario_validate, scenario_save and run_dry.',
  ].join('\n');
  const FLOW = new Set(['caption', 'title', 'interstitial', 'intro', 'outro']);
  visit(doc, {
    Pair(_, pair) {
      if (isPair(pair) && isScalar(pair.key) && FLOW.has(String(pair.key.value)) && isMap(pair.value)) pair.value.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0 });
}
