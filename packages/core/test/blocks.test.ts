/**
 * L4.2 part 1: a scenario read as blocks (core blocks.ts) — the model behind the Studio's scenario screen (R-UI-08..10,
 * R-UI-14). Goldens of the fixture's scenarios (an outline of every block, validated against the fixture project),
 * the action badges (exhaustive), the modifier chips, targets in plain words, line ranges and comments kept for L4.3,
 * tolerance of broken scenarios, hostile text kept verbatim, URLs without `user:password@`, YAML aliases bounded.
 *
 * Goldens are written only on request: `RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/core/test/blocks.test.ts`
 * (then read the diff of test/golden/blocks/).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTION_NAMES, CHIP_KINDS, STEP_CATEGORIES, actionCategory, hookSummary, listSteps, parseScenario, parseYaml, plainTarget, scenarioBlocks, stepChips, stripUrlUserinfo, PERSON_POLICY } from '@retake/core';
import { loadProject, loadProjectTemplate, fileFacts } from '@retake/core/io';
import type { EntryBlock, HookBlock, ScenarioBlocks, SceneBlock, StepBlock } from '@retake/core';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./golden/blocks/', import.meta.url));
const FIXTURE_SCENARIOS = join(ROOT, 'projects', 'northfield-fixture', 'scenarios');

function rangeText(r: { line: number; end_line: number } | undefined): string {
  return r ? (r.line === r.end_line ? `L${r.line}` : `L${r.line}-${r.end_line}`) : 'L?';
}

function issuesText(issues: ReadonlyArray<{ severity: string; message: string }>, pad: string): string[] {
  return issues.map((i) => `${pad}! ${i.severity}: ${i.message}`);
}

function stepLine(s: StepBlock): string[] {
  const parts = [`${s.key} ${rangeText(s.range)} [${s.category}] ${s.label}`];
  if (s.id) parts.push(`id ${s.id}`);
  if (s.target) parts.push(s.target);
  if (s.summary) parts.push(s.summary);
  if (s.chips.length) parts.push(`{${s.chips.map((c) => `${c.kind}: ${c.label}`).join('; ')}}`);
  if (s.occurrence) parts.push(`#${s.occurrence}`);
  if (s.aliased) parts.push('(alias)');
  return [...(s.comment ? s.comment.split('\n').map((l) => `    # ${l}`) : []), `    ${parts.join(' · ')}`, ...issuesText(s.issues, '      ')];
}

function hookLine(h: HookBlock): string[] {
  const parts = [`${h.phase}${h.hook ? ` ${h.hook}` : ''} ${h.index + 1} ${rangeText(h.range)} ${h.kind ?? '?'}${h.name ? ` ${h.name}` : ''}: ${h.summary}`];
  if (h.rollback) parts.push(`rollback ${h.rollback}`);
  if (h.needs_person) parts.push(`needs a person: ${h.needs_person}`);
  if (h.flags.length) parts.push(`[${h.flags.map((f) => f.label).join('; ')}]`);
  return [...(h.comment ? h.comment.split('\n').map((l) => `  # ${l}`) : []), `  ${parts.join(' · ')}`, ...issuesText(h.issues, '    ')];
}

function entryLines(e: EntryBlock): string[] {
  const head = (s: string) => [...(e.comment ? e.comment.split('\n').map((l) => `# ${l}`) : []), s];
  switch (e.type) {
    case 'scene': {
      const s = e as SceneBlock;
      const facts = [
        s.page !== undefined ? `page ${s.page}${s.page_inherited ? ' (inherited)' : ''}` : undefined,
        s.pages ? `pages ${s.pages.map((p) => [p.id, p.page && `page ${p.page}`, p.open && `open ${p.open}`, p.viewport, p.label && `“${p.label}”`, p.persona && `as ${p.persona}`].filter(Boolean).join(' ')).join(' | ')}` : undefined,
        s.open !== undefined ? `open ${s.open}` : undefined,
        s.continues ? 'continues' : undefined,
        s.persona ? `persona ${s.persona}` : undefined,
        s.caption ? `caption ${s.caption.kicker ? `“${s.caption.kicker}” / ` : ''}“${s.caption.text}”` : undefined,
        s.speed !== undefined ? `speed ×${s.speed}` : undefined,
        s.still !== undefined ? `still ${s.still} s` : undefined,
        s.cursor ? `cursor ${s.cursor}` : undefined,
        s.transition ? `transition ${s.transition}` : undefined,
        s.frame ? `frame ${s.frame}` : undefined,
        s.tutorial ? `tutorial ${s.tutorial}` : undefined,
        s.irreversible ? 'irreversible' : undefined,
        s.skip ? 'skip' : undefined,
        s.offscreen ? 'offscreen' : undefined,
      ].filter(Boolean);
      return [...head(`scene ${s.id} ${rangeText(s.range)} · ${facts.join(' · ')}`), ...issuesText(s.issues, '  '), ...s.steps.flatMap(stepLine)];
    }
    case 'card':
      return [
        ...head(
          `card ${e.id} ${rangeText(e.range)} · ${[
            e.component,
            e.file && `${e.file.kind} ${e.file.path}`,
            e.slots && `slots ${Object.entries(e.slots).map(([k, v]) => `${k}=“${v}”`).join(', ')}`,
            e.params !== undefined && `params ${JSON.stringify(e.params)}`,
            e.duration !== undefined && `${e.duration} s`,
            e.transition && `transition ${e.transition}`,
          ]
            .filter(Boolean)
            .join(' · ')}`,
        ),
        ...issuesText(e.issues, '  '),
      ];
    case 'interstitial':
      return [
        ...head(`interstitial ${e.id} ${rangeText(e.range)} · ${[e.kicker && `“${e.kicker}”`, e.text && `“${e.text}”`, e.component, e.file && `${e.file.kind} ${e.file.path}`, e.duration !== undefined && `${e.duration} s`].filter(Boolean).join(' · ')}`),
        ...issuesText(e.issues, '  '),
      ];
    case 'unknown':
      return [...head(`unknown entry ${e.index} ${rangeText(e.range)}`), ...issuesText(e.issues, '  ')];
  }
}

/** A reviewable outline of every block (the goldens). */
function outline(b: ScenarioBlocks): string {
  const v = b.video;
  const lines = [
    ...(v.comment ? v.comment.split('\n').map((l) => `# ${l}`) : []),
    `video ${v.name ?? '?'}${v.title ? ` · title ${v.title.kicker ? `“${v.title.kicker}” / ` : ''}“${v.title.text ?? ''}”` : ''} · intro ${JSON.stringify(v.intro)} · outro ${JSON.stringify(v.outro)}`,
    ...[
      v.env && `env ${v.env}`,
      v.template && `template ${v.template}`,
      v.frame && `frame ${v.frame}`,
      v.music && `music ${JSON.stringify(v.music)}`,
      v.tutorial && `tutorial ${v.tutorial}`,
      v.clock && `clock ${v.clock}`,
      v.capture && `capture ${JSON.stringify(v.capture)}`,
      v.pacing && `pacing ${v.pacing.join(', ')}`,
      v.vars && `vars ${v.vars.join(', ')}`,
      v.mocks !== undefined && `mocks ${v.mocks}`,
    ]
      .filter(Boolean)
      .map((l) => `  ${l}`),
    ...issuesText(b.issues, '  '),
    ...b.hooks.setup.flatMap(hookLine),
    ...b.hooks.teardown.flatMap(hookLine),
    ...b.hooks.named.flatMap(hookLine),
    ...b.entries.flatMap(entryLines),
    `${b.step_count} steps`,
  ];
  return `${lines.join('\n')}\n`;
}

