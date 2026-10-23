/**
 * Unsaved README text per project, kept while the person moves around the app (this tab only, never stored): the
 * editor starts from it, the sidebar marks the project's README "unsaved", closing or reloading the tab warns, and
 * when the session ends the text stays on screen to copy (main.tsx).
 *
 * Line breaks: a textarea gives its text back with LF line breaks whatever it was given (CR LF and lone CR become LF),
 * so the editor works on LF text and remembers the file's own line breaks (`eol`) to save with them (review B M1): a
 * CR LF README stays CR LF, and loading one is not an unsaved change.
 */
import { useEffect, useState } from 'react';

export type Eol = '\n' | '\r\n';

export interface Draft {
  /** The editor's text (LF line breaks). */
  text: string;
  /** What the text was based on: the README as loaded or last saved (LF line breaks; hash null: there was none), and its line breaks. */
  base: { text: string; hash: string | null; eol: Eol };
}

/** CR LF and lone CR → LF: what a textarea makes of any text. */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** The line breaks a file uses: CR LF when most of its line breaks are CR LF, else LF. */
export function detectEol(s: string): Eol {
  const crlf = s.match(/\r\n/g)?.length ?? 0;
  const all = s.match(/\r\n|\r|\n/g)?.length ?? 0;
  return crlf > 0 && crlf * 2 >= all ? '\r\n' : '\n';
}

/** LF text with `eol` line breaks. */
export function toEol(s: string, eol: Eol): string {
  return eol === '\n' ? s : s.replace(/\n/g, eol);
}

const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();

export function isDirty(d: Draft | undefined): boolean {
  return d !== undefined && d.text !== d.base.text;
}

export function getDraft(slug: string): Draft | undefined {
  return drafts.get(slug);
}

export function setDraft(slug: string, d: Draft | undefined): void {
  if (d === undefined) drafts.delete(slug);
  else drafts.set(slug, d);
  for (const l of listeners) l();
}

export function anyDirty(): boolean {
  for (const d of drafts.values()) if (isDirty(d)) return true;
  return false;
}

/** Every project's unsaved text (shown when the session ends, so nothing typed is lost with the editor). */
export function dirtyDrafts(): Array<{ slug: string; text: string }> {
  return [...drafts].filter(([, d]) => isDirty(d)).map(([slug, d]) => ({ slug, text: d.text }));
}

/** Whether the project's README has unsaved text, re-rendered on change. */
export function useDirty(slug: string | undefined): boolean {
  const [dirty, set] = useState(() => (slug ? isDirty(drafts.get(slug)) : false));
  useEffect(() => {
    const l = () => set(slug ? isDirty(drafts.get(slug)) : false);
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, [slug]);
  return dirty;
}

/** Closing or reloading the tab with unsaved text asks first (the browser's own prompt). */
export function guardUnload(): () => void {
  const onBefore = (e: BeforeUnloadEvent) => {
    if (!anyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBefore);
  return () => window.removeEventListener('beforeunload', onBefore);
}
