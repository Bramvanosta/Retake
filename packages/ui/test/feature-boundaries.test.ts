/**
 * L6.13: the Studio app's feature boundaries, from a static walk of its imports (value and type imports, re-exports
 * and dynamic imports alike). L7.32: the screens grouped by feature. The app's parts:
 *
 * - `data/` — the data layer: the only part that calls the API (`call` / `useCall` of api.ts; `request` stays
 *   private to api.ts), one module per feature, typed by StudioOps. It imports nothing of the app but api.ts and
 *   data/ itself.
 * - `ui-kit/` — the design system: it imports nothing of the app but the kit and its two foundations (bits: Txt and
 *   the shown / visible-controls helpers; route: hrefTo); the rest of the app reaches it through ui-kit/index only.
 * - `shell/` — the window around the screens: the rest of the app reaches it through its public modules only (the
 *   shell itself, its slots, its command bus, its announcer, its modes).
 * - the features — one folder each (FEATURES: record/, script/, shoot/, edit/, review/, library/, themes/,
 *   project/), its screens and their parts: anything outside a feature reaches it through its public modules only
 *   (its screens for the entry, the parts other features show or call, each listed).
 * - `words/` — the words shared across features (each feature's words that another feature also shows): they
 *   import the foundations, data/ and the kit, and nothing of the features or the shell.
 * - the root — the shared foundations (FOUNDATIONS: the API client and its session, the event stream, Txt, the
 *   routes, the drafts store, the project's store, the pictures, the tokens): they import nothing of the features,
 *   the words or the shell. main.tsx, the entry, mounts the shell and the screens.
 *
 * A part's style sheet (ui-kit/kit.css, shell/shell.css) is public: the entry imports each.
 *
 * Outside the app (the rest of src/: the server, the player, the mark), the app imports types only — the server's
 * answers and op table (`import type`: none of the server's code reaches the page) — save the few browser-safe
 * modules listed in OUTSIDE_VALUES, each with its reason.
 *
 * Exceptions are listed with a reason each, ratchet-style: a new crossing fails, and so does a listed one that is gone.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('../src/app/', import.meta.url));

/** The kit's foundations: the root modules the kit may import. */
const KIT_FOUNDATIONS = new Set(['bits', 'route']);
/** The shell's public modules: what the rest of the app may import of it. */
const SHELL_PUBLIC = new Set(['shell/AppShell', 'shell/slots', 'shell/command-bus', 'shell/say', 'shell/modes']);
/** The API's functions only data/ may import (`request` is api.ts's own; a namespace or default import reaches them all). */
const API_CALLS = new Set(['call', 'useCall', 'request']);

/**
 * The modules outside the app (src/-relative) the app may import values from, each with its reason; every other
 * import outside the app is type-only (the server's above all). Ratchet-style: a value import of another fails, a
 * listed one no longer imported fails.
 */
const OUTSIDE_VALUES: Record<string, string> = {
  mark: "the mark's drawing (MARK, MARK_GRID): its one source, pure — no DOM, no file — shared with the favicon and the desktop icon",
  'player/parent': "the preview frame's channel (connectPreview): the page's half of the player's protocol, browser-safe",
};

/** Today's crossings, each with its reason (a crossing not listed fails, a listed one that is gone fails). */
const EXCEPTIONS: Record<string, string> = {
  'ui-kit/fields.tsx -> drafts': "the kit's fields show the tab's unsaved mark (useUnsavedMark): the drafts store is the one source of it",
};

/**
 * The features, each with its public modules: what the rest of the app may import of it (the entry its screens,
 * another feature or the shell the parts it shows or calls). Ratchet-style: a public module no part outside its
 * feature imports fails (it is the feature's own again: drop it from the list).
 */