function allSteps(b: ScenarioBlocks): StepBlock[] {
  return b.entries.flatMap((e) => (e.type === 'scene' ? e.steps : []));
}

function blocksOf(text: string): ScenarioBlocks {
  return scenarioBlocks(text);
}

describe('scenarioBlocks on the fixture scenarios (goldens)', async () => {
  const project = await loadProject('northfield-fixture', ROOT);
  const template = (await loadProjectTemplate(project, undefined, { files: fileFacts(PERSON_POLICY) })).template;
  const names = project.scenarios;

  it('the fixture has its 15 scenarios', () => {
    expect(names.length).toBe(15);
  });

  it.each(names)('%s: blocks match the golden; no unknown block, no issue; steps as listSteps counts them; every block has its lines', (name) => {
    const file = join(FIXTURE_SCENARIOS, `${name}.yaml`);
    const text = readFileSync(file, 'utf8');
    const { issues, scenario } = parseScenario(text, { files: fileFacts(PERSON_POLICY), file, project, template });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const b = scenarioBlocks(text, { issues, hookFiles: { projectDir: project.dir, files: fileFacts(PERSON_POLICY) } });
    expect(b.parsed).toBe(true);
    expect(b.issues).toEqual([]);
    expect(b.entries.filter((e) => e.type === 'unknown')).toEqual([]);
    const steps = allSteps(b);
    expect(steps.filter((s) => s.category === 'unknown')).toEqual([]);
    expect(b.step_count).toBe(listSteps(scenario!, { includeSkipped: true }).length);
    expect(steps.map((s) => s.key)).toEqual(listSteps(scenario!, { includeSkipped: true }).map((l) => `${l.scene.id}.${l.step.index}`));
    for (const e of b.entries) expect(e.range, `${name} entry ${e.index}`).toBeDefined();
    for (const s of steps) {
      expect(s.range, s.key).toBeDefined();
      expect(s.fingerprint, s.key).toMatch(/^[0-9a-f]{12}$/);
      expect(s.picture, s.key).toMatch(/^[0-9a-f]{12}$/);
      // The range starts on the step's own line, at its first key.
      const r = s.range!;
      expect(text.slice(0, r.start).split('\n').length, s.key).toBe(r.line);
      expect(text.slice(r.start, r.end).trimEnd().split('\n').length, s.key).toBe(r.end_line - r.line + 1);
    }
    const got = outline(b);
    const golden = join(GOLDEN, `${name}.txt`);
    if (process.env.RETAKE_UPDATE_GOLDEN === '1') {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(golden, got);
    }
    if (!existsSync(golden)) throw new Error(`golden ${golden} is missing: run \`RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/core/test/blocks.test.ts\` and read it`);
    expect(got).toBe(readFileSync(golden, 'utf8'));
  });

  it('quote: the hooks strip says which hook needs a person (a DELETE rollback); catalogue: a DELETE hook, its comment kept', () => {
    const quote = blocksOf(readFileSync(join(FIXTURE_SCENARIOS, 'quote.yaml'), 'utf8'));
    expect(quote.hooks.setup.map((h) => [h.kind, h.name, h.summary, h.needs_person ?? null])).toEqual([
      ['http', 'reset', 'POST {{shop}}/api/reset', null],
      ['http', 'prepare-proposal', 'POST {{shop}}/api/quotes/auto-proposal', 'its rollback: HTTP DELETE'],
      ['js', 'open-console', 'return location.href (on page console)', null],
    ]);
    expect(quote.hooks.setup[1].rollback).toBe('DELETE {{shop}}/api/quotes/auto-proposal');
    const catalogue = blocksOf(readFileSync(join(FIXTURE_SCENARIOS, 'catalogue.yaml'), 'utf8'));
    const free = catalogue.hooks.setup[1];
    expect(free.needs_person).toBe('HTTP DELETE');
    expect(free.flags.map((f) => f.kind)).toEqual(['destructive', 'rollback', 'confirm']);
    expect(free.comment).toContain('Finca Quenaro 2026 is already linked');
    // The editor directive is left out, the hard wraps joined (review B M5); the comment as written stays at its lines.
    expect(quote.video.comment).toMatch(/^Buyer side: discover a coffee, request a quote \(the roaster's console shows a web notification, captured and overlaid\), receive/);
    expect(quote.video.comment).not.toMatch(/yaml-language-server|\$schema/);
    expect(quote.video.comment?.split('\n\n')[1]).toMatch(/^The `open-console` setup hook loads the supplier console in a background tab: it polls/);
    expect(quote.video.comment_lines?.line).toBe(1);
    const card = quote.entries[1];
    expect(card.type === 'card' && card.comment).toBe("A full-screen chapter card (takes no capture time): the theme's card component (studio/card-title) with slots.");
  });
});

describe('words: badges, chips, plain targets', () => {
  it('every action has a badge (an exhaustive switch), R-UI-09 kinds included', () => {
    const cats = new Set(ACTION_NAMES.map((a) => actionCategory(a)));
    for (const c of cats) expect(STEP_CATEGORIES).toContain(c);
    for (const c of ['click', 'select', 'pick', 'menu', 'type', 'scroll', 'drop_file', 'wait', 'hold', 'navigation'] as const) expect(cats.has(c), c).toBe(true);
    expect(ACTION_NAMES.map((a) => [a, actionCategory(a)])).toEqual([
      ['open', 'navigation'],
      ['click', 'click'],
      ['double_click', 'click'],
      ['hover', 'hover'],
      ['type', 'type'],
      ['press', 'type'],
      ['select', 'select'],
      ['pick', 'pick'],
      ['menu', 'menu'],
      ['date', 'type'],
      ['scroll', 'scroll'],
      ['drag', 'drag'],
      ['drop_file', 'drop_file'],
      ['wait', 'wait'],
      ['wait_for', 'wait'],
      ['hold', 'hold'],
      ['assert', 'check'],
      ['screenshot', 'check'],
      ['new_tab', 'navigation'],
      ['switch_page', 'navigation'],
      ['eval', 'script'],
      ['notify', 'script'],
      ['emit', 'script'],
      ['cursor', 'cursor'],
      ['wait_for_email', 'wait'],
      ['download', 'download'],
      ['capture_text', 'check'],
      ['hook', 'hook'],
    ]);
  });

  it('a chip for each modifier, always with words (R-UI-10)', () => {
    const chips = stepChips({
      click: 'Save',
      camera: { zoom: 1.3, target: 'cursor' },
      hold: 1.5,
      mark: 'saved',
      caption: { kicker: 'Instantly', text: 'Saved in one click' },
      speed: 1.6,
      irreversible: true,
      optional: true,
      park: 2,
      overlay: { component: 'studio/overlay-callout' },
      tutorial: { spotlight: false, steps: true },
      on: 'phone',
      timeout: 10,
    });
    expect(chips).toEqual([
      { kind: 'zoom', label: 'zoom ×1.3' },
      { kind: 'hold', label: 'hold 1.5 s' },
      { kind: 'mark', label: 'mark saved' },
      { kind: 'caption', label: 'caption “Instantly”' },
      { kind: 'speed', label: 'speed ×1.6' },
      { kind: 'irreversible', label: 'irreversible' },
      { kind: 'optional', label: 'optional' },
      { kind: 'park', label: 'park 2 s' },
      { kind: 'overlay', label: 'overlay studio/overlay-callout' },
      { kind: 'tutorial', label: 'tutorial spotlight off, steps on' },
      { kind: 'page', label: 'on phone' },
      { kind: 'timeout', label: 'timeout 10 s' },
    ]);
    expect(new Set(chips.map((c) => c.kind))).toEqual(new Set(CHIP_KINDS));
    // `hold` alone is the action, not a chip; a scene's irreversible marks its steps; a long caption is cut.
    expect(stepChips({ hold: 2 })).toEqual([]);
    expect(stepChips({ click: 'Pay' }, { sceneIrreversible: true })).toEqual([{ kind: 'irreversible', label: 'irreversible (scene)' }]);
    expect(stepChips({ hold: 1, caption: 'A caption far longer than forty characters, cut with an ellipsis' })[0].label).toBe('caption “A caption far longer than forty charact…”');
    expect(stepChips({ click: 'x', park: true, overlay: { image: 'assets/badge.png' }, tutorial: false })).toEqual([
      { kind: 'park', label: 'park' },
      { kind: 'overlay', label: 'overlay image file' },
      { kind: 'tutorial', label: 'tutorial off' },
    ]);
  });

  it.each([
    ['Save', '“Save”'],
    [{ text: 'Save', exact: true }, '“Save” (exact)'],
    [{ role: 'button', name: 'OK' }, 'button “OK”'],
    [{ role: 'textbox', in: 'dialog' }, 'textbox in the dialog'],
    [{ aria: 'Increase', in: 'dialog' }, '“Increase” (aria label) in the dialog'],
    [{ label: 'Delivery window' }, 'field “Delivery window”'],
    [{ placeholder: 'Search' }, 'field with placeholder “Search”'],
    [{ testid: 'proposal-total' }, 'element with test id “proposal-total”'],
    ['.row > button', 'element matching .row > button'],
    [{ css: '.quote-row .k', nth: 0 }, 'the 1st element matching .quote-row .k'],
    [{ text: 'Edit', nth: 1 }, 'the 2nd “Edit”'],
    [{ text: 'Edit', nth: 2 }, 'the 3rd “Edit”'],
    [{ text: 'Edit', nth: 10 }, 'the 11th “Edit”'],
    [{ text: 'Edit', nth: -1 }, 'the last “Edit”'],
    [{ text: 'Edit', nth: -2 }, 'the 2nd from last “Edit”'],
    [{ text: 'Options', last_visible: true }, 'the last visible “Options”'],
    [{ contains: ['Finca Quenaro', '2026'], in: 'dialog' }, 'element containing “Finca Quenaro” and “2026” in the dialog'],
    [{ text: 'Pause', in: { row: 'Iceland' } }, '“Pause” in the row containing “Iceland”'],
    [{ text: 'Save', in: { role: 'dialog', name: 'Edit' } }, '“Save” in dialog “Edit”'],
    [{ text: 'Open', in: 'menu' }, '“Open” in the menu'],
    [{ text: 'x', in: 'page' }, '“x”'],
    [{ x: 640, y: 360 }, 'point 640, 360'],
    [{}, 'any element'],
    [undefined, 'the page'],
  ])('plainTarget(%j) = %s', (t, want) => {
    expect(plainTarget(t)).toBe(want);
  });

  it('steps in words: target and summary per action', () => {
    const text = `video: words
scenes:
  - id: a
    page: shop
    open: /
    steps:
      - open: {url: /quotes, page: shop}
      - click: {text: Menu, button: right, modifiers: [Shift]}
      - double_click: Row
      - type: {into: {label: Message}, text: "Line one\\nline two", clear: true, enter: true}
      - type: hello
      - press: {key: Tab, times: 3}
      - select: {field: Bag size, option: 5 kg}
      - pick: {field: Grind options, option: [Espresso, Filter], search: Esp}
      - menu: {row: Iceland, item: Pause, confirm: Pause}
      - date: {field: Delivery, day: ["10 January 2027", "24 January 2027"]}
      - scroll: {to: 560, duration: 1.5}
      - scroll: {to: {text: Awards}, in: {css: .panel}}
      - scroll: bottom
      - drag: {from: Card, to: {x: 10, y: 20}}
      - drop_file: {zone: Drop here, name: list.xlsx, fake: true}
      - wait: 0.8
      - wait_for: {text: Done, timeout: 5}
      - wait_for: {gone: Spinner}
      - assert: {count: {target: {css: .row}, equals: 3}, title: Quotes}
      - screenshot: {name: list, full_page: true}
      - new_tab: {href: /help, as: help}
      - switch_page: {to: previous, close_current: true}
      - eval: "return 1"
      - notify: {title: Build, message: Done}
      - emit: ready
      - cursor: {move: Save, duration: 0.5}
      - cursor: hide
      - wait_for_email: {to: orders@example.test, subject: Your quote, as: mail}
      - download: {click: {text: PDF}, as: quote}
      - capture_text: {target: {testid: total}, as: total, pattern: "/(€[\\\\d.]+)/"}
      - hold: 1
`;
    const steps = allSteps(blocksOf(text)).map((s) => [s.label, s.target ?? null, s.summary ?? null]);
    expect(steps).toEqual([
      ['open', null, '/quotes, on page shop'],
      ['click', '“Menu”', 'right button, with Shift'],
      ['double click', '“Row”', null],
      ['type', 'field “Message”', '“Line one …”, clears first, then Enter'],
      ['type', 'the focused field', '“hello”'],
      ['press', null, 'Tab × 3'],
      ['select', 'field “Bag size”', 'option “5 kg”'],
      ['pick', 'field “Grind options”', 'options “Espresso”, “Filter”, search “Esp”'],
      ['menu', 'the row containing “Iceland”', 'item “Pause”, confirm “Pause”'],
      ['date', 'field “Delivery”', 'days “10 January 2027” → “24 January 2027”'],
      ['scroll', null, 'to 560 px, 1.5 s'],
      ['scroll', '“Awards” in element matching .panel', null],
      ['scroll', null, 'to the bottom'],
      ['drag', '“Card”', 'to point 10, 20'],
      ['drop file', '“Drop here”', 'file “list.xlsx” (placeholder)'],
      ['wait', null, '0.8 s'],
      ['wait for', null, 'text “Done”, up to 5 s'],
      ['wait for', '“Spinner”', 'gone'],
      ['assert', null, 'title “Quotes”, 3 × element matching .row'],
      ['screenshot', null, '“list”, full page'],
      ['new tab', null, '/help, as help'],
      ['switch page', null, 'to previous, closes the current page'],
      ['eval', null, 'return 1'],
      ['notify', null, 'Build: Done'],
      ['emit', null, 'ready'],
      ['cursor', '“Save”', 'move, 0.5 s'],
      ['cursor', null, 'hide'],
      ['wait for email', null, 'to “orders@example.test”, subject “Your quote”, as mail'],
      ['download', '“PDF”', 'as quote'],
      ['capture text', 'element with test id “total”', 'as total, pattern /(€[\\d.]+)/'],
      ['hold', null, '1 s'],
    ]);
  });

  it('hook summaries: http, sql (file, query, database, rollback), shell, js; a hook it does not know', () => {
    expect(hookSummary({ http: { url: 'https://api.example.test/reset' } })).toEqual({ kind: 'http', summary: 'GET https://api.example.test/reset' });
    expect(hookSummary({ sql: 'hooks/seed.sql' })).toEqual({ kind: 'sql', summary: 'hooks/seed.sql' });
    expect(hookSummary({ sql: { query: 'DELETE FROM quotes\nWHERE id = 1', db: 'main', rollback: 'hooks/undo.sql' } })).toEqual({
      kind: 'sql',
      summary: 'DELETE FROM quotes … (database main)',
      rollback: 'hooks/undo.sql',
    });
    expect(hookSummary({ shell: { run: './scripts/seed.sh --fast\necho done', rollback: './scripts/unseed.sh' } })).toEqual({ kind: 'shell', summary: './scripts/seed.sh --fast …', rollback: './scripts/unseed.sh' });
    expect(hookSummary({ js: { file: 'hooks/prime.js', page: 'console' } })).toEqual({ kind: 'js', summary: 'hooks/prime.js (on page console)' });
    expect(hookSummary({ name: 'x' })).toEqual({ summary: 'unknown hook' });
    expect(hookSummary(7)).toEqual({ summary: 'not a hook' });
  });
});

describe('tolerant of broken scenarios', () => {
  it('a step with two actions, an unknown action, a non-mapping step: unknown blocks carrying their issues', () => {
    const b = blocksOf(`video: x
scenes:
  - id: a
    page: shop
    open: /
    steps:
      - click: A
        hover: B
      - clik: C
      - 7
      - type: {into: X}
`);
    const [two, unknownAction, seven, type] = allSteps(b);
    expect([two.category, two.label]).toEqual(['unknown', 'several actions (click, hover)']);
    expect(two.issues.map((i) => i.message)).toEqual(['several actions in one step (click, hover): split them into separate steps']);
    expect([unknownAction.category, unknownAction.label, unknownAction.issues[0].message]).toEqual(['unknown', 'no action', 'unknown action "clik" (did you mean "click"?)']);
    expect([seven.category, seven.label]).toEqual(['unknown', 'not a step (a step is a mapping with one action)']);
    // A missing argument keeps the action (its issue on the step).
    expect([type.action, type.category, type.issues.map((i) => i.message)]).toEqual(['type', 'type', ['missing required key "text"']]);
    expect(b.issues).toEqual([]);
  });

  it('an error in scene 3 is on scene 3; a card error on the card; an entry that is no scene is unknown; a hook error on the hook', () => {
    const b = blocksOf(`video: x
setup:
  - name: h
scenes:
  - id: a
    page: shop
    open: /
    steps: [{hold: 1}]
  - card: {slots: {title: T}, bogus: 1}
  - id: c
    steps: 3
  - 7
  - steps: [{hold: 1}]
`);
    expect(b.entries.map((e) => e.type)).toEqual(['scene', 'card', 'scene', 'unknown', 'unknown']);
    expect(b.entries[1].issues.map((i) => i.message)).toEqual(['unknown key "bogus"']);
    expect(b.entries[2].issues.map((i) => i.message)).toContain('expected a list, got 3');
    expect((b.entries[2] as SceneBlock).steps).toEqual([]);
    expect(b.entries[3].issues[0].message).toMatch(/^expected a scene mapping/);
    expect(b.entries[4].issues.length).toBeGreaterThan(0);
    expect(b.hooks.setup[0].summary).toBe('unknown hook');
    expect(b.hooks.setup[0].issues.length).toBeGreaterThan(0);
    expect(b.step_count).toBe(1);
  });

  it('a YAML syntax error: no blocks, the issue with its line', () => {
    const b = blocksOf('video: x\nscenes:\n  - id: a\n    steps: [\n');
    expect(b.parsed).toBe(false);
    expect(b.entries).toEqual([]);
    expect(b.issues[0].message).toMatch(/^YAML: /);
    expect(b.issues[0].line).toBeGreaterThan(1);
  });

  it.each(['', 'null', '[]', '42', '"text"', 'scenes: 3', 'scenes: [null, [], {card: 3}, {interstitial: null}]', 'video: x\nscenes:\n  - id: a\n    steps: [{click: null}, {drag: null}, {download: 3}, {cursor: 5}, {scroll: {to: null}}, {pick: {field: 1, option: {}}}]', 'setup: 3\nteardown: [null, {http: 3}, {sql: {}}, {shell: {}}, {js: 4}]', '{video: [1], title: 3, intro: [], outro: {url: 3}, music: 2, clock: {}, capture: 1, vars: []}'])(
    'never throws: %j',
    (text) => {
      const b = blocksOf(text);
      expect(b).toHaveProperty('entries');
      expect(Array.isArray(b.issues)).toBe(true);
    },
  );
});

describe('hostile text and URLs', () => {
  it('markup, bidi controls and javascript: URLs are kept verbatim (the page renders text nodes)', () => {
    const text = `video: x
scenes:
  - id: a
    page: shop
    open: "javascript:alert(1)"
    caption: "<img src=x onerror=alert(1)>"
    steps:
      - click: "Pay ‮evil"
        caption: "<script>alert(2)</script>"
`;
    const b = blocksOf(text);
    const scene = b.entries[0] as SceneBlock;
    expect(scene.open).toBe('javascript:alert(1)');
    // Shown as written, and refused by the validation (a scenario opens only http:, https: or about:blank).
    expect(scene.issues).toEqual([expect.objectContaining({ severity: 'error', path: ['scenes', 0, 'open'], message: expect.stringContaining('opens a javascript: URL') })]);
    expect(scene.caption).toEqual({ text: '<img src=x onerror=alert(1)>' });
    expect(scene.steps[0].target).toBe('“Pay ‮evil”');
    expect(scene.steps[0].chips[0].label).toBe('caption “<script>alert(2)</script>”');
  });

  it('user:password@ is left out of every URL a block shows (scene open, pages, steps, hooks, outro, card slots), not out of the text', () => {
    const text = `video: x
outro: {url: "https://me:pw@shop.example.test/signup"}
setup:
  - http: {method: POST, url: "https://admin:s3cret@api.example.test/reset", rollback: {method: DELETE, url: "https://admin:s3cret@api.example.test/x"}}
  - shell: "curl https://{{env:USER}}:{{env:PASS}}@api.example.test/seed"
scenes:
  - id: a
    page: shop
    open: "https://user:pass@shop.example.test/start"
    steps:
      - open: "https://u:p@shop.example.test/quotes"
      - new_tab: {href: "http://only-user@shop.example.test/help"}
      - wait_for: {url: "https://u:p@shop.example.test/done"}
  - id: b
    pages:
      - {id: desk, page: shop, open: "https://u:p@shop.example.test/a"}
  - card: {slots: {url: "https://u:p@shop.example.test/cta", title: T}}
`;
    const b = blocksOf(text);
    const json = JSON.stringify(b);
    expect(json).not.toMatch(/pass|s3cret|:pw@|u:p@|only-user|\{\{env:PASS\}\}/);
    expect((b.entries[0] as SceneBlock).open).toBe('https://shop.example.test/start');
    expect((b.entries[0] as SceneBlock).steps.map((s) => s.summary)).toEqual(['https://shop.example.test/quotes', 'http://shop.example.test/help', 'URL https://shop.example.test/done']);
    expect((b.entries[0] as SceneBlock).steps[0].args).toEqual({ url: 'https://shop.example.test/quotes' });
    // Each URL a scene opens is refused by the validation, its message without the sign-in details either.
    expect((b.entries[0] as SceneBlock).issues.map((i) => i.message)).toEqual([expect.stringMatching(/^https:\/\/shop\.example\.test\/start holds sign-in details/)]);
    expect((b.entries[0] as SceneBlock).steps.map((s) => s.issues.length)).toEqual([1, 1, 0]);
    expect(b.hooks.setup[0].summary).toBe('POST https://api.example.test/reset');
    expect(b.hooks.setup[1].summary).toBe('curl https://api.example.test/seed');
    expect(b.video.outro).toEqual({ mode: 'custom', url: 'https://shop.example.test/signup' });
    // The ranges still point into the text as written.
    expect(text.slice((b.entries[0] as SceneBlock).steps[0].range!.start)).toMatch(/^open: "https:\/\/u:p@/);
    expect(stripUrlUserinfo('see https://a:b@x.test/p and ftp://c@y.test, not mail@z.test or /p@q')).toBe('see https://x.test/p and ftp://y.test, not mail@z.test or /p@q');
  });

  it('a password holding an @ is left out whole; comments lose their user:password@ too (review A #5)', () => {
    expect(stripUrlUserinfo('https://u:p@ss@h.example/x and https://u:pa/ss@h.example/ and https://h.example/a@b')).toBe('https://h.example/x and https://u:pa/ss@h.example/ and https://h.example/a@b');
    const text = `# yaml-language-server: $schema=https://admin:hunter2@schemas.example.test/s.json
# -*- mode: yaml -*-

# Top: https://u:p@ss@h.example.test/x
# wrapped
#
# - a list item
# - another
video: x
scenes:
  # scene note https://bob:secret@h.example.test/
  - id: a
    page: shop
    open: /
    steps:
      # step note https://carol:pw@h.example.test/
      - click: A
`;
    const b = blocksOf(text);
    expect(JSON.stringify(b)).not.toMatch(/hunter2|secret|:pw@|u:p@|ss@|yaml-language-server|mode: yaml/);
    expect(b.video.comment).toBe('Top: https://h.example.test/x wrapped\n\n- a list item\n- another');
    expect(b.video.comment_lines).toEqual({ line: 1, end_line: 8 });
    expect((b.entries[0] as SceneBlock).comment).toBe('scene note https://h.example.test/');
    expect((b.entries[0] as SceneBlock).steps[0].comment).toBe('step note https://h.example.test/');
  });
});

describe('YAML aliases: bounded, never resolved by the walker, marked', () => {
  it('a step written as an alias is aliased: the alias range, no comment, the value it names', () => {
    const text = `video: x
scenes:
  - id: a
    page: shop
    open: /
    steps:
      - &again {click: Again}
      # the same step once more
      - *again
`;
    const [first, second] = allSteps(blocksOf(text));
    expect(first.aliased).toBeUndefined();
    expect(second.aliased).toBe(true);
    expect(second.comment).toBeUndefined();
    expect(text.slice(second.range!.start, second.range!.end)).toBe('*again');
    expect([second.target, second.occurrence]).toEqual(['“Again”', 1]);
  });

  it('a scene reached through an alias: its steps are aliased too (one range: the alias)', () => {
    const text = `video: x
scenes:
  - &s {id: a, page: shop, open: /, steps: [{hold: 1}, {hold: 2}]}
  - *s
`;
    const b = blocksOf(text);
    const second = b.entries[1] as SceneBlock;
    expect(second.aliased).toBe(true);
    expect(second.steps.every((s) => s.aliased && s.range?.start === second.range?.start)).toBe(true);
  });

  it('a billion-laughs document is refused fast (maxAliasCount)', () => {
    const lol = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    for (let i = 1; i < 9; i++) lol.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(9).fill(`*${String.fromCharCode(96 + i)}`).join(',')}]`);
    const text = `${lol.join('\n')}\nvideo: x\nscenes: *i\n`;
    const t0 = performance.now();
    const b = blocksOf(text);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(b.parsed).toBe(false);
    expect(b.issues[0].message).toMatch(/^YAML: .*alias/i);
  });

  it('a recursive alias is refused with its line (it used to overflow the stack of every walker)', () => {
    const text = 'video: x\nscenes:\n  - id: a\n    steps:\n      - click: &x {text: A, in: *x}\n';
    const b = blocksOf(text);
    expect(b.parsed).toBe(false);
    expect(b.issues).toEqual([expect.objectContaining({ severity: 'error', line: 5, message: expect.stringMatching(/^YAML: an alias points back into the node that holds it/) })]);
    expect(() => parseScenario(text)).not.toThrow();
    expect(parseScenario(text).issues[0].message).toMatch(/recursive structure/);
  });

  it('20,000 aliases are refused in linear time (review A #1: the recursive-alias check walked the document per alias)', () => {
    let text = 'version: 1\nvideo: b\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - &s {click: x}\n';
    for (let i = 0; i < 20_000; i++) text += '      - *s\n';
    const t0 = performance.now();
    const r = parseYaml(text);
    expect(performance.now() - t0).toBeLessThan(400);
    expect(r.value).toBeUndefined();
    expect(r.issues[0].message).toMatch(/^YAML: .*alias/i);
    // A recursive alias deep in a long file is still found, and an anchor redefined inside its node is not a cycle.
    expect(parseYaml(`${text.replace(/ {6}- \*s\n$/, '')}      - &y {click: {text: A, in: *y}}\n`).issues[0].message).toMatch(/points back into the node/);
    expect(parseYaml('a: &x {b: &x 1, c: *x}\n').issues).toEqual([]);
  });
});

describe('line ranges and comments (for L4.3)', () => {
  it('scenes, steps and hooks carry their lines and the comment above them; the first item takes its list comment', () => {
    const text = `# top of the file
video: x
setup:
  # first hook
  - http: {url: "u"}
scenes:
  # first scene
  - id: a
    page: shop
    open: /
    steps:
      # first step
      - click: A
      # second step
      #   on two lines
      - hover: B
  # an interstitial
  - interstitial: {text: Later}
`;
    const b = blocksOf(text);
    expect(b.video.comment).toBe('top of the file');
    expect([b.hooks.setup[0].comment, rangeText(b.hooks.setup[0].range)]).toEqual(['first hook', 'L5']);
    const scene = b.entries[0] as SceneBlock;
    expect([scene.comment, rangeText(scene.range)]).toEqual(['first scene', 'L8-16']);
    expect(scene.steps.map((s) => [s.comment, rangeText(s.range)])).toEqual([
      ['first step', 'L13'],
      ['second step\n  on two lines', 'L16'],
    ]);
    expect([b.entries[1].comment, rangeText(b.entries[1].range)]).toEqual(['an interstitial', 'L18']);
    // Offsets slice the text: the page needs no per-step source copy.
    expect(text.slice(scene.steps[1].range!.start, scene.steps[1].range!.end)).toBe('hover: B');
  });

  it('a scene without page inherits the previous one; a continuing scene says so; multi-page scenes list their pages', () => {
    const b = blocksOf(readFileSync(join(FIXTURE_SCENARIOS, 'phone-and-desktop.yaml'), 'utf8'));
    const [phone, send] = b.entries as SceneBlock[];
    expect(phone.pages?.map((p) => [p.id, p.page, p.open, p.viewport ?? null, p.label])).toEqual([
      ['desk', 'shop', '/quotes', null, 'Desktop'],
      ['phone', 'shop', '/products/selowa-ridge', 'mobile', 'Phone'],
    ]);
    expect([phone.continues, send.continues, send.pages?.map((p) => p.id)]).toEqual([false, true, ['desk', 'phone']]);
    const quote = blocksOf(readFileSync(join(FIXTURE_SCENARIOS, 'quote.yaml'), 'utf8'));
    const request = quote.entries[2] as SceneBlock;
    expect([request.id, request.page, request.page_inherited, request.continues]).toEqual(['request', 'shop', true, true]);
  });
});
