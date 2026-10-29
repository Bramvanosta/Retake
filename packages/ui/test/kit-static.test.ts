/**
 * L5.9 parts B / C: the design system's components, rendered without a browser (react-dom/server) — each one a native
 * element where one exists, named, with its roles and states; ⚑ the kit's text inputs carry the unsaved mark (a
 * TypeScript-parser check that TextField and TextArea call `useUnsavedMark(unsavedFor(value, baseline, unsaved))` and
 * that `unsaved` is a required prop; `unsavedFor` itself); ⚑ a sheet's Return default is never a destructive action;
 * the palette's filter; the menu commands' allow-list; the timecode. The behaviours that need a browser (arrows,
 * popovers, dialogs, the palette's keys, appearance switching) are studio-e2e-kit.test.ts. Review fixes: the switch named
 * by its label alone (A-L3), no dangling `aria-describedby` on a segment (A-L4), the shell's scenario in context
 * forgotten once its project no longer lists it (B-L8). The kit's plain `<bdi>` (its `shown()` / Txt) is unwrapped here;
 * app-source.test.ts plants hostile text in every slot (A-M1).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO } from '../../engine/test/helpers.js';
import {
  Blocker,
  Button,
  CommandPalette,
  Disclosure,
  EmptyState,
  Facts,
  FieldRow,
  FrameCard,
  Icon,
  ICON_NAMES,
  IconButton,
  InspectorSection,
  Kbd,
  LinkButton,
  MARK_STATES,
  MENU_COMMANDS,
  Menu,
  PosterCard,
  PosterGrid,
  Progress,
  Segmented,
  SegmentedLinks,
  Select,
  Sheet,
  SourceList,
  StatusBar,
  StatusMark,
  Switch,
  TextArea,
  TextField,
  Timecode,
  Toolbar,
  defaultAction,
  filterCommands,
  formatTimecode,
  isMenuCommand,
  spokenTimecode,
  unsavedFor,
} from '../src/app/ui-kit/index.js';
import type { Command, SheetAction } from '../src/app/ui-kit/index.js';
import { scenarioInContext } from '../src/app/shell/modes.js';

const KIT = join(REPO, 'packages', 'ui', 'src', 'app', 'ui-kit');
/** The markup, each plain `<bdi>` of the kit's `shown` / Txt unwrapped (app-source.test.ts plants hostile text in every slot). */
const html = (el: ReactElement) => renderToStaticMarkup(el).replace(/<bdi>([^<]*)<\/bdi>/g, '$1');
const noop = () => undefined;

