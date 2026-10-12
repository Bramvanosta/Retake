import { describe, expect, it } from 'vitest';
import { formatIssues, parseScenario, validateScenario } from '@demo-studio/core';
import type { ValidationIssue } from '@demo-studio/core';
import { SPEC_EXAMPLE, colOf, errors, fakeProject, lineOf, specProjectDir, tempDir, warnings, writeFiles } from './helpers.js';

/** A staging project whose directory holds the hook files of the SPEC example. */
const project = fakeProject(specProjectDir());

function only(issues: ValidationIssue[], severity: 'error' | 'warning' = 'error'): ValidationIssue {
  const list = issues.filter((i) => i.severity === severity);
  expect(list, formatIssues(issues)).toHaveLength(1);
  return list[0];
}

/** A minimal valid scenario with `steps` (YAML lines indented for a scene's step list). */
function scenario(steps: string, head = ''): string {
  return `video: demo\n${head}scenes:\n  - id: main\n    page: console\n    open: /\n    steps:\n${steps}`;
}

describe('docs/SPEC.md §6 example', () => {
  it('parses with zero errors and zero warnings against a staging project holding its hook files', () => {
    const { scenario: s, issues } = parseScenario(SPEC_EXAMPLE, { file: 'catalogue.yaml', project });
    expect(issues, formatIssues(issues)).toEqual([]);
    expect(s?.video).toBe('catalogue');
    expect(s?.scenes).toHaveLength(4);
  });

  it('missing hook SQL files of the example are errors, positioned on the hook (R-VAL-06)', () => {
    const { scenario: s, issues } = parseScenario(SPEC_EXAMPLE, { file: 'catalogue.yaml', project: fakeProject() });
    expect(s).toBeUndefined();
    const es = errors(issues);
    expect(es.map((w) => w.message)).toEqual([
      'SQL file "hooks/remove-registry-refs.sql" not found in the project',
      'SQL file "hooks/restore-registry-refs.sql" not found in the project',
    ]);
    expect(es[0].line).toBe(lineOf(SPEC_EXAMPLE, 'sql: hooks/remove-registry-refs.sql'));
  });

  it('missing hook SQL/JS files are errors when a project is known, and pass once the files exist (R-VAL-06)', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const text = [
        'video: demo',
        'setup:',
        '  - sql: hooks/seed.sql',
        '  - sql: {file: hooks/other.sql, rollback: hooks/undo.sql}',
        '  - js: {file: hooks/prepare.js}',
        'scenes:',
        '  - id: main',
        '    page: console',
        '    open: /',
        '    steps:',
        '      - wait: 1',
        '',
      ].join('\n');
      const before = errors(parseScenario(text, { project: fakeProject(dir) }).issues).map((i) => `${i.path.join('.')}: ${i.message}`);
      expect(before).toEqual([
        'setup.0.sql: SQL file "hooks/seed.sql" not found in the project',
        'setup.1.sql.file: SQL file "hooks/other.sql" not found in the project',
        'setup.1.sql.rollback: rollback SQL file "hooks/undo.sql" not found in the project',
        'setup.2.js.file: JS file "hooks/prepare.js" not found in the project',
      ]);
      await writeFiles(dir, {
        'hooks/seed.sql': 'select 1;',
        'hooks/other.sql': 'select 2;',
        'hooks/undo.sql': 'select 3;',
        'hooks/prepare.js': 'return 1;',
      });
      expect(errors(parseScenario(text, { project: fakeProject(dir) }).issues)).toEqual([]);
      // Without a project nothing can be checked: warnings only.
      const loose = parseScenario(text).issues;
      expect(errors(loose)).toEqual([]);
      expect(warnings(loose).length).toBe(4);
    } finally {
      await cleanup();
    }
  });

  it('parses without a project (files cannot be checked → warnings)', () => {
    const { scenario: s, issues } = parseScenario(SPEC_EXAMPLE, { file: 'catalogue.yaml' });
    expect(s).toBeDefined();
    expect(errors(issues)).toEqual([]);
    expect(warnings(issues).every((w) => w.message.includes('no project given'))).toBe(true);
  });

  it('validateScenario accepts the parsed object', () => {
    const { scenario: s } = parseScenario(SPEC_EXAMPLE);
    expect(errors(validateScenario(s, { project }))).toEqual([]);
  });
});

