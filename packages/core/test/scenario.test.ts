import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  SCENARIO_COMPARE_MAX_BYTES,
  ScenarioChangedError,
  formatIssues,
  formatPath,
  loadScenario,
  parseScenario,
  readScenarioSource,
  scenarioChangedMessage,
  scenarioChangedSinceRun,
  validateScenario,
} from '@retake/core';
import type { ValidationIssue } from '@retake/core';
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

  it('shell hooks may only name allowed hosts (R-SEC-06): literal text, positioned on run / rollback / env', () => {
    const head = [
      'vars: {host: unknown-until-run.example.com}',
      'setup:',
      '  - shell: "curl -fsS https://api.prod.example.com/reset"',
      '  - shell: "curl -fsS {{console}}/api/reset && curl https://console.staging.example.com/x"',
      '  - shell: {run: "true", env: {DATABASE_URL: "postgres://x@db.prod.example.com/d"}}',
      '  - shell: {run: "psql -h localhost demo", rollback: "ssh deploy@other.example.net cleanup"}',
      '  - shell: "curl https://$TARGET/x && curl https://{{vars.host}}/y"',
      // A command substitution is a command; the script's own variables are expanded (L1.2 review: S1, S2).
      `  - shell: 'TOKEN=$(curl -s https://auth.prod.example.com/t); BASE=other.prod.example.com; curl "https://$BASE/x"'`,
      '',
    ].join('\n');
    const text = scenario('      - hold: 1\n', head);
    const errs = errors(parseScenario(text, { project }).issues);
    expect(errs.map((i) => `${i.path.join('.')}: ${i.message.replace(/ \(allowed: .*\)$/, '')}`)).toEqual([
      'setup.0.shell: shell hook names host api.prod.example.com (URL): it is not allowed: use localhost, an environment host, or add it to allow_hosts',
      'setup.2.shell.env.DATABASE_URL: shell hook names host db.prod.example.com (env DATABASE_URL): it is not allowed: use localhost, an environment host, or add it to allow_hosts',
      'setup.3.shell.rollback: shell hook names host other.example.net (ssh): it is not allowed: use localhost, an environment host, or add it to allow_hosts',
      'setup.5.shell: shell hook names host auth.prod.example.com (URL): it is not allowed: use localhost, an environment host, or add it to allow_hosts',
      'setup.5.shell: shell hook names host other.prod.example.com ($BASE): it is not allowed: use localhost, an environment host, or add it to allow_hosts',
    ]);
    expect(errs[0].message).toMatch(/\(allowed: localhost, 127\.0\.0\.1, ::1, console\.staging\.example\.com, shop\.staging\.example\.com\)$/);
    expect(errs[0].line).toBe(lineOf(text, 'api.prod.example.com'));
    // Without a project there is no allow-list to check against.
    expect(errors(parseScenario(text).issues)).toEqual([]);
    // allow_hosts admits the host.
    const allowed = fakeProject(project.dir, { allow_hosts: ['api.prod.example.com', '*.example.com', 'other.example.net'] });
    expect(errors(parseScenario(text, { project: allowed }).issues)).toEqual([]);
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

  it('date and park rules (R-CHO-24, R-CHO-18/21)', () => {
    const text = scenario(
      [
        '      - date: {field: {in: dialog}, day: 2027-01-10}',
        '      - date: {field: Delivery window, day: [10 January 2027, 24 janvier]}',
        '      - date: 14 March',
        '      - date: {day: "2027-02-14", next: "#next", close: none}',
        '      - date: {field: Roast date, day: [10/01/2027, mardi 12 janvier 2027, "{{vars.day}}"]}',
        '      - click: Save',
        '        park: 1.5',
        '        hold: 2',
        '      - hold: 2',
        '        park: 1',
        '      - scroll: {to: Awards}',
        '        park: true',
        '',
      ].join('\n'),
      'vars: {day: 3 March 2027}\n',
    );
    const issues = parseScenario(text, { project }).issues;
    expect(errors(issues).map((i) => `${i.path.slice(3).join('.')}: ${i.message}`)).toEqual([
      '0.date.field: target needs at least one of text, contains, role, label, aria, placeholder, css or testid',
    ]);
    expect(warnings(issues).map((i) => `${i.path.slice(3).join('.')}: ${i.message}`)).toEqual([
      '1.date.day.1: "24 janvier" has no year: it is matched by its label only, and the calendar can only be paged forward to find it',
      '2.date: "14 March" has no year: it is matched by its label only, and the calendar can only be paged forward to find it',
      '4.date.day.0: "10/01/2027" is not a date the runner reads (2027-01-10, 10 January 2027, January 10, 2027): it is matched by its label only, and the calendar can only be paged forward to find it',
      '4.date.day.1: "mardi 12 janvier 2027" is not a date the runner reads (2027-01-10, 10 January 2027, January 10, 2027): it is matched by its label only, and the calendar can only be paged forward to find it',
      '5.hold: `park: <seconds>` sets the hold after the park: `hold` is ignored',
      '6.park: on a `hold` step the cursor parks, then the hold step sets the time: give `park: true`',
    ]);
  });

  it('template tokens must exist', () => {
    const head = 'vars: {product: geisha}\nsetup:\n  - http: {method: POST, url: "{{consle}}/api/{{vars.prodct}}/{{env:TOKEN}}/{{run.id}}/{{run.dir}}/{{run.name}}"}\n';
    const msgs = errors(parseScenario(scenario('      - open: "/p/{{vars.product}}"\n', head), { project }).issues).map(
      (i) => i.message,
    );
    expect(msgs).toEqual([
      'unknown template key {{consle}} (did you mean "console"?); available: console, shop, vars.product, env:VAR, keychain:service/account',
      'unknown variable {{vars.prodct}} (did you mean "product"?); declared: product',
      'unknown template key {{run.name}}; available: run.id, run.dir',
    ]);
    // vars values are inserted as written (L1.2 review: D5): a token in one is an error, positioned on the value.
    const text = scenario('      - click: "{{vars.who}}"\n', 'vars: {pw: "{{env:DEMO_PW}}", who: "Agent {{vars.pw}}", plain: Harbour}\n');
    expect(errors(parseScenario(text, { project }).issues).map((i) => `${formatPath(i.path)}: ${i.message}`)).toEqual([
      'vars.pw: {{env:DEMO_PW}}: a vars value is not templated (it would be inserted as written): write the value, or put the token where the variable is used',
      'vars.who: {{vars.pw}}: a vars value is not templated (it would be inserted as written): write the value, or put the token where the variable is used',
    ]);
  });

  it('secret references: allowed in step arguments, errors in what the video shows; tokens in an emit or screenshot name are errors (R-RUN-16/17)', () => {
    const text = [
      'video: demo',
      'title: {kicker: "{{env:KICKER}}", text: Demo}',
      'outro: {tagline: "{{vars.nope}}"}',
      'vars: {customer: Harbour Coffee Co.}',
      'scenes:',
      '  - id: main',
      '    page: console',
      '    open: "/login?token={{env:TOKEN}}"',
      '    caption: "Signed in as {{env:EMAIL}}"',
      '    transition: {component: studio/transition-tap-open, params: {label: "{{env:EMAIL}}"}}',
      '    note: "{{env:IN_A_NOTE}} is fine"',
      '    steps:',
      '      - type: {into: {label: Password}, text: "{{keychain:northfield/agent}}"}',
      '      - click: "{{env:BUTTON}}"',
      '      - wait_for: {text: "Welcome, {{env:EMAIL}}"}',
      '        caption: {kicker: "{{vars.customer}}", text: "{{keychain:northfield/agent}}"}',
      '      - click: Save',
      '        overlay: {component: studio/callout, slots: {text: "{{env:EMAIL}}"}}',
      '      - emit: {name: "{{vars.customer}}", data: {who: "{{env:EMAIL}}"}}',
      '      - emit: "{{vars.customer}}"',
      '  - card: {slots: {title: "{{env:EMAIL}}"}}',
      '  - interstitial: {text: "{{secret:env:EMAIL}}"}',
      '  - id: both',
      '    pages: {buyer: {page: shop, open: "/q?k={{env:TOKEN}}", label: "{{env:EMAIL}}"}, seller: {page: console}}',
      '    steps:',
      '      - wait: 1',
    ].join('\n');
    const es = errors(parseScenario(text, { project }).issues).map((i) => `${formatPath(i.path)}: ${i.message.replace(/: secret references belong.*$/, '')}`);
    const shown = (expr: string) => `{{${expr}}} would be shown in the video and kept in clear in timeline.json`;
    expect(es).toEqual([
      `title.kicker: ${shown('env:KICKER')}`,
      'outro.tagline: unknown variable {{vars.nope}}; declared: customer',
      `scenes[0].caption: ${shown('env:EMAIL')}`,
      `scenes[0].transition.params.label: ${shown('env:EMAIL')}`,
      `scenes[0].steps[2].caption.text: ${shown('keychain:northfield/agent')}`,
      `scenes[0].steps[3].overlay.slots.text: ${shown('env:EMAIL')}`,
      'scenes[0].steps[4].emit.name: {{vars.customer}} is not templated here: this name is used as written',
      'scenes[0].steps[5].emit: {{vars.customer}} is not templated here: this name is used as written',
      `scenes[1].card.slots.title: ${shown('env:EMAIL')}`,
      `scenes[2].interstitial.text: ${shown('secret:env:EMAIL')}`,
      `scenes[3].pages.buyer.label: ${shown('env:EMAIL')}`,
    ]);
    // A screenshot name is a file name used as written: a token there is not slug-like.
    const shot = scenario('      - screenshot: {name: "shot-{{vars.customer}}"}\n      - screenshot: "{{vars.customer}}"\n', 'vars: {customer: x}\n');
    expect(errors(parseScenario(shot, { project }).issues).map((i) => `${formatPath(i.path)}: ${i.message}`)).toEqual([
      'scenes[0].steps[0].screenshot.name: screenshot name must be slug-like: letters, digits, "-" or "_", starting with a letter or digit',
      'scenes[0].steps[1].screenshot: screenshot name must be slug-like: letters, digits, "-" or "_", starting with a letter or digit',
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

describe('scenarioChangedSinceRun (L3.8: a render shows the run as captured)', () => {
  it('compares scenarios/<name>.yaml, else .yml, with the run\'s snapshot; undefined when either is missing', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const run = `${dir}/runs/20260101-120000-quote`;
      const text = scenario('      - hold: 1\n');
      await writeFiles(dir, { 'runs/20260101-120000-quote/scenario.yaml': text });
      const project = { dir };
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBeUndefined(); // no scenario file
      await writeFiles(dir, { 'scenarios/quote.yml': text });
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBe(false); // .yml, as a name resolves
      await writeFiles(dir, { 'scenarios/quote.yml': text.replace('hold: 1', 'hold: 3') });
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBe(true);
      // .yaml wins over .yml, like loadScenario
      await writeFiles(dir, { 'scenarios/quote.yaml': text });
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBe(false);
      await writeFiles(dir, { 'scenarios/quote.yaml': text.replace('hold: 1', 'hold: 2') });
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBe(true);
      expect(scenarioChangedSinceRun(project, `${dir}/runs/none`, 'quote')).toBeUndefined(); // no snapshot
      expect(scenarioChangedSinceRun(project, run, 'other')).toBeUndefined();
      expect(scenarioChangedSinceRun(project, run, '../scenarios/quote')).toBeUndefined(); // a name, never a path
    } finally {
      await cleanup();
    }
  });

  it('compares the data: a comment, blank lines, quoting, indentation or key order is no change; the text when either does not parse (L3.8 review L6)', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const run = `${dir}/runs/20260101-120000-quote`;
      const text = 'video: Quote\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - hold: 1\n';
      await writeFiles(dir, { 'runs/20260101-120000-quote/scenario.yaml': text });
      const project = { dir };
      const changed = async (now: string) => {
        await writeFiles(dir, { 'scenarios/quote.yaml': now });
        return scenarioChangedSinceRun(project, run, 'quote');
      };
      expect(await changed(`# the quote tour\n${text}\n\n`)).toBe(false); // a comment, blank lines
      expect(await changed(text.replace('      - hold: 1', '      - hold: 1   # one second'))).toBe(false); // an end-of-line comment
      expect(await changed(text.replace('video: Quote', 'video: "Quote"'))).toBe(false); // quoting
      expect(await changed(text.replace(/^ {2}/gm, '    '))).toBe(false); // indentation
      expect(await changed(text.replace('    page: shop\n    open: /\n', '    open: /\n    page: shop\n'))).toBe(false); // key order
      expect(await changed(text.replace('video: Quote', 'video: Quote tour'))).toBe(false); // an edit value (L5.5)
      expect(await changed(text.replace('open: /', 'open: /quote'))).toBe(true); // a filmed value
      expect(await changed(text.replace('      - hold: 1\n', '      - hold: 1\n      - hold: 1\n'))).toBe(true); // a step
      expect(await changed(`${text}  - [unclosed\n`)).toBe(true); // does not parse: the text differs
      await writeFiles(dir, { 'runs/20260101-120000-quote/scenario.yaml': 'video: [unclosed\n' });
      expect(await changed('video: [unclosed\n')).toBe(false); // neither parses: the same text
      expect(await changed('video: [unclosed\n# a comment\n')).toBe(true); // neither parses: another text
    } finally {
      await cleanup();
    }
  });

  it('reads only small regular files: a link, a FIFO, a device or a huge file is unknown, never read (L3.8 review L5)', { timeout: 10_000 }, async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const run = `${dir}/runs/20260101-120000-quote`;
      const snapshot = `${run}/scenario.yaml`;
      const text = scenario('      - hold: 1\n');
      await writeFiles(dir, { 'runs/20260101-120000-quote/scenario.yaml': text, 'scenarios/real.yaml': text, 'outside.yaml': text });
      const project = { dir };
      await symlink(`${dir}/scenarios/real.yaml`, `${dir}/scenarios/quote.yaml`);
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBeUndefined(); // the scenario file is a link
      await rm(`${dir}/scenarios/quote.yaml`);
      await writeFiles(dir, { 'scenarios/quote.yaml': text });
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBe(false);
      await rm(snapshot);
      await symlink(`${dir}/outside.yaml`, snapshot);
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBeUndefined(); // the snapshot is a link
      await rm(snapshot);
      await symlink('/dev/zero', snapshot);
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBeUndefined(); // a link to a device
      await rm(snapshot);
      execFileSync('mkfifo', [snapshot]);
      const started = Date.now();
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBeUndefined(); // a FIFO nobody writes: never opened for a blocking read
      expect(Date.now() - started).toBeLessThan(2000);
      await rm(snapshot);
      await writeFile(snapshot, text);
      await writeFile(`${dir}/scenarios/quote.yaml`, `${text}# ${'x'.repeat(SCENARIO_COMPARE_MAX_BYTES)}\n`);
      expect(scenarioChangedSinceRun(project, run, 'quote')).toBeUndefined(); // over the size limit
    } finally {
      await cleanup();
    }
  });

  it('the message names the scenario, the run, the filmed parts that changed and what films them (L5.5)', () => {
    expect(scenarioChangedMessage('quote', '20260101-120000-quote', '`retake run demo quote`', ['scene a: step a.2 changed'])).toBe(
      'the filmed part of scenario quote changed since run 20260101-120000-quote was captured (scene a: step a.2 changed): a render shows that take as it was captured, its edit included — a change to what the browser does (steps, pages, hooks, capture settings) shows only in a new capture: `retake run demo quote`, then render; a change to the edit alone (captions, cards, overlays, durations, title, intro/outro, template) renders on the existing take',
    );
    expect(scenarioChangedMessage('quote', 'r', 'x')).toContain('(the file no longer reads as YAML)');
    const many = Array.from({ length: 10 }, (_v, i) => `scene s${i} added`);
    expect(scenarioChangedMessage('quote', 'r', 'x', many)).toContain('scene s7 added; and 2 more)');
  });
});