describe('the kit renders native, named elements (L5.9 part B)', () => {
  it('buttons: a typed <button> (never a submit unless asked, never a destructive submit), a link built by hrefTo, an icon button named by its label, key caps', () => {
    expect(html(createElement(Button, { variant: 'primary', onClick: noop, children: 'Save' }))).toMatch(/^<button type="button" class="k-btn k-btn-primary k-btn-md"><span class="k-btn-label">Save<\/span><\/button>$/);
    expect(html(createElement(Button, { variant: 'secondary', submit: true, children: 'Go' }))).toContain('type="submit"');
    expect(html(createElement(Button, { variant: 'destructive', submit: true, children: 'Delete' }))).toContain('type="button"');
    const off = html(createElement(Button, { disabled: true, why: 'Open a scenario first', children: 'Render' }));
    expect(off).toMatch(/<button[^>]* disabled="" aria-describedby="([^"]+)"[^>]*>.*<span id="\1" class="k-why">Open a scenario first<\/span>/);
    const busy = html(createElement(Button, { busy: true, children: 'Saving…' }));
    expect(busy).toContain('disabled=""');
    expect(busy).not.toContain('aria-busy');
    const rec = html(createElement(Button, { variant: 'record', children: 'Capture' }));
    expect(rec).toContain('k-record-mark');
    expect(rec).toContain('aria-hidden="true"');
    expect(html(createElement(Button, { variant: 'record', recording: true, children: 'Stop recording' }))).toContain('is-recording');
    expect(html(createElement(LinkButton, { to: { name: 'projects' }, children: 'Projects' }))).toBe('<a href="#/" class="k-btn k-btn-secondary k-btn-md"><span class="k-btn-label">Projects</span></a>');
    expect(html(createElement(IconButton, { icon: 'inspector', label: 'Inspector', pressed: true, onClick: noop }))).toMatch(/^<button type="button" class="k-iconbtn k-iconbtn-md is-pressed" aria-label="Inspector" aria-pressed="true"><svg[^>]*aria-hidden="true"/);
    expect(html(createElement(IconButton, { icon: 'more', label: 'More', onClick: noop }))).not.toContain('aria-pressed');
    expect(html(createElement(Kbd, { keys: ['⌘', 'K'] }))).toBe('<span class="k-kbd-group"><kbd class="k-kbd">⌘</kbd><kbd class="k-kbd">K</kbd></span>');
    for (const name of ICON_NAMES) expect(html(createElement(Icon, { name })), name).toMatch(/^<svg class="k-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">/);
  });

  it('segmented: a fieldset of native radios with a legend (one group, the arrows native); links in a nav with aria-current, a missing place a disabled button', () => {
    const seg = html(createElement(Segmented<'a' | 'b'>, { label: 'View', value: 'b', options: [{ value: 'a', label: 'Blocks' }, { value: 'b', label: 'YAML' }], onChange: noop }));
    expect(seg).toMatch(/^<fieldset class="k-seg k-seg-md"><legend class="k-sr">View<\/legend>/);
    expect(seg.match(/<input type="radio"/g)).toHaveLength(2);
    expect(new Set([...seg.matchAll(/name="([^"]+)"/g)].map((m) => m[1])).size).toBe(1);
    expect(seg).toMatch(/<label class="k-seg-item is-current"><input type="radio" class="k-seg-input" name="[^"]+" checked="" value="b"\/>/);
    const links = html(createElement(SegmentedLinks, { label: 'Mode', items: [{ key: 's', label: 'Script', to: { name: 'scenario', slug: 'p', scenario: 'q', tab: 'blocks' }, current: true }, { key: 'e', label: 'Edit', to: { name: 'timeline', slug: 'p', scenario: 'q' }, current: false }] }));
    expect(links).toMatch(/^<nav class="k-seg k-seg-md k-seg-links" aria-label="Mode"><a href="#\/p\/p\/s\/q" class="k-seg-item is-current" aria-current="page">/);
    const none = html(createElement(SegmentedLinks, { label: 'Mode', hint: 'Open a scenario', items: [{ key: 's', label: 'Script', to: null, current: false }] }));
    expect(none).toMatch(/<button type="button" class="k-seg-item" disabled="" aria-describedby="([^"]+)">.*<span id="\1" class="k-sr">Open a scenario<\/span>/);
    // Review A-L4: with only some segments off, the reason is there too — every aria-describedby id resolves.
    const some = html(createElement(SegmentedLinks, { label: 'Mode', hint: 'Open a scenario', items: [{ key: 's', label: 'Script', to: null, current: false }, { key: 'e', label: 'Edit', to: { name: 'projects' }, current: false }] }));
    const ids = [...some.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(1);
    for (const x of ids) expect(some, x).toContain(`id="${x}"`);
  });

  it('switch: a native checkbox with role="switch" inside its label; fields: a visible label bound to a native input / textarea / select, an error in words', () => {
    const sw = html(createElement(Switch, { label: 'Captions', checked: true, onChange: noop, hint: 'Burned into the video' }));
    // Review A-L3: named by the label alone (aria-labelledby), the hint its description.
    expect(sw).toMatch(/^<label class="k-switch-row"><span class="k-switch-text"><span id="([^"]+)" class="k-switch-label">Captions<\/span><span id="([^"]+)" class="k-hint">Burned into the video<\/span><\/span>.*<input type="checkbox" role="switch" class="k-switch-input" aria-labelledby="\1" aria-describedby="\2" checked=""\/>/);
    const tf = html(createElement(TextField, { label: 'Name', value: 'x', onChange: noop, unsaved: null, error: 'A name is required' }));
    const id = /<label class="k-field-label" for="([^"]+)">Name<\/label>/.exec(tf)?.[1];
    expect(id).toBeTruthy();
    expect(tf).toContain(`<input id="${id}" type="text" class="k-input" aria-invalid="true" aria-describedby="${id}-error" value="x"/>`);
    expect(tf).toContain(`<span id="${id}-error" class="k-error"><span class="k-error-word">Error:</span> A name is required</span>`);
    expect(html(createElement(TextArea, { label: 'Notes', value: '', onChange: noop, unsaved: null, mono: true }))).toMatch(/<textarea id="[^"]+" rows="4" class="k-input k-textarea k-mono">/);
    const sel = html(createElement(Select, { label: 'Take', value: 'b', options: [{ value: 'a', label: 'Take 1' }, { value: 'b', label: 'Take 2' }], onChange: noop }));
    expect(sel).toMatch(/<label class="k-field-label" for="([^"]+)">Take<\/label>.*<select id="\1" class="k-select-input">/);
    expect(sel).toContain('<option value="b" selected="">Take 2</option>');
    expect(html(createElement(FieldRow, { label: 'Size', children: 'x' }))).toMatch(/^<div class="k-field k-field-row" role="group" aria-labelledby="([^"]+)"><span id="\1" class="k-field-label">Size<\/span>/);
  });

  it('status marks: a hidden shape and a visible word for each state; the timecode\'s spoken form in hidden text; progress with its values', () => {
    for (const state of MARK_STATES) {
      const m = html(createElement(StatusMark, { state, word: 'Ready' }));
      expect(m, state).toMatch(new RegExp(`^<span class="k-mark" data-state="${state}"><(?:span|svg) class="k-mark-[a-z-]+[^"]*"[^>]*aria-hidden="true"`));
      expect(m, state).toContain('<span class="k-mark-word">Ready</span>');
    }
    expect(formatTimecode(49.04)).toBe('00:00:49.0');
    expect(formatTimecode(3725.25)).toBe('01:02:05.3');
    expect(spokenTimecode(72.5)).toBe('1 minute 12.5 seconds');
    const tc = html(createElement(Timecode, { seconds: 49, total: 72, frame: 1470 }));
    expect(tc).toContain('aria-hidden="true">00:00:49.0');
    expect(tc).toContain('<span class="k-sr">49.0 seconds of 1 minute 12.0 seconds, frame 1470</span>');
    expect(tc).not.toContain('aria-label');
    const p = html(createElement(Progress, { label: 'Rendering', value: 30, max: 120, valueText: '25 %' }));
    expect(p).toMatch(/role="progressbar" aria-labelledby="[^"]+" aria-valuemin="0" aria-valuemax="120" aria-valuenow="30" aria-valuetext="25 %"/);
    const ind = html(createElement(Progress, { label: 'Preparing' }));
    expect(ind).toContain('is-indeterminate');
    expect(ind).not.toMatch(/aria-valuenow|aria-busy/);
  });

  it('panes: a labelled toolbar, a status region, a source list of headed groups with aria-current, sections, an empty state, a one-line blocker with its action', () => {
    expect(html(createElement(Toolbar, { label: 'Steps', children: createElement(Button, { children: 'Add' }) }))).toMatch(/^<div role="toolbar" aria-label="Steps" class="k-toolbar">/);
    expect(html(createElement(StatusBar, { state: 'Connected', actions: 'x' }))).toMatch(/^<div class="k-statusbar" role="region" aria-label="Status">/);
    const src = html(createElement(SourceList, { label: 'Studio', groups: [{ key: 'g', heading: 'Projects', items: [{ key: 'a', to: { name: 'projects' }, label: 'All', current: true, count: 3 }, { key: 'b', to: { name: 'project', slug: 'b' }, label: 'B', current: false, flag: 'unsaved', children: [{ key: 'c', to: { name: 'readme', slug: 'b' }, label: 'README', current: false }] }] }] }));
    expect(src).toMatch(/^<nav class="k-source" aria-label="Studio"><div class="k-source-group"><h2 class="k-source-heading">Projects<\/h2>/);
    expect(src).toContain('<a href="#/" class="k-source-item is-current" aria-current="page">');
    expect(src).toContain('<span class="k-source-flag">unsaved</span>');
    expect(src).toContain('k-source-depth-1');
    expect(html(createElement(InspectorSection, { title: 'Step', children: 'x' }))).toMatch(/^<section class="k-section" aria-labelledby="([^"]+)"><h3 id="\1" class="k-section-title">Step<\/h3>/);
    expect(html(createElement(InspectorSection, { title: 'More', collapsible: true, children: 'x' }))).toMatch(/^<details class="k-section" open=""><summary class="k-section-title">More<\/summary>/);
    expect(html(createElement(EmptyState, { title: 'No scenario yet', children: 'Write one.' }))).toMatch(/^<section class="k-empty" aria-labelledby="([^"]+)"><h2 id="\1" class="k-empty-title">No scenario yet<\/h2>/);
    const b = html(createElement(Blocker, { word: 'Blocked', children: 'The setup hook needs Postgres', fix: { copy: 'brew services start postgresql' } }));
    expect(b).toContain('<span class="k-mark-word">Blocked</span>');
    expect(b).toContain('<bdi class="k-blocker-code k-mono">brew services start postgresql</bdi>');
    expect(b).toContain('Copy command');
    expect(b).toContain('role="status"');
  });

  it('cards: one control — a pressed button that selects or a link that goes; the picture inside it', () => {
    const sel = html(createElement(FrameCard, { picture: createElement('span', null, 'pic'), number: 3, title: 'Checkout', meta: '4 steps', selected: true, onSelect: noop }));
    expect(sel).toMatch(/^<button type="button" class="k-card k-card-frame is-selected" aria-pressed="true">/);
    expect(html(createElement(PosterCard, { picture: 'p', title: 'Quote', to: { name: 'project', slug: 'q' } }))).toMatch(/^<a href="#\/p\/q" class="k-card k-card-poster">/);
  });

  it('L5.10a: the productions listbox — one tab stop, options with aria-selected, the active one named by aria-activedescendant; none selected: no aria-activedescendant at all (review A-L6)', () => {
    const items = [
      { id: 'quote', picture: 'p1', title: 'Quote', meta: createElement(StatusMark, { state: 'warn', word: 'Render outdated' }) },
      { id: 'catalogue', picture: 'p2', title: 'Catalogue' },
    ];
    const none = html(createElement(PosterGrid, { label: 'Productions', items, selected: null, onSelect: noop, onOpen: noop }));
    expect(none).toMatch(/^<ul class="k-posters" role="listbox" aria-label="Productions" tabindex="0">/);
    expect(none).not.toContain('aria-activedescendant');
    expect(none.match(/role="option"/g)).toHaveLength(2);
    expect(none.match(/aria-selected="false"/g)).toHaveLength(2);
    const sel = html(createElement(PosterGrid, { label: 'Productions', items, selected: 'catalogue', onSelect: noop, onOpen: noop }));
    const active = /aria-activedescendant="([^"]+)"/.exec(sel)?.[1];
    expect(active).toBeTruthy();
    expect(sel).toContain(`<li id="${active}" data-index="1" data-id="catalogue" role="option" aria-selected="true" class="k-card k-card-poster k-poster is-selected">`);
    // ⚑ The state is a word in the option's text (never colour alone).
    expect(sel).toContain('<span class="k-mark-word">Render outdated</span>');
    expect(sel).not.toMatch(/tabindex="0"[^>]*role="option"|role="option"[^>]*tabindex/);
  });

  it('L5.10a: facts (a dl of rows), a disclosure (a native details, closed), source rows with an icon, a lead, a value, a quiet tone and a test id', () => {
    expect(html(createElement(Facts, { rows: [{ key: 'l', label: 'Length', value: '1:00.0' }] }))).toBe('<dl class="k-facts"><div class="k-facts-row"><dt class="k-facts-label">Length</dt><dd class="k-facts-value">1:00.0</dd></div></dl>');
    // A named list: the name on a group around it (review A-L6: a dl takes no name), never on the dl.
    const named = html(createElement(Facts, { label: 'Page console', rows: [{ key: 'u', label: 'URL', value: 'x' }] }));
    expect(named).toMatch(/^<div role="group" aria-label="Page console" class="k-facts-group"><dl class="k-facts">/);
    expect(named).not.toMatch(/<dl[^>]*aria-label/);
    const d = html(createElement(Disclosure, { summary: 'Show', children: 'x' }));
    expect(d).toMatch(/^<details class="k-disclosure"><summary class="k-disclosure-summary"><svg[^>]*aria-hidden="true"/);
    expect(d).toContain('Show</summary><div class="k-disclosure-body">x</div></details>');
    const row = html(createElement(SourceList, { label: 'Studio', groups: [{ key: 'g', items: [{ key: 'a', to: { name: 'cast', slug: 'n' }, label: 'Sessions', icon: 'person', lead: '1', value: '0:09.4', quiet: true, testId: 'cast-link', current: false }] }] }));
    expect(row).toContain('<a href="#/p/n/cast" class="k-source-item is-quiet" data-testid="cast-link"><svg class="k-icon k-source-icon"');
    expect(row).toContain('<span class="k-source-lead k-mono">1</span><span class="k-source-label">Sessions</span><span class="k-source-count k-mono">0:09.4</span>');
    for (const name of ['film', 'components', 'location', 'person'] as const) expect(ICON_NAMES).toContain(name);
  });

  it('L5.10a fixes: a source row with a second line that wraps (review B-L1); a search keeps maxLength, no autocomplete, no spell check, its label visually hidden with an icon (B-L4, B-L6)', () => {
    const row = html(createElement(SourceList, { label: 'Studio', groups: [{ key: 'g', items: [{ key: 'a', to: { name: 'cast', slug: 'n' }, label: 'supplier', detail: 'signed-in', current: false }] }] }));
    expect(row).toContain('<span class="k-source-text"><span class="k-source-label">supplier</span><span class="k-source-detail">signed-in</span></span>');
    const f = html(createElement(TextField, { label: 'Search productions', type: 'search', value: '', onChange: noop, unsaved: null, labelHidden: true, maxLength: 200, autoComplete: 'off', spellCheck: false }));
    expect(f).toMatch(/<label class="k-field-label k-sr" for="[^"]+">Search productions<\/label>/);
    expect(f).toMatch(/<svg class="k-icon k-input-icon"[^>]*aria-hidden="true"/);
    expect(f).toMatch(/<input [^>]*type="search"[^>]*maxLength="200"[^>]*autoComplete="off"[^>]*spellCheck="false"/);
  });
});

