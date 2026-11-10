/**
 * L5.6 — capture reliability, the scenario language side: `defaults: {timeout_s}` in project.yaml and a scenario
 * (R-FLD-14), a persona's `email` and `wait_for_email {to: persona:<name>}` (R-FLD-15), `retry_click` (R-FLD-12),
 * `capture.step_shots` and the run record's `optional_failures` / `error.missing_targets` (R-FLD-10, R-FLD-16).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunRecordSchema, filmedChanges, mailPersona, parseProjectYaml, parseScenario, personaEmail, sandboxAuth } from '@retake/core';
import type { LoadedProject, SandboxManifest, ValidationIssue } from '@retake/core';
import { errors, warnings } from './helpers.js';

const errs = (issues: ValidationIssue[]) => errors(issues).map((i) => `${i.path.join('.')}: ${i.message}`);
const warns = (issues: ValidationIssue[]) => warnings(issues).map((i) => `${i.path.join('.')}: ${i.message}`);

const PROJECT = [
  'name: Northfield',
  'environments:',
  '  local: {console: "http://localhost:4401", shop: "http://localhost:4402"}',
  '  signed-in: {console: "http://localhost:4403", shop: "http://localhost:4404"}',
  'defaults: {timeout_s: 30}',
  'mailbox: {provider: mailpit, url: "http://localhost:4401/mailbox"}',
  'auth:',
  '  signed-in:',
  '    login_url: /sign-in',
  '    personas:',
  '      supplier: {email: maja@northfield.example, pages: [console], check: {url: "console:/", expect_text: Maja}}',
  '      buyer: {pages: [shop], check: {url: "shop:/", expect_text: Demo Café}}',
  '',
];

function project(lines: string[] = PROJECT): LoadedProject {
  const { config, issues } = parseProjectYaml(lines.join('\n'));
  if (!config) throw new Error(errs(issues).join('\n'));
  const dir = mkdtempSync(join(tmpdir(), 'ds-reliability-'));
  return { slug: 'northfield', dir, root: dir, config, readme: null, scenarios: [], file: join(dir, 'project.yaml'), issues };
}

const scenario = (steps: string[], head: string[] = ['env: signed-in']) =>
  ['video: demo', ...head, 'scenes:', '  - id: a', '    page: console', '    open: /', '    steps:', ...steps.map((s) => `      - ${s}`), ''].join('\n');

describe('defaults.timeout_s (R-FLD-14)', () => {
  it('a project and a scenario set it; it is a positive number of seconds; nothing else goes in `defaults`', () => {
    expect(project().config.defaults).toEqual({ timeout_s: 30 });
    const bad = parseProjectYaml([...PROJECT.slice(0, 4), 'defaults: {timeout_s: 0, pacing: 1}', ''].join('\n'));
    expect(errs(bad.issues).map((m) => m.split(':')[0])).toEqual(expect.arrayContaining(['defaults.timeout_s', 'defaults']));
    const sc = parseScenario(scenario(['wait: 1'], ['env: signed-in', 'defaults: {timeout_s: 45}']), { project: project() });
    expect(errs(sc.issues)).toEqual([]);
    expect(sc.scenario?.defaults).toEqual({ timeout_s: 45 });
    expect(errs(parseScenario(scenario(['wait: 1'], ['defaults: {timeout_s: -2}'])).issues)).toEqual([expect.stringMatching(/^defaults\.timeout_s: /)]);
  });
});

describe('persona mail addresses (R-FLD-15)', () => {
  it('a persona takes an `email` (an address, else an error)', () => {
    expect(personaEmail(project().config, 'signed-in', 'supplier')).toBe('maja@northfield.example');
    expect(personaEmail(project().config, 'signed-in', 'buyer')).toBeUndefined();
    expect(personaEmail(project().config, 'local', 'supplier')).toBeUndefined();
    const bad = parseProjectYaml(PROJECT.join('\n').replace('email: maja@northfield.example', 'email: maja'));
    expect(errs(bad.issues)).toEqual(['auth.signed-in.personas.supplier.email: email is a mail address (name@example.com)']);
  });

  it('`persona:<name>` names a persona of the scenario\'s environment that has an email', () => {
    expect(mailPersona('persona:buyer')).toBe('buyer');
    expect(mailPersona('persona: buyer ')).toBe('buyer');
    expect(mailPersona('buyer@cafe.example')).toBeNull();
    expect(mailPersona(undefined)).toBeNull();
    const p = project();
    const ok = parseScenario(scenario(['wait_for_email: {to: "persona:supplier", subject: Pro forma, as: copy}']), { project: p });
    expect(errs(ok.issues)).toEqual([]);
    const bad = parseScenario(
      scenario([
        'wait_for_email: {to: "persona:buyer", as: a}',
        'wait_for_email: {to: "persona:suplier", as: b}',
        'wait_for_email: {to: "persona:", as: c}',
      ]),
      { project: p },
    );
    expect(errs(bad.issues)).toEqual([
      'scenes.0.steps.0.wait_for_email.to: persona "buyer" has no `email` on environment signed-in: add email: <address> to auth.personas.buyer in project.yaml (or to its sandbox account)',
      'scenes.0.steps.1.wait_for_email.to: unknown persona "suplier" (did you mean "supplier"?) (personas of signed-in: supplier, buyer)',
      'scenes.0.steps.2.wait_for_email.to: `persona:` needs a persona name, e.g. persona:buyer',
    ]);
    const local = parseScenario(scenario(['wait_for_email: {to: "persona:supplier", as: a}'], ['env: local']), { project: p });
    expect(errs(local.issues)).toEqual(['scenes.0.steps.0.wait_for_email.to: unknown persona "supplier": no personas on environment local']);
  });

  it('a sandbox account signed in with its mail address receives its mail there; an explicit email wins', () => {
    const { auth } = sandboxAuth({
      accounts: {
        buyer: { username: 'orders@demo-cafe.example', password: 'x', pages: ['shop'] },
        admin: { username: 'admin', password: 'y' },
        supplier: { username: 'maja@northfield.example', email: 'maja.lindqvist@northfield.example' },
      },
    } as unknown as SandboxManifest);
    expect(Object.fromEntries(Object.entries(auth!.personas!).map(([k, v]) => [k, v.email ?? null]))).toEqual({
      buyer: 'orders@demo-cafe.example',
      admin: null,
      supplier: 'maja.lindqvist@northfield.example',
    });
  });
});

describe('retry_click and capture.step_shots (R-FLD-12, R-FLD-16)', () => {
  it('retry_click belongs on a click; elsewhere it is ignored with a warning', () => {
    const r = parseScenario(scenario(['{click: Preview, retry_click: true}', '{double_click: Report, retry_click: true}', '{type: {into: {label: Notes}, text: x}, retry_click: true}']), {
      project: project(),
    });
    expect(errs(r.issues)).toEqual([]);
    expect(warns(r.issues)).toEqual(['scenes.0.steps.2.retry_click: `retry_click` applies to click and double_click steps: ignored on a type step']);
    expect(errs(parseScenario(scenario(['{click: Preview, retry_click: 2}'])).issues)).toEqual([expect.stringMatching(/^scenes\.0\.steps\.0\.retry_click: /)]);
  });

  it('capture.step_shots is a boolean of a project or a scenario', () => {
    expect(errs(parseScenario(scenario(['wait: 1'], ['capture: {step_shots: true}'])).issues)).toEqual([]);
    expect(errs(parseScenario(scenario(['wait: 1'], ['capture: {step_shots: yes please}'])).issues)).toEqual([expect.stringMatching(/^capture\.step_shots: /)]);
    expect(project([...PROJECT, 'capture: {step_shots: true}']).config.capture.step_shots).toBe(true);
  });

  it('run.json keeps the failed optional steps and the missing targets of a failed step', () => {
    const rec = {
      id: 'r',
      project: 'p',
      scenario: 's',
      mode: 'capture',
      status: 'failed',
      started_at: 'x',
      finished_at: 'y',
      dir: '/d',
      env: 'local',
      options: { hooks: 'run', headed: false },
      steps_total: 3,
      steps_done: 2,
      screenshots: [],
      hooks: { setup: 'none', teardown: 'none' },
      warnings: [],
      optional_failures: [{ scene: 'a', step: 0, action: 'click', error: 'no visible element…', screenshot: '/d/screenshots/error-a-0.png' }],
      error: {
        message: 'no visible element matches text="Download CSV"',
        scene: 'a',
        step: 1,
        action: 'click',
        missing_targets: [{ scene: 'a', step: 2, action: 'type', target: 'label="Customer name"', near: [{ role: 'textbox', name: 'Customer' }] }],
      },
    };
    expect(RunRecordSchema.safeParse(rec).success).toBe(true);
    expect(RunRecordSchema.safeParse({ ...rec, optional_failures: [{ scene: 'a' }] }).success).toBe(false);
  });
});

describe('the filmed part (L5.5) and the L5.6 options', () => {
  it('retry_click is filmed (a second click); defaults.timeout_s and capture.step_shots are not', () => {
    const base = 'video: v\nscenes:\n  - id: a\n    open: /\n    steps:\n      - click: Preview\n';
    expect(filmedChanges(base.replace('      - click: Preview\n', '      - {click: Preview, retry_click: true}\n'), base)).toEqual(['scene a: step a.0 changed']);
    expect(filmedChanges(`defaults: {timeout_s: 30}\ncapture: {step_shots: true}\n${base}`, base)).toEqual([]);
    expect(filmedChanges(`capture: {step_shots: true, fps: 60}\n${base}`, base)).toEqual(['the capture settings']);
  });
});