const FEATURES: Record<string, string[]> = {
  record: ['record/RecordScreen'],
  // The scenario screen; the step and field editing the timeline's inspector shares; the text field the README editor
  // shares; the board's keys the Record screen's draft list shares.
  script: ['script/ScenarioScreen', 'script/TextEditing', 'script/board-keys', 'script/field-switch', 'script/step-edit'],
  // The two shoot screens; the take browser the Record screen embeds; the take strip of the scenario screen; the
  // shoot's store and its location words (the shell's status bar, the screens that show a run).
  shoot: ['shoot/ShootBrowser', 'shoot/ShootLive', 'shoot/ShootPrepare', 'shoot/TakeStrip', 'shoot/run-location', 'shoot/shoot-data'],
  // The timeline screen; the preview frame the theme editor shows; the hand-off the review screen opens the edit with.
  edit: ['edit/PreviewFrame', 'edit/TimelineScreen', 'edit/edit-handoff'],
  // The review and comments screens; the renders list and the proposal banner the edit (and scenario) screens show.
  review: ['review/CommentsScreen', 'review/ProposalBanner', 'review/Renders', 'review/ReviewScreen'],
  // The library screen; its browser the themes screen shows.
  library: ['library/LibraryBrowser', 'library/LibraryScreen'],
  themes: ['themes/ThemesScreen'],
  // The project's screens; the create sheet the library uses; the sessions picker of the Record and shoot screens.
  project: ['project/CastScreen', 'project/CreateSheet', 'project/GalleryScreen', 'project/ProductionsScreen', 'project/ReadmeEditor', 'project/Sessions', 'project/WelcomeScreen'],
};

/** The shared foundations: the root's modules (main.tsx, the entry, apart). A new root module fails until listed here. */
const FOUNDATIONS = ['Thumb', 'api', 'bits', 'brand', 'drafts', 'events', 'id-words', 'other-copy', 'project-data', 'route', 'session', 'sse', 'thumbs', 'tokens', 'unsaved-report'];

type Part = 'data' | 'ui-kit' | 'shell' | 'words' | 'root' | 'entry' | string;
const partOf = (mod: string): Part => {
  if (!mod.includes('/')) return mod === 'main' ? 'entry' : 'root';
  return mod.slice(0, mod.indexOf('/'));
};
const isFeature = (part: Part): boolean => part in FEATURES;

interface Import {
  /** The app module imported (app-relative, no extension), or null for a package or a module outside the app. */
  module: string | null;
  /** A module of src/ outside the app (src-relative, no extension: `server/ops`, `mark`), else null. */
  outside: string | null;
  spec: string;
  /** The names it takes (`*` a namespace import, `default`, `…` a re-export of everything). */
  names: string[];
  /** Types only: `import type` / `export type`, or every name taken marked `type` (it brings no code to the page). */
  typeOnly: boolean;
}