describe('the overlays (L5.9 part C)', () => {
  it('menu: a trigger with aria-haspopup / aria-expanded / aria-controls / popovertarget, a popover menu of menuitem buttons with one tab stop', () => {
    const m = html(createElement(Menu, { label: 'More', icon: 'more', items: [{ id: 'a', label: 'Duplicate' }, 'separator', { id: 'b', label: 'Delete', danger: true }], onSelect: noop }));
    const id = /aria-controls="([^"]+)"/.exec(m)?.[1];
    expect(m).toMatch(new RegExp(`<button type="button" class="k-iconbtn k-iconbtn-md" aria-label="More" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" popovertarget="${id}">`, 'i'));
    expect(m).toContain(`<div id="${id}" popover="auto" role="menu" aria-label="More" class="k-menu">`);
    expect(m.match(/role="menuitem"/g)).toHaveLength(2);
    expect(m.match(/tabindex="0"/g)).toHaveLength(1);
    expect(m).toContain('role="separator"');
  });

  it('sheet: a dialog (alertdialog when destructive) named by its title; ⚑ Return never chooses a destructive action', () => {
    const acts: SheetAction[] = [
      { id: 'cancel', label: 'Cancel', isCancel: true },
      { id: 'discard', label: 'Discard', variant: 'destructive', isDefault: true },
    ];
    const s = html(createElement(Sheet, { open: false, title: 'Discard the recording?', actions: acts, onAction: noop, destructive: true, children: 'It cannot be undone.' }));
    expect(s).toMatch(/^<dialog class="k-sheet" role="alertdialog" aria-labelledby="([^"]+)" aria-describedby="[^"]+"><h2 id="\1"/);
    // The destructive default falls back to the cancel action: the focus (and Return) land on Cancel.
    expect(defaultAction(acts)?.id).toBe('cancel');
    expect(s).toMatch(/<button data-default="yes" type="button" class="k-btn k-btn-secondary k-btn-md"><span class="k-btn-label">Cancel/);
    expect(s.match(/data-default="yes"/g)).toHaveLength(1);
    // A safe default stays the default ("Capture anyway" loses nothing).
    expect(defaultAction([{ id: 'c', label: 'Cancel', isCancel: true }, { id: 'go', label: 'Capture anyway', variant: 'primary', isDefault: true }])?.id).toBe('go');
  });

  it('palette: a dialog with a combobox (aria-controls, aria-activedescendant) and a listbox of grouped options; the filter', () => {
    const cmds: Command[] = [
      { id: 'p', label: 'Projects', group: 'Go to', run: noop },
      { id: 'g', label: 'UI gallery', group: 'Go to', hint: 'every component', run: noop },
      { id: 'i', label: 'Show inspector', group: 'Commands', kbd: ['⌥', '⌘', 'I'], run: noop },
    ];
    const p = html(createElement(CommandPalette, { open: true, onClose: noop, commands: cmds }));
    // Closed, it holds no option (and says nothing).
    expect(html(createElement(CommandPalette, { open: false, onClose: noop, commands: cmds }))).not.toMatch(/role="option"|Nothing matches/);
    const list = /role="combobox" aria-expanded="true" aria-controls="([^"]+)"/.exec(p)?.[1];
    expect(list).toBeTruthy();
    expect(p).toContain(`<div id="${list}" role="listbox" aria-label="Commands" class="k-palette-list">`);
    expect(p).toMatch(/aria-activedescendant="([^"]+)".*<div id="\1" role="option" aria-selected="true" class="k-palette-option is-active">/);
    expect(p.match(/role="group"/g)).toHaveLength(2);
    expect(filterCommands(cmds, 'gal').map((c) => c.id)).toEqual(['g']);
    expect(filterCommands(cmds, 'COMPONENT').map((c) => c.id)).toEqual(['g']);
    expect(filterCommands(cmds, 'show insp').map((c) => c.id)).toEqual(['i']);
    expect(filterCommands(cmds, '').map((c) => c.id)).toEqual(['p', 'g', 'i']);
    expect(filterCommands(cmds, 'zzz')).toEqual([]);
  });

  it('the menu commands: an allow-list of ids (the desktop menu sends nothing else)', () => {
    expect([...MENU_COMMANDS]).toEqual(['palette', 'mode-script', 'mode-shoot', 'mode-edit', 'mode-review', 'inspector']);
    for (const id of MENU_COMMANDS) expect(isMenuCommand(id)).toBe(true);
    for (const id of ['rehearse', 'capture', 'render', '', 'PALETTE', null, 1, { id: 'palette' }]) expect(isMenuCommand(id)).toBe(false);
  });
});

