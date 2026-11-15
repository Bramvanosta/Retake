/**
 * The project settings' words (SettingsScreen.tsx): a hook of project.yaml (`reset:`, `hooks:`) in one line — its kind,
 * its name, what it does (an HTTP method and URL, a SQL file or first line, a shell command's first line, a script's
 * file or first line) and its rollback — never its headers, body or environment (they may hold a token). The URLs
 * come masked from project_get (a password written in a URL is `***`).
 */
import type { HookStep, NamedHooks } from '@retake/core/hooks';

export interface HookLine {
  kind: 'http' | 'sql' | 'shell' | 'js';
  name?: string;
  summary: string;
  rollback?: string;
  flags: string[];
}

const firstLine = (s: string): string => {
  const line = s.trim().split('\n')[0] ?? '';
  return s.trim().includes('\n') ? `${line} …` : line;
};

/** One hook of project.yaml in a line. */
export function hookLine(h: HookStep): HookLine {
  const flags = [...(h.destructive ? ['destructive'] : []), ...(h.confirm ? ['asks first'] : []), ...(h.optional ? ['optional'] : []), ...(h.writes === false ? ['reads only'] : [])];
  const named = h.name !== undefined ? { name: h.name } : {};
  if ('http' in h) {
    const r = h.http.rollback;
    return { kind: 'http', ...named, summary: `${h.http.method ?? 'GET'} ${h.http.url}`, ...(r ? { rollback: `${r.method ?? 'GET'} ${r.url}` } : {}), flags };
  }
  if ('sql' in h) {
    const s = h.sql;
    const summary = typeof s === 'string' ? firstLine(s) : s.file ? `file ${s.file}` : firstLine(s.query ?? '');
    const rb =
      typeof s === 'string'
        ? undefined
        : typeof s.rollback === 'string'
          ? firstLine(s.rollback)
          : s.rollback?.file
            ? `file ${s.rollback.file}`
            : s.rollback?.query
              ? firstLine(s.rollback.query)
              : undefined;
    return { kind: 'sql', ...named, summary: typeof s !== 'string' && s.db ? `${summary} (on ${s.db})` : summary, ...(rb ? { rollback: rb } : {}), flags };
  }
  if ('shell' in h) {
    const s = h.shell;
    const rb = typeof s === 'string' ? undefined : s.rollback;
    return { kind: 'shell', ...named, summary: firstLine(typeof s === 'string' ? s : s.run), ...(rb ? { rollback: firstLine(rb) } : {}), flags };
  }
  const j = h.js;
  const body = typeof j === 'string' ? firstLine(j) : j.file ? `file ${j.file}` : firstLine(j.code ?? '');
  const rb = typeof j === 'string' ? undefined : j.rollback;
  return { kind: 'js', ...named, summary: typeof j !== 'string' && j.page ? `${body}   (on page ${j.page})` : body, ...(rb ? { rollback: firstLine(rb) } : {}), flags };
}

/** project.yaml's `hooks:` as rows: a name and each of its entries in order. */
export function namedHookLines(hooks: NamedHooks | undefined): Array<{ name: string; lines: HookLine[] }> {
  return Object.entries(hooks ?? {}).map(([name, h]) => ({ name, lines: (Array.isArray(h) ? h : [h]).map(hookLine) }));
}

/** "1920 × 1080 · 30 fps · scale 2 · JPEG 90" */
export function captureWords(c: { width: number; height: number; fps: number; scale: number; format: string; quality: number; keep_frames?: boolean }): string {
  return [
    `${c.width} × ${c.height}`,
    `${c.fps} fps`,
    ...(c.scale !== 1 ? [`scale ${c.scale}`] : []),
    c.format === 'jpeg' ? `JPEG ${c.quality}` : 'PNG',
    ...(c.keep_frames ? ['frames kept'] : []),
  ].join(' · ');
}