/** Every import of a source: import declarations (type-only too), re-exports, dynamic imports. */
export function importsOf(file: string, text: string): Import[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const path = (spec: string): string | null => (spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.js$/, '') : null);
  const resolve = (spec: string): string | null => {
    const p = path(spec);
    return p === null || p.startsWith('../') ? null : p;
  };
  // The app is src/app/: one `../` out of it is src/ (a module of the package), more is outside the package.
  const outside = (spec: string): string | null => {
    const p = path(spec);
    return p !== null && p.startsWith('../') && !p.startsWith('../../') ? p.slice(3) : null;
  };
  const at = (spec: string) => ({ module: resolve(spec), outside: outside(spec), spec });
  const out: Import[] = [];
  for (const st of src.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      const names: string[] = [];
      let typeOnly = !!c?.isTypeOnly;
      if (c?.name) names.push('default');
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push('*');
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) {
        for (const e of c.namedBindings.elements) names.push((e.propertyName ?? e.name).text);
        if (!c.name && c.namedBindings.elements.length && c.namedBindings.elements.every((e) => e.isTypeOnly)) typeOnly = true;
      }
      out.push({ ...at(st.moduleSpecifier.text), names, typeOnly: typeOnly && !!c });
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const names = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : ['…'];
      const typeOnly = st.isTypeOnly || (!!st.exportClause && ts.isNamedExports(st.exportClause) && st.exportClause.elements.length > 0 && st.exportClause.elements.every((e) => e.isTypeOnly));
      out.push({ ...at(st.moduleSpecifier.text), names, typeOnly });
    }
  }
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push({ ...at(n.arguments[0].text), names: ['*'], typeOnly: false });
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** What a source breaks of the boundaries: `<file> -> <module>` for a crossing, `<file> -> api: <name>` for an API call. */
export function findings(file: string, text: string): string[] {
  const from = file.replace(/\.tsx?$/, '');
  const part = partOf(from);
  const out: string[] = [];
  for (const i of importsOf(file, text)) {
    // Outside the app: the server's types only; a value of another module only when OUTSIDE_VALUES lists it.
    if (i.outside !== null && !i.typeOnly && (i.outside.startsWith('server/') || !(i.outside in OUTSIDE_VALUES))) out.push(`${file} -> ${i.outside}: value`);
    if (i.module === null) continue;
    const to = partOf(i.module);
    if (i.module === 'api' && part !== 'data' && from !== 'api') {
      for (const n of i.names) if (API_CALLS.has(n) || n === '*' || n === 'default' || n === '…') out.push(`${file} -> api: ${n}`);
      continue;
    }
    if (to === part) continue;
    // A part's style sheet is public (the entry, main.tsx, imports each part's: kit.css, shell.css).
    if (i.module.endsWith('.css')) continue;
    const crossing = `${file} -> ${i.module}`;
    if (part === 'data' && !(i.module === 'api' || to === 'data')) out.push(crossing);
    else if (part === 'ui-kit' && !(to === 'ui-kit' || KIT_FOUNDATIONS.has(i.module))) out.push(crossing);
    else if (part !== 'ui-kit' && to === 'ui-kit' && i.module !== 'ui-kit/index') out.push(crossing);
    else if (part !== 'shell' && to === 'shell' && !SHELL_PUBLIC.has(i.module)) out.push(crossing);
    // The foundations and the shared words import nothing of the features, the words (the foundations) or the shell.
    else if (part === 'root' && (isFeature(to) || to === 'words' || to === 'shell' || to === 'entry')) out.push(crossing);
    else if (part === 'words' && (isFeature(to) || to === 'shell' || to === 'entry')) out.push(crossing);
    // Another feature, the shell or the entry reaches a feature through its public modules only.
    else if (isFeature(to) && !FEATURES[to]!.includes(i.module)) out.push(crossing);
  }
  return out;
}