describe('structural errors are precise and positioned', () => {
  it('unknown key with did-you-mean, located on the key', () => {
    const text = SPEC_EXAMPLE.replace('click: {text: New import}', 'click: {txt: New import}');
    const { scenario: s, issues } = parseScenario(text, { project });
    expect(s).toBeUndefined();
    const e = only(issues);
    expect(e.path).toEqual(['scenes', 0, 'steps', 1, 'click']);
    expect(e.message).toBe('unknown key "txt" (did you mean "text"?)');
    expect(e.line).toBe(lineOf(text, 'txt: New import'));
    expect(e.col).toBe(colOf(text, 'txt: New import'));
    expect(formatIssues([e], 'catalogue.yaml')).toBe(
      `catalogue.yaml:${e.line}:${e.col} error scenes[0].steps[1].click: unknown key "txt" (did you mean "text"?)`,
    );
  });

  it('wrong type points at the value', () => {
    const text = scenario('      - wait: soon\n      - scroll: {to: 560, duration: fast}\n');
    const { issues } = parseScenario(text, { project });
    expect(errors(issues).map((i) => [formatIssues([i]), i.col])).toEqual([
      [`${lineOf(text, 'wait: soon')}:15 error scenes[0].steps[0].wait: expected a number, got "soon"`, 15],
      [
        `${lineOf(text, 'duration: fast')}:${colOf(text, 'fast')} error scenes[0].steps[1].scroll.duration: expected a number, got "fast"`,
        colOf(text, 'fast'),
      ],
    ]);
  });

  it('numbers where text is expected suggest quoting', () => {
    const { issues } = parseScenario(scenario('      - pick: {field: Year, option: [2026, "2027"]}\n'), { project });
    expect(only(issues).message).toBe('expected a string, got 2026 (quote it to use it as text: "2026")');
    expect(only(issues).path).toEqual(['scenes', 0, 'steps', 0, 'pick', 'option', 0]);
  });

  it('two actions in one step', () => {
    const text = scenario('      - click: Save\n        hover: Cancel\n');
    const e = only(parseScenario(text, { project }).issues);
    expect(e.message).toBe('several actions in one step (click, hover): split them into separate steps');
    expect(e.path).toEqual(['scenes', 0, 'steps', 0]);
    expect([e.line, e.col]).toEqual([lineOf(text, 'hover: Cancel'), colOf(text, 'hover')]);
  });

  it('hold next to another action is the hold modifier, not a second action', () => {
    const { issues } = parseScenario(scenario('      - click: Save\n        hold: 2\n'), { project });
    expect(errors(issues)).toEqual([]);
  });

  it('misspelt action', () => {
    const text = scenario('      - clik: {text: Save}\n');
    const e = only(parseScenario(text, { project }).issues);
    expect(e.message).toBe('unknown action "clik" (did you mean "click"?)');
    expect(e.line).toBe(lineOf(text, 'clik'));
  });

  it('a step without an action lists the actions', () => {
    const e = only(parseScenario(scenario('      - caption: Hello\n'), { project }).issues);
    expect(e.message).toMatch(/^a step needs exactly one action key: open, click, double_click/);
  });

  it('missing required key is reported on the parent mapping', () => {
    const text = scenario('      - type: {into: {role: textbox}}\n');
    const e = only(parseScenario(text, { project }).issues);
    expect(e.path).toEqual(['scenes', 0, 'steps', 0, 'type']);
    expect(e.message).toBe('missing required key "text"');
    expect(e.line).toBe(lineOf(text, 'type:'));
  });

  it('enum values get a suggestion', () => {
    const e = only(parseScenario(scenario('      - click: Save\n        camera: {zoom: 1.2, ease: slowly}\n'), { project }).issues);
    expect(e.message).toBe('expected one of "slow", "normal", "fast", "linear" or a list, got "slowly" (did you mean "slow"?)');
  });

  it('ranges: speed (0, 8], camera zoom [1, 3] and duration ≥ 0.8', () => {
    const text = scenario('      - click: Save\n        speed: 10\n        camera: {zoom: 4, duration: 0.3}\n');
    const msgs = errors(parseScenario(text, { project }).issues).map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(msgs).toEqual([
      'scenes.0.steps.0.speed: must be ≤ 8, got 10',
      'scenes.0.steps.0.camera.zoom: must be ≤ 3, got 4',
      'scenes.0.steps.0.camera.duration: must be ≥ 0.8, got 0.3',
    ]);
    const zero = parseScenario(scenario('      - click: Save\n        speed: 0\n'), { project });
    expect(only(zero.issues).message).toBe('must be > 0, got 0');
  });

  it('unknown scene keys, interstitial without text, scene kind dispatch', () => {
    const text = [
      'video: demo',
      'scenes:',
      '  - id: a',
      '    open: /',
      '    stepz: []',
      '  - interstitial: {kicker: Later}',
      '  - interstitial: {text: Later}',
      '    steps: []',
    ].join('\n');
    const msgs = errors(parseScenario(text).issues).map((i) => `${i.line} ${i.path.join('.')}: ${i.message}`);
    expect(msgs).toEqual([
      '5 scenes.0: unknown key "stepz" (did you mean "steps"?)',
      '6 scenes.1.interstitial: an interstitial needs `text` (or a `video` / `image` / `lottie` file)',
      '8 scenes.2: unknown key "steps"',
    ]);
  });

  it('YAML syntax errors carry positions and stop validation', () => {
    const { scenario: s, issues } = parseScenario('video: demo\nscenes:\n  - id: a\n    steps: [ {click: Save ]\n');
    expect(s).toBeUndefined();
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/^YAML: /);
    expect(issues[0].line).toBe(4);
  });

  it('duplicate keys are YAML errors', () => {
    const { issues } = parseScenario('video: demo\nvideo: other\nscenes: []\n');
    expect(issues[0]).toMatchObject({ severity: 'error', line: 2 });
    expect(issues[0].message).toMatch(/unique/i);
  });

  it('empty document', () => {
    const msgs = parseScenario('').issues.map((i) => i.message);
    expect(msgs).toEqual(['missing required key "video"', 'missing required key "scenes"']);
  });
});