describe('loadScenario reads the file once and pins its bytes', () => {
  const sha = (t: string) => createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');

  it('one read: the bytes hashed are the bytes parsed, whatever a later read of the file returns', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const first = scenario('      - hold: 1\n');
      const later = scenario('      - hold: 3\n');
      await writeFiles(dir, { 'scenarios/quote.yaml': first });
      const p = fakeProject(dir);
      const reads: string[] = [];
      // The first read returns the file's bytes, every later one other bytes.
      const readFile = async (file: string) => {
        reads.push(file);
        return Buffer.from(reads.length === 1 ? first : later, 'utf8');
      };
      const loaded = await loadScenario(p, 'quote', { expectSha256: sha(first), readFile });
      expect(reads).toEqual([`${dir}/scenarios/quote.yaml`]);
      expect(loaded.sha256).toBe(sha(first));
      expect(loaded.text).toBe(first);
      expect(loaded.scenario.scenes[0].steps).toEqual([{ hold: 1 }]);
      // Without a pin: still one read, its hash returned.
      reads.length = 0;
      const src = await readScenarioSource(p, 'quote', { readFile });
      expect([reads.length, src.sha256, src.text]).toEqual([1, sha(first), first]);
    } finally {
      await cleanup();
    }
  });

  it('other bytes than expected: ScenarioChangedError with both hashes, nothing parsed', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const shown = scenario('      - hold: 1\n');
      // What is on disk now does not even parse: the error is the change, never its validation.
      await writeFiles(dir, { 'scenarios/quote.yaml': 'video: [\n' });
      const e = await loadScenario(fakeProject(dir), 'quote', { expectSha256: sha(shown) }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ScenarioChangedError);
      expect(e).toMatchObject({ name: 'ScenarioChangedError', expected: sha(shown), actual: sha('video: [\n'), issues: [] });
      expect((e as Error).message).toContain('changed');
      // The same bytes as expected load.
      await writeFiles(dir, { 'scenarios/quote.yaml': shown });
      expect((await loadScenario(fakeProject(dir), 'quote', { expectSha256: sha(shown) })).sha256).toBe(sha(shown));
    } finally {
      await cleanup();
    }
  });
});