function appSources(): Array<[string, string]> {
  return (readdirSync(APP, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => f.split('\\').join('/'))
    .sort()
    .map((f) => [f, readFileSync(join(APP, f), 'utf8')]);
}

describe('L6.13: the Studio app\'s feature boundaries', () => {
  it('only data/ imports the API\'s call / useCall (request is api.ts\'s own); data/ holds a module per feature, each importing only api.ts and data/', () => {
    const files = appSources();
    const data = files.filter(([f]) => f.startsWith('data/')).map(([f]) => f);
    expect(data).toEqual(['data/client.ts', 'data/comments.ts', 'data/desktop.ts', 'data/edit.ts', 'data/library.ts', 'data/ops.ts', 'data/projects.ts', 'data/record.ts', 'data/renders.ts', 'data/scenarios.ts', 'data/shoot.ts', 'data/themes.ts']);
    const api = files.flatMap(([f, text]) => findings(f, text)).filter((x) => x.includes(' -> api: '));
    expect(api).toEqual([]);
    // Who imports call / useCall at all: the client, and the data function whose op is an argument (threadWrite;
    // projectRead goes through the op functions of its three reads).
    const importers = files.filter(([f, text]) => importsOf(f, text).some((i) => i.module === 'api' && i.names.some((n) => API_CALLS.has(n)))).map(([f]) => f);
    expect(importers).toEqual(['data/client.ts', 'data/comments.ts']);
    // request is not exported (api.ts's own: the session's token, the connection state).
    expect(readFileSync(join(APP, 'api.ts'), 'utf8')).toMatch(/^async function request</m);
    // The mutations: a screen calling the API itself, by name, by a namespace, by a re-export; a dynamic import.
    expect(findings('themes/ThemesScreen.tsx', "import { call, errorText } from '../api.js';")).toEqual(['themes/ThemesScreen.tsx -> api: call']);
    expect(findings('shell/AppShell.tsx', "import { useCall } from '../api.js';")).toEqual(['shell/AppShell.tsx -> api: useCall']);
    expect(findings('review/Renders.tsx', "import * as api from '../api.js';")).toEqual(['review/Renders.tsx -> api: *']);
    expect(findings('bits.ts', "export { call } from './api.js';")).toEqual(['bits.ts -> api: call']);
    expect(findings('review/Renders.tsx', "const m = await import('../api.js');")).toEqual(['review/Renders.tsx -> api: *']);
    // What stays allowed outside data/: the API's other names (errors, the connection, the session, the stream).
    expect(findings('review/Renders.tsx', "import { CallError, errorText, useConnection } from '../api.js';\nimport type { Loaded } from '../api.js';")).toEqual([]);
  });

  it('outside the app the app imports types only (the server\'s answers and op table: `import type`), save the browser-safe modules listed with their reason', () => {
    const files = appSources();
    const outside = files.flatMap(([f, text]) => importsOf(f, text).filter((i) => i.outside !== null).map((i) => ({ f, ...i })));
    // The walk sees the server's types (the screens' answers, the op table data/ops.ts derives StudioOps from).
    expect(outside.filter((i) => i.outside!.startsWith('server/')).length).toBeGreaterThan(15);
    expect(outside.some((i) => i.f === 'data/ops.ts' && i.outside === 'server/studio' && i.typeOnly)).toBe(true);
    const values = outside.filter((i) => !i.typeOnly);
    expect(values.filter((i) => i.outside!.startsWith('server/')).map((i) => `${i.f} -> ${i.outside}`)).toEqual([]);
    const used = [...new Set(values.map((i) => i.outside!))].sort();
    expect(used, 'a value import outside the app: list it in OUTSIDE_VALUES with its reason, or import its types only').toEqual(Object.keys(OUTSIDE_VALUES).sort());
    for (const [m, why] of Object.entries(OUTSIDE_VALUES)) expect(why.length, m).toBeGreaterThan(20);
    // The mutations: a value import of the server (named, mixed with a type, default, namespace, re-export, dynamic);
    // a value of a module not listed; what stays allowed — `import type`, every name marked `type`, a listed module.
    expect(findings('review/ReviewScreen.tsx', "import { reviewAnswer } from '../../server/ops.js';")).toEqual(['review/ReviewScreen.tsx -> server/ops: value']);
    expect(findings('review/ReviewScreen.tsx', "import { type RenderReviewAnswer, reviewAnswer } from '../../server/ops.js';")).toEqual(['review/ReviewScreen.tsx -> server/ops: value']);
    expect(findings('data/ops.ts', "import * as studio from '../../server/studio.js';")).toEqual(['data/ops.ts -> server/studio: value']);
    expect(findings('bits.ts', "export { UI_OPS } from '../server/studio.js';")).toEqual(['bits.ts -> server/studio: value']);
    expect(findings('review/Renders.tsx', "const m = await import('../../server/ops.js');")).toEqual(['review/Renders.tsx -> server/ops: value']);
    expect(findings('review/Renders.tsx', "import { buildUi } from '../../bundle.js';")).toEqual(['review/Renders.tsx -> bundle: value']);
    expect(findings('review/ReviewScreen.tsx', "import type { RenderReviewAnswer } from '../../server/ops.js';\nimport { type ThreadAnswer } from '../../server/comment-ops.js';\nexport type { ThemeListAnswer } from '../../server/theme-ops.js';")).toEqual([]);
    expect(findings('ui-kit/AppMark.tsx', "import { MARK } from '../../mark.js';")).toEqual([]);
    expect(findings('edit/PreviewFrame.tsx', "import { connectPreview } from '../../player/parent.js';\nimport type { FrameMessage } from '../../player/protocol.js';")).toEqual([]);
  });

  it('the parts import each other only through their public faces: data/ nothing but api.ts, the kit nothing but its foundations, the kit and the shell reached through their public modules (today\'s exceptions listed, each with its reason)', () => {
    const files = appSources();
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap(([f, text]) => findings(f, text));
    const unlisted = found.filter((x) => !(x in EXCEPTIONS));
    const stale = Object.keys(EXCEPTIONS).filter((x) => !found.includes(x));
    expect(unlisted, 'a new crossing: go through the part\'s public face, or list it with its reason').toEqual([]);
    expect(stale, 'a listed crossing is gone: remove it from EXCEPTIONS').toEqual([]);
    for (const [x, why] of Object.entries(EXCEPTIONS)) expect(why.length, x).toBeGreaterThan(20);
    // The walk sees every part (it is not vacuous): imports of data/, of the kit's index, of the shell's public modules.
    const all = files.flatMap(([f, text]) => importsOf(f, text).map((i) => i.module));
    for (const m of ['data/projects', 'ui-kit/index', 'shell/slots', 'shell/command-bus', 'api']) expect(all, m).toContain(m);
    // The mutations: data/ importing a screen's words or the kit; the kit importing a store or the shell; a screen
    // importing a kit file or a shell internal; a type import counts as much as a value import.
    expect(findings('data/themes.ts', "import { themeWords } from '../words/theme-words.js';")).toEqual(['data/themes.ts -> words/theme-words']);
    expect(findings('data/ops.ts', "import type { Route } from '../route.js';")).toEqual(['data/ops.ts -> route']);
    expect(findings('data/edit.ts', "import { Button } from '../ui-kit/index.js';")).toEqual(['data/edit.ts -> ui-kit/index']);
    expect(findings('ui-kit/Menu.tsx', "import { useProjectView } from '../project-data.js';")).toEqual(['ui-kit/Menu.tsx -> project-data']);
    expect(findings('ui-kit/Menu.tsx', "import { say } from '../shell/say.js';")).toEqual(['ui-kit/Menu.tsx -> shell/say']);
    expect(findings('ui-kit/Menu.tsx', "import { themeEdit } from '../data/themes.js';")).toEqual(['ui-kit/Menu.tsx -> data/themes']);
    expect(findings('review/ReviewScreen.tsx', "import { Button } from '../ui-kit/Button.js';")).toEqual(['review/ReviewScreen.tsx -> ui-kit/Button']);
    expect(findings('review/ReviewScreen.tsx', "import type { SetupStatus } from '../shell/setup.js';")).toEqual(['review/ReviewScreen.tsx -> shell/setup']);
    expect(findings('shell/AppShell.tsx', "import { Sheet } from '../ui-kit/Sheet.js';")).toEqual(['shell/AppShell.tsx -> ui-kit/Sheet']);
    // What stays allowed: the kit's foundations, a screen's store from the shell, data/ from anywhere, a package.
    expect(findings('main.tsx', "import './ui-kit/kit.css';\nimport './shell/shell.css';")).toEqual([]);
    expect(findings('ui-kit/Menu.tsx', "import { Txt } from '../bits.js';\nimport type { Route } from '../route.js';\nimport { useState } from 'react';")).toEqual([]);
    expect(findings('shell/StatusActions.tsx', "import { useProjectView } from '../project-data.js';\nimport { runStatus } from '../data/shoot.js';\nimport { useScenarioActions } from '../shoot/shoot-data.js';")).toEqual([]);
    expect(findings('data/ops.ts', "import type { ProjectView } from '@retake/engine';\nimport type { ThreadAnswer } from '../../server/comment-ops.js';\nimport { call } from '../api.js';")).toEqual([]);
    // The ratchet's own mutations: an exception whose crossing is gone is stale; a crossing not listed is new.
    const without = found.filter((x) => x !== 'ui-kit/fields.tsx -> drafts');
    expect(Object.keys(EXCEPTIONS).filter((x) => !without.includes(x))).toEqual(['ui-kit/fields.tsx -> drafts']);
  });

  it('L7.32: the screens are grouped by feature — a folder each, reached from outside only through its public modules; the root holds the shared foundations and words/ the shared words, neither importing a feature', () => {
    const files = appSources();
    // Every folder is a part the model knows; the root holds the foundations and the entry only.
    const folders = [...new Set(files.map(([f]) => f).filter((f) => f.includes('/')).map((f) => f.slice(0, f.indexOf('/'))))].sort();
    expect(folders).toEqual(['data', 'shell', 'ui-kit', 'words', ...Object.keys(FEATURES)].sort());
    const root = files.map(([f]) => f).filter((f) => !f.includes('/')).map((f) => f.replace(/\.tsx?$/, ''));
    expect(root).toEqual([...FOUNDATIONS, 'main'].sort());
    // Each feature's public modules exist, and each is imported from outside its feature (a stale one fails).
    const modules = new Set(files.map(([f]) => f.replace(/\.tsx?$/, '')));
    const reached = new Set(files.flatMap(([f, text]) => importsOf(f, text).filter((i) => i.module !== null && isFeature(partOf(i.module)) && partOf(i.module) !== partOf(f.replace(/\.tsx?$/, ''))).map((i) => i.module!)));
    for (const [feature, faces] of Object.entries(FEATURES)) {
      for (const m of faces) {
        expect(m.startsWith(`${feature}/`), m).toBe(true);
        expect(modules.has(m), m).toBe(true);
        expect(reached.has(m), `${m}: no part outside ${feature}/ imports it — drop it from FEATURES`).toBe(true);
      }
    }
    expect([...reached].sort()).toEqual(Object.values(FEATURES).flat().sort());
    // Each feature is reached by the entry (its screens mount there) and the walk sees a crossing between features.
    const main = files.find(([f]) => f === 'main.tsx')!;
    const mounted = new Set(importsOf(...main).map((i) => (i.module === null ? '' : partOf(i.module))));
    for (const feature of Object.keys(FEATURES)) expect(mounted.has(feature), feature).toBe(true);
    // The mutations: a feature importing another's internal (value or type), the entry or the shell reaching an
    // internal, a foundation or the shared words importing a feature (even its public face) or the shell.
    expect(findings('edit/TimelineScreen.tsx', "import { ThreadPanel } from '../review/ThreadPanel.js';")).toEqual(['edit/TimelineScreen.tsx -> review/ThreadPanel']);
    expect(findings('themes/ThemeEditor.tsx', "import type { LibraryCard } from '../library/LibraryCards.js';")).toEqual(['themes/ThemeEditor.tsx -> library/LibraryCards']);
    expect(findings('record/DraftList.tsx', "export { stepRows } from '../script/StepForm.js';")).toEqual(['record/DraftList.tsx -> script/StepForm']);
    expect(findings('main.tsx', "import { Storyboard } from './script/Storyboard.js';")).toEqual(['main.tsx -> script/Storyboard']);
    expect(findings('shell/StatusActions.tsx', "import { LiveView } from '../shoot/LiveView.js';")).toEqual(['shell/StatusActions.tsx -> shoot/LiveView']);
    expect(findings('events.ts', "import { useScenarioActions } from './shoot/shoot-data.js';")).toEqual(['events.ts -> shoot/shoot-data']);
    expect(findings('route.ts', "import type { BoardRow } from './words/board-words.js';")).toEqual(['route.ts -> words/board-words']);
    expect(findings('project-data.ts', "import { say } from './shell/say.js';")).toEqual(['project-data.ts -> shell/say']);
    expect(findings('words/board-words.ts', "import { Renders } from '../review/Renders.js';")).toEqual(['words/board-words.ts -> review/Renders']);
    expect(findings('words/shoot-words.ts', "import { SlotContext } from '../shell/slots.js';")).toEqual(['words/shoot-words.ts -> shell/slots']);
    // What stays allowed: a feature's own internals, another's public module, the words, the foundations, data/.
    expect(findings('review/ReviewScreen.tsx', "import { ThreadPanel } from './ThreadPanel.js';\nimport { editHandoff } from '../edit/edit-handoff.js';\nimport { renderWords } from '../words/render-words.js';\nimport { useProjectView } from '../project-data.js';\nimport { themeEdit } from '../data/themes.js';")).toEqual([]);
    expect(findings('main.tsx', "import { ReviewScreen } from './review/ReviewScreen.js';")).toEqual([]);
    expect(findings('words/theme-words.ts', "import { libraryWords } from './library-words.js';\nimport { Txt } from '../bits.js';")).toEqual([]);
  });
});