describe('⚑ the kit\'s text inputs carry the unsaved mark (L5.2b useUnsavedMark, L5.9)', () => {
  it('unsavedFor: the item only while the value differs from its baseline and an item is given', () => {
    const item = { kind: 'step_form', project: 'p', scenario: 's' } as const;
    expect(unsavedFor('a', 'a', item)).toBeNull();
    expect(unsavedFor('ab', 'a', item)).toBe(item);
    expect(unsavedFor('ab', 'a', null)).toBeNull();
    expect(unsavedFor('', '', item)).toBeNull();
  });

  it('TextField and TextArea call useUnsavedMark(unsavedFor(value, baseline, unsaved)); `unsaved` is required (UnsavedItem | null, no default)', async () => {
    const text = await readFile(join(KIT, 'fields.tsx'), 'utf8');
    expect(markedInputs(text)).toEqual(['TextArea', 'TextField']);
    // The planted twin: the call gone (or reading another value) → not marked.
    expect(markedInputs(text.replace('export function TextArea', 'export function TextAreaX').replace(/(export function TextAreaX[\s\S]*?)useUnsavedMark\(unsavedFor\(value, baseline, unsaved\)\);/, '$1'))).toEqual(['TextField']);
    expect(markedInputs(text.replace(/useUnsavedMark\(unsavedFor\(value, baseline, unsaved\)\);/g, 'useUnsavedMark(null);'))).toEqual([]);
    // `unsaved` is declared required in the props both share.
    const src = ts.createSourceFile('fields.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let prop: ts.PropertySignature | undefined;
    src.forEachChild(function find(n): void {
      if (ts.isInterfaceDeclaration(n) && n.name.text === 'TextCommon') for (const m of n.members) if (ts.isPropertySignature(m) && m.name.getText(src) === 'unsaved') prop = m;
      n.forEachChild(find);
    });
    expect(prop, 'TextCommon.unsaved').toBeDefined();
    expect(prop!.questionToken).toBeUndefined();
    expect(prop!.type!.getText(src)).toBe('UnsavedItem | null');
    for (const fn of ['TextField', 'TextArea']) expect(text).toMatch(new RegExp(`export function ${fn}\\(\\{[^}]*\\bunsaved,`));
  });
});

/** The exported text inputs whose body calls `useUnsavedMark(unsavedFor(value, baseline, unsaved))` (a parser check). */
function markedInputs(text: string): string[] {
  const src = ts.createSourceFile('fields.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  src.forEachChild((n) => {
    if (!ts.isFunctionDeclaration(n) || !n.name || !/^Text(Field|Area)$/.test(n.name.text) || !n.body) return;
    const marked = n.body.statements.some((s) => {
      if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) return false;
      const c = s.expression;
      if (c.expression.getText(src) !== 'useUnsavedMark' || c.arguments.length !== 1) return false;
      const a = c.arguments[0];
      return ts.isCallExpression(a) && a.expression.getText(src) === 'unsavedFor' && a.arguments.map((x) => x.getText(src)).join(',') === 'value,baseline,unsaved';
    });
    if (marked) out.push(n.name.text);
  });
  return out.sort();
}