describe('semantic checks', () => {
  it('unknown page key, with suggestion and available keys', () => {
    const text = SPEC_EXAMPLE.replace('page: console', 'page: consol');
    const e = only(parseScenario(text, { project }).issues);
    expect(e.path).toEqual(['scenes', 0, 'page']);
    expect(e.message).toBe('unknown page "consol" in environment "staging" (did you mean "console"?) (available: console, shop)');
    expect([e.line, e.col]).toEqual([lineOf(text, 'page: consol'), colOf(text, 'page: consol') + 'page: '.length]);
  });

  it('unknown environment', () => {
    const e = only(parseScenario(scenario('      - hold: 1\n', 'env: stagng\n'), { project }).issues);
    expect(e.message).toBe('unknown environment "stagng" (did you mean "staging"?) (available: staging)');
    expect(e.line).toBe(2);
  });

  it('page keys of open steps and js hooks', () => {
    const text = scenario('      - open: {url: /x, page: shopp}\n', 'setup:\n  - js: {code: "return 1", page: admin}\n');
    const msgs = errors(parseScenario(text, { project }).issues).map((i) => i.message);
    expect(msgs).toEqual([
      'unknown page "admin" (available: console, shop)',
      'unknown page "shopp" in environment "staging" (did you mean "shop"?) (available: console, shop)',
    ]);
  });

  it('duplicate scene and step ids', () => {
    const text = [
      'video: demo',
      'scenes:',
      '  - id: a',
      '    open: /',
      '    steps: [{click: Save, id: save}]',
      '  - id: a',
      '    steps: [{click: Save, id: save}]',
    ].join('\n');
    const msgs = errors(parseScenario(text).issues).map((i) => `${i.line} ${i.message}`);
    expect(msgs).toEqual([
      '6 duplicate scene id "a" (already used by scenes[0])',
      '7 duplicate step id "save" (already used at scenes[0].steps[0])',
    ]);
  });

  it('slug-like ids', () => {
    const e = only(parseScenario(scenario('      - hold: 1\n').replace('id: main', 'id: "main scene"')).issues);
    expect(e.message).toMatch(/^scene id must be slug-like/);
  });

  it('destructive hooks need confirm: true', () => {
    const head = [
      'setup:',
      '  - sql: "DELETE FROM offers WHERE demo = true"',
      '  - http: {method: DELETE, url: "{{console}}/api/offers/1"}',
      '  - shell: rm -rf tmp/cache',
      '  - sql: "UPDATE offers SET paused = false"',
      '    confirm: true',
      '  - sql: "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING"',
      '  - js: {code: "localStorage.clear()"}',
      '    destructive: true',
      '',
    ].join('\n');
    const text = scenario('      - hold: 1\n', head);
    const errs = errors(parseScenario(text, { project }).issues);
    expect(errs.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'setup.0: destructive hook (SQL DELETE) requires "confirm: true"',
      'setup.1: destructive hook (HTTP DELETE) requires "confirm: true"',
      'setup.2: destructive hook (shell rm) requires "confirm: true"',
      'setup.5: destructive hook (declared destructive) requires "confirm: true"',
    ]);
    expect(errs[0].line).toBe(lineOf(text, 'DELETE FROM'));
  });

  it('SQL files are inspected when the project dir exists', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await writeFiles(dir, {
        'hooks/remove-registry-refs.sql': '-- detach refs\nUPDATE registry SET ref = NULL WHERE demo;\n',
        'hooks/restore-registry-refs.sql': "INSERT INTO registry_log VALUES ('DELETE is only text here');\n",
      });
      const p = fakeProject(dir);
      const ok = parseScenario(SPEC_EXAMPLE, { project: p });
      expect(ok.issues, formatIssues(ok.issues)).toEqual([]);
      const unconfirmed = SPEC_EXAMPLE.replace('    confirm: true\n', '');
      const e = only(parseScenario(unconfirmed, { project: p }).issues);
      expect(e.message).toBe('destructive hook (hooks/remove-registry-refs.sql contains UPDATE) requires "confirm: true"');
      expect(e.path).toEqual(['setup', 1]);
    } finally {
      await cleanup();
    }
  });

  it('referenced files: drop_file.path, eval.file, music.file', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await writeFiles(dir, { 'assets/price-list.xlsx': 'x' });
      const text = scenario(
        [
          '      - drop_file: {zone: "#drop", path: assets/price-list.xlsx}',
          '      - drop_file: {zone: "#drop", path: assets/missing.xlsx}',
          '      - eval: {file: hooks/missing.js}',
          '',
        ].join('\n'),
        'music: {file: assets/bed.mp3}\n',
      );
      const msgs = errors(parseScenario(text, { project: fakeProject(dir) }).issues).map((i) => `${i.path.join('.')}: ${i.message}`);
      expect(msgs).toEqual([
        'music.file: music file "assets/bed.mp3" not found in the project',
        'scenes.0.steps.1.drop_file.path: file "assets/missing.xlsx" not found in the project',
        'scenes.0.steps.2.eval.file: JS file "hooks/missing.js" not found in the project',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('action-level rules', () => {
    const text = scenario(
      [
        '      - select: {option: Espresso}',
        '      - menu: {item: Pause}',
        '      - scroll: {duration: 2}',
        '      - drop_file: {zone: "#drop", fake: true}',
        '      - wait_for: {timeout: 3}',
        '      - eval: {}',
        '      - click: {in: dialog}',
        '      - new_tab: {as: pdf}',
        '      - cursor: {duration: 1}',
        '',
      ].join('\n'),
    );
    const msgs = errors(parseScenario(text, { project }).issues).map((i) => `${i.path[3]}: ${i.message}`);
    expect(msgs).toEqual([
      '0: select needs `combobox` (the trigger) or `field` (its label)',
      '1: menu needs `row` (text in the row) or `trigger`',
      '2: scroll needs `to` or `by`',
      '3: `fake: true` needs a file `name`',
      '4: wait_for needs one of text, not_text, target, gone, url, network_idle',
      '5: eval needs exactly one of `js` or `file`',
      '6: target needs at least one of text, contains, role, label, aria, placeholder, css or testid',
      '7: new_tab needs a `target` to click or an `href`',
      '8: cursor needs `move`, `set` or `show`',
    ]);
  });

  it('template tokens must exist', () => {
    const head = 'vars: {product: geisha}\nsetup:\n  - http: {method: POST, url: "{{consle}}/api/{{vars.prodct}}/{{env:TOKEN}}"}\n';
    const msgs = errors(parseScenario(scenario('      - open: "/p/{{vars.product}}"\n', head), { project }).issues).map(
      (i) => i.message,
    );
    expect(msgs).toEqual([
      'unknown template key {{consle}} (did you mean "console"?); available: console, shop, vars.product, env:VAR, keychain:service/account',
      'unknown variable {{vars.prodct}} (did you mean "product"?); declared: product',
    ]);
  });

  it('warnings: zoom above max_zoom, first scene without open, video vs file name', () => {
    const text = [
      'video: demo',
      'scenes:',
      '  - id: a',
      '    steps:',
      '      - click: Save',
      '        camera: {zoom: 1.8}',
    ].join('\n');
    const { scenario: s, issues } = parseScenario(text, { project, file: 'other.yaml' });
    expect(s).toBeDefined();
    expect(warnings(issues).map((i) => i.message)).toEqual([
      'video "demo" differs from the file name "other"',
      'scene "a" is the first scene on page "console" but has no `open`: it starts on whatever is loaded',
      'zoom 1.8 is above the default template max_zoom 1.4: the editor clamps it',
    ]);
  });

  it('--until references must resolve', () => {
    const text = scenario('      - click: Save\n        id: save\n');
    expect(errors(parseScenario(text, { until: 'main.save' }).issues)).toEqual([]);
    expect(errors(parseScenario(text, { until: 'save' }).issues)).toEqual([]);
    const e = only(parseScenario(text, { until: 'main.nope' }).issues);
    expect(e.message).toMatch(/^--until "main.nope" does not match any step/);
  });

  it('scene cursor: auto | keep | point | target, validated (R-ISS-04)', () => {
    const text = [
      'video: demo',
      'scenes:',
      '  - id: a',
      '    page: console',
      '    open: /',
      '    cursor: keep',
      '    steps: [{click: Save}]',
      '  - id: b',
      '    cursor: {x: 1500, y: 540}',
      '    steps: [{click: Save}]',
      '  - id: c',
      '    cursor: {text: New import, in: dialog}',
      '    steps: [{click: Save}]',
      '  - id: d',
      '    cursor: auto',
      '    steps: [{click: Save}]',
      '  - id: e',
      '    cursor: {x: 2400, y: 40}',
      '    steps: [{click: Save}]',
      '  - id: f',
      '    cursor: {in: dialog}',
      '    steps: [{click: Save}]',
      '',
    ].join('\n');
    const { issues } = parseScenario(text, { project });
    expect(errors(issues).map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'scenes.5.cursor: target needs at least one of text, contains, role, label, aria, placeholder, css or testid',
    ]);
    expect(warnings(issues).map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'scenes.0.cursor: `cursor: keep` on the first scene: there is no previous position, it behaves like `auto`',
      'scenes.4.cursor: point (2400, 40) is outside the 1920×1080 viewport: it is clamped inside',
    ]);
    expect(warnings(issues)[0].line).toBe(6);
    const ok = parseScenario(text.replace('    cursor: {in: dialog}\n', ''), { project });
    expect(ok.scenario?.scenes.map((sc) => ('cursor' in sc ? sc.cursor : undefined))).toEqual([
      'keep',
      { x: 1500, y: 540 },
      { text: 'New import', in: 'dialog' },
      'auto',
      { x: 2400, y: 40 },
      undefined,
    ]);
    const bad = only(parseScenario(text.replace('    cursor: {in: dialog}\n', '').replace('cursor: auto', 'cursor: [1, 2]'), { project }).issues);
    expect(bad.path).toEqual(['scenes', 3, 'cursor']);
  });
});
