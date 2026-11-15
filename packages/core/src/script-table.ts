/**
 * The Markdown table of a timecoded script: its pipe tables (header, separator, body), the columns their headers name
 * (English or French aliases, case and accents ignored), the row types, and the time / duration cells.
 */

export type ScriptColumn = 'time' | 'end' | 'duration' | 'scene' | 'action' | 'caption' | 'kicker' | 'page' | 'type';
export type ScriptRowType = 'scene' | 'interstitial' | 'title' | 'outro';

/** Lower case, no accents, no Markdown emphasis, no "(…)" note, single spaces, straight apostrophes. */
export function norm(s: string): string {
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

export const TYPES: Record<ScriptRowType, string[]> = {
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

export interface Cell {
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
export function clock(s: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** `M:SS` or a range `M:SS–M:SS` (en dash, hyphen, em dash, arrow, "to", "à"). */
export function timeCell(s: string): { start: number; end?: number } | null {
  const parts = s
    .trim()
    .split(/\s*(?:–|—|→|->|-)\s*|\s+(?:to|à|a)\s+/i)
    .filter((p) => p !== '');
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
export function durationCell(s: string): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*s?$/i.exec(s.trim());
  if (m) return Number(m[1].replace(',', '.'));
  return clock(s);
}

export interface Table {
  header: number;
  columns: Map<ScriptColumn, number>;
  written: Partial<Record<ScriptColumn, string>>;
  lines: Array<{ line: number; cells: Cell[] }>;
}

/** Every pipe table of the Markdown (header line, separator, body lines up to the first non-table line). */
export function tables(lines: string[]): Table[] {
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

export const usable = (t: Table) => (t.columns.has('time') || t.columns.has('duration')) && (t.columns.has('scene') || t.columns.has('action') || t.columns.has('caption'));