describe('the shell\'s scenario in context (L5.9, review B-L8)', () => {
  it('a project page offers the scenario opened last in it — forgotten once the project no longer lists it', () => {
    const memory = new Map<string, string>();
    expect(scenarioInContext({ name: 'scenario', slug: 'p', scenario: 'quote', tab: 'blocks' }, memory, ['quote', 'tour'])).toEqual({ slug: 'p', scenario: 'quote' });
    expect(scenarioInContext({ name: 'project', slug: 'p' }, memory, ['quote', 'tour'])).toEqual({ slug: 'p', scenario: 'quote' });
    expect(scenarioInContext({ name: 'project', slug: 'q' }, memory, ['quote'])).toBeNull();
    // quote deleted (or renamed): no mode links to it, and it stays forgotten.
    expect(scenarioInContext({ name: 'readme', slug: 'p' }, memory, ['tour'])).toBeNull();
    expect(memory.has('p')).toBe(false);
    expect(scenarioInContext({ name: 'project', slug: 'p' }, memory, ['quote', 'tour'])).toBeNull();
    // Without a list (the projects not loaded yet), the memory answers.
    memory.set('p', 'tour');
    expect(scenarioInContext({ name: 'themes', slug: 'p' }, memory)).toEqual({ slug: 'p', scenario: 'tour' });
  });
});
