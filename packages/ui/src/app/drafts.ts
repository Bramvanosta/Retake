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
 *
 * L5.2b: component-local unsaved text (a step form with typed fields, a comment being written) is not a draft — it
 * goes with its component — but it sets a **mark** (`useUnsavedMark`) while it has some, so that `unsavedItems()` names
 * every unsaved text of the tab (kinds and names only, never the text) for the desktop app's quit question
 * (unsaved-report.ts). The browser's own `beforeunload` prompt stays the drafts' only (marks are not added to it).
 */
import { useEffect, useRef, useState } from 'react';

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

/**
 * What the tab holds unsaved, for the quit question: kinds and names, never the text (unsaved.ts on the server; the
 * desktop shell words each kind: desktop_core pipe.rs `UnsavedKind`). `component_brief`: the Library's "create a
 * component" words; `new_theme`: the Themes screen's new-theme form, changed and not made yet; `theme_draft`: the theme
 * editor's colour or background draft not written yet (review B L7).
 */
export interface UnsavedItem {
  kind: 'readme' | 'yaml_draft' | 'step_form' | 'comment' | 'component_brief' | 'new_theme' | 'theme_draft';
  project?: string;
  scenario?: string;
}

const marks = new Map<symbol, UnsavedItem>();

/** Set (or clear, with null) the mark `id` of a component's unsaved text. */
export function setMark(id: symbol, item: UnsavedItem | null): void {
  const before = marks.get(id);
  if (item === null) {
    if (!marks.delete(id)) return;
  } else {
    if (before && before.kind === item.kind && before.project === item.project && before.scenario === item.scenario) return;
    marks.set(id, item);
  }
  for (const l of listeners) l();
}

/** A component's unsaved text, marked while `item` is not null and the component is mounted. */
export function useUnsavedMark(item: UnsavedItem | null): void {
  const id = useRef<symbol>(Symbol('unsaved'));
  const kind = item?.kind;
  const project = item?.project;
  const scenario = item?.scenario;
  useEffect(() => {
    setMark(id.current, kind ? { kind, ...(project !== undefined ? { project } : {}), ...(scenario !== undefined ? { scenario } : {}) } : null);
  }, [kind, project, scenario]);
  useEffect(() => {
    const mine = id.current;
    return () => setMark(mine, null);
  }, []);
}

/** Every unsaved text of the tab — the drafts with unsaved text and the marks — deduplicated, in a stable order. */
export function unsavedItems(): UnsavedItem[] {
  const all = new Map<string, UnsavedItem>();
  const add = (i: UnsavedItem) => all.set(`${i.kind}\u0000${i.project ?? ''}\u0000${i.scenario ?? ''}`, i);
  for (const [key, d] of drafts) {
    if (!isDirty(d)) continue;
    if (key.startsWith('readme:')) add({ kind: 'readme', project: key.slice(7) });
    else if (key.startsWith('scenario:')) {
      const rest = key.slice(9);
      const i = rest.indexOf('/');
      add({ kind: 'yaml_draft', project: rest.slice(0, i), scenario: rest.slice(i + 1) });
    }
  }
  for (const m of marks.values()) add(m);
  return [...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, i]) => i);
}

/** `f` on every change of the drafts or the marks; returns the unsubscribe. */
export function onUnsavedChange(f: () => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
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
