/**
 * Unsaved text of the app's text editors, kept while the person moves around the app (this tab only, never stored):
 * a project's README (`readme:<slug>`, L4.1) and a scenario's YAML tab (`scenario:<slug>/<name>`, L4.3). The editor
 * starts from it, the sidebar marks the project's README "unsaved", the scenario screen turns block editing off while
 * its YAML draft is open (critique B7), closing or reloading the tab warns, and when the session ends the text stays
 * on screen to copy (main.tsx).
 *
 * Line breaks: a textarea gives its text back with LF line breaks whatever it was given (CR LF and lone CR become LF),
 * so the editor works on LF text and remembers the file's own line breaks (`eol`) to save with them (review B M1): a
 * CR LF README stays CR LF, and loading one is not an unsaved change. A scenario's YAML tab turns only CR LF into LF
 * (`crlfToLf`): a lone CR is not a line break to YAML, so a scenario holding one is shown read-only (the view's
 * `edit.yaml`, L4.3 review A M2) rather than saved back with a new line where the file had none.
 */
import { useEffect, useState } from 'react';

export type Eol = '\n' | '\r\n';

export interface Draft {
  /** The editor's text (LF line breaks). */
  text: string;
  /** What the text was based on: the file as loaded or last saved (LF line breaks; hash null: there was none), and its line breaks. */
  base: { text: string; hash: string | null; eol: Eol };
}

/** CR LF and lone CR → LF: what a textarea makes of any text. */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** CR LF → LF, a lone CR kept (a scenario's YAML tab: see the header). */
export function crlfToLf(s: string): string {
  return s.replace(/\r\n/g, '\n');
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

/** The key of a project's README draft. */
export const readmeKey = (slug: string) => `readme:${slug}`;
/** The key of a scenario's YAML draft. */
export const scenarioKey = (slug: string, name: string) => `scenario:${slug}/${name}`;

export function getDraft(key: string): Draft | undefined {
  return drafts.get(key);
}

export function setDraft(key: string, d: Draft | undefined): void {
  if (d === undefined) drafts.delete(key);
  else drafts.set(key, d);
  for (const l of listeners) l();
}

export function anyDirty(): boolean {
  for (const d of drafts.values()) if (isDirty(d)) return true;
  return false;
}

/** "README.md of shop", "scenarios/quote of shop": what a draft's key names, for a person. */
export function draftLabel(key: string): string {
  if (key.startsWith('readme:')) return `README.md of ${key.slice(7)}`;
  if (key.startsWith('scenario:')) {
    const rest = key.slice(9);
    const i = rest.indexOf('/');
    return `scenario ${rest.slice(i + 1)} of ${rest.slice(0, i)}`;
  }
  return key;
}

/** Every unsaved text (shown when the session ends, so nothing typed is lost with the editor). */
export function dirtyDrafts(): Array<{ key: string; label: string; text: string }> {
  return [...drafts].filter(([, d]) => isDirty(d)).map(([key, d]) => ({ key, label: draftLabel(key), text: d.text }));
}

/** Whether the draft of `key` has unsaved text, re-rendered on change. */
export function useDirty(key: string | undefined): boolean {
  const [dirty, set] = useState(() => (key ? isDirty(drafts.get(key)) : false));
  useEffect(() => {
    const l = () => set(key ? isDirty(drafts.get(key)) : false);
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, [key]);
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
