/**
 * L2.9 contracts in core: project `mailbox` (allow-listed host), actions `wait_for_email` and `download`, artefact
 * references in slots (`email:`, `document:`, `notification:`), transitions as components on scenes and cards, and the
 * timeline `artefacts` / `notification` events.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TimelineSchema, isDocumentPath, isHostAllowed, parseProjectYaml, parseScenario, PERSON_POLICY } from '@retake/core';
import type { LoadedProject, Timeline, ValidationIssue } from '@retake/core';
import { errors, warnings } from './helpers.js';
import { fileFacts } from '@retake/core/io';

const errs = (issues: ValidationIssue[]) => errors(issues).map((i) => `${i.line}:${i.col} ${i.path.join('.')}: ${i.message}`);
const warns = (issues: ValidationIssue[]) => warnings(issues).map((i) => `${i.path.join('.')}: ${i.message}`);

const PROJECT_YAML = (extra = '') =>
  ['name: Demo', 'environments:', '  local:', '    shop: http://localhost:4402', '    console: https://console.staging.example.com', extra, ''].join('\n');

function project(mailbox = true): LoadedProject {
  const dir = mkdtempSync(join(tmpdir(), 'ds-artefacts-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'terms.pdf'), '%PDF-1.4\n');
  const { config } = parseProjectYaml(PROJECT_YAML(mailbox ? 'mailbox: {provider: mailpit, url: "http://localhost:8025"}' : ''));
  return { slug: 'demo', dir, root: dir, config: config!, readme: null, scenarios: [], file: join(dir, 'project.yaml') };
}

const scenario = (...lines: string[]) =>
  ['video: demo', 'scenes:', '  - id: signup', '    page: shop', '    open: /', '    steps:', ...lines.map((l) => `      ${l}`), ''].join('\n');

describe('project mailbox (R-MAIL-01)', () => {
  it('accepts mailpit and http providers on an allowed host', () => {
    for (const line of ['mailbox: {provider: mailpit, url: "http://localhost:8025"}', 'mailbox: {provider: http, url: "https://console.staging.example.com/mail", poll_ms: 250}']) {
      const r = parseProjectYaml(PROJECT_YAML(line));
      expect(errs(r.issues), line).toEqual([]);
      expect(r.config?.mailbox?.url).toMatch(/^http/);
    }
  });

  it('refuses a host outside the allow-list, unknown providers and bad URLs', () => {
    const r = parseProjectYaml(PROJECT_YAML('mailbox: {provider: mailpit, url: "https://mail.example.org"}'));
    expect(errs(r.issues).join('\n')).toMatch(/6:\d+ mailbox\.url: mailbox host mail\.example\.org is not allowed/);
    const ok = parseProjectYaml(PROJECT_YAML('allow_hosts: ["*.example.org"]\nmailbox: {provider: mailpit, url: "https://mail.example.org"}'));
    expect(errs(ok.issues)).toEqual([]);
    expect(errs(parseProjectYaml(PROJECT_YAML('mailbox: {provider: imap, url: "http://localhost"}')).issues).join('\n')).toMatch(/mailbox\.provider/);
    expect(errs(parseProjectYaml(PROJECT_YAML('mailbox: {provider: mailpit, url: "localhost:8025"}')).issues).join('\n')).toMatch(/mailbox\.url/);
  });

  it('isHostAllowed is shared with the hooks', () => {
    const p = project();
    expect(isHostAllowed('localhost', p)).toBe(true);
    expect(isHostAllowed('console.staging.example.com', p)).toBe(true);
    expect(isHostAllowed('evil.example.com', p)).toBe(false);
  });
});

describe('wait_for_email and download (R-MAIL-02, R-DOC-01)', () => {
  it('parse with their artefact names', () => {
    const r = parseScenario(
      scenario('- wait_for_email: {to: "@cafe.example", subject: "/confirm/i", timeout: 20, as: welcome}', '- download: {click: Download quote PDF, as: quote}'),
      { files: fileFacts(PERSON_POLICY), project: project() },
    );
    expect(errs(r.issues)).toEqual([]);
    expect(warns(r.issues)).toEqual([]);
  });

  it('need `as`, a mailbox, a valid regex and a target', () => {
    expect(errs(parseScenario(scenario('- wait_for_email: {to: x}'), { files: fileFacts(PERSON_POLICY), project: project() }).issues).join('\n')).toMatch(/as/);
    expect(errs(parseScenario(scenario('- wait_for_email: {to: x, as: w}'), { files: fileFacts(PERSON_POLICY), project: project(false) }).issues).join('\n')).toMatch(
      /has no `mailbox`: add mailbox/,
    );
    expect(errs(parseScenario(scenario('- wait_for_email: {subject: "/(/", as: w}'), { files: fileFacts(PERSON_POLICY), project: project() }).issues).join('\n')).toMatch(/invalid regular expression/);
    expect(errs(parseScenario(scenario('- download: {click: {nth: 1}, as: d}'), { files: fileFacts(PERSON_POLICY), project: project() }).issues).join('\n')).toMatch(/target needs at least one of/);
    expect(warns(parseScenario(scenario('- wait_for_email: {as: w}'), { files: fileFacts(PERSON_POLICY), project: project() }).issues).join('\n')).toMatch(/captures the first new message/);
  });

  it('report duplicate artefact names', () => {
    const r = parseScenario(scenario('- download: {click: A, as: doc}', '- download: {click: B, as: doc}'), { files: fileFacts(PERSON_POLICY), project: project() });
    expect(errs(r.issues).join('\n')).toMatch(/document "doc" is already captured at scenes\[0\]\.steps\[0\]/);
  });
});

describe('artefact references in slots (validation)', () => {
  const withCard = (slots: string, steps: string[] = []) =>
    [
      'video: demo',
      'scenes:',
      '  - id: signup',
      '    page: shop',
      '    open: /',
      '    steps:',
      '      - wait_for_email: {to: buyer, as: welcome}',
      '      - download: {click: Download, as: quote}',
      ...steps.map((s) => `      ${s}`),
      `  - card: {component: studio/mail-view, slots: ${slots}}`,
      '',
    ].join('\n');

  it('accepts captured names, project files and notification names / indexes', () => {
    for (const slots of ['{email: welcome}', '{document: quote}', '{document: assets/terms.pdf}', '{notification: "2"}', '{notification: quote-request}']) {
      expect(errs(parseScenario(withCard(slots), { files: fileFacts(PERSON_POLICY), project: project() }).issues), slots).toEqual([]);
    }
  });

  it('reports unknown names with a suggestion, missing project files and wrong file types', () => {
    const e1 = errs(parseScenario(withCard('{email: welcom}'), { files: fileFacts(PERSON_POLICY), project: project() }).issues).join('\n');
    expect(e1).toMatch(/unknown email "welcom": no wait_for_email step captures it as `as: welcom` \(did you mean "welcome"\?\)/);
    expect(errs(parseScenario(withCard('{document: assets/missing.pdf}'), { files: fileFacts(PERSON_POLICY), project: project() }).issues).join('\n')).toMatch(/document "assets\/missing\.pdf" not found/);
    expect(errs(parseScenario(withCard('{document: assets/terms.docx}'), { files: fileFacts(PERSON_POLICY), project: project() }).issues).join('\n')).toMatch(/must be a \.pdf, \.png/);
    expect(errs(parseScenario(withCard('{notification: "0"}'), { files: fileFacts(PERSON_POLICY), project: project() }).issues).join('\n')).toMatch(/1-based index/);
  });

  it('checks overlay slots too', () => {
    const r = parseScenario(scenario('- wait: 1', '  overlay: {component: studio/mail-notification, slots: {email: nope}}'), { files: fileFacts(PERSON_POLICY), project: project() });
    expect(errs(r.issues).join('\n')).toMatch(/steps\.0\.overlay\.slots\.email: unknown email "nope"/);
  });

  it('isDocumentPath tells project files from artefact names', () => {
    expect(isDocumentPath('assets/x.pdf')).toBe(true);
    expect(isDocumentPath('terms.pdf')).toBe(true);
    expect(isDocumentPath('quote')).toBe(false);
    expect(isDocumentPath('quote-2027')).toBe(false);
  });
});

describe('transitions as components (R-NTF-04)', () => {
  it('scenes and cards accept a kind, an id or {component, params}', () => {
    const text = [
      'video: demo',
      'scenes:',
      '  - id: a',
      '    open: /',
      '    steps: [{wait: 1}]',
      '  - card: {slots: {title: Hi}, transition: studio/transition-tap-open}',
      '  - id: b',
      '    transition: {component: studio/transition-tap-open, params: {duration: 0.7}}',
      '    steps: [{wait: 1}]',
      '  - id: c',
      '    transition: fade-black',
      '    steps: [{wait: 1}]',
      '',
    ].join('\n');
    const r = parseScenario(text);
    expect(errs(r.issues)).toEqual([]);
    const bad = parseScenario(text.replace('fade-black', 'Tap Open'));
    expect(errs(bad.issues).join('\n')).toMatch(/transition/);
  });
});

describe('timeline artefacts (R-MAIL-02, R-DOC-01, R-NTF-03)', () => {
  it('the schema accepts emails, documents, notifications and notification events', () => {
    const tl: Timeline = {
      version: 1,
      run_id: 'r',
      project: 'p',
      scenario: 's',
      created_at: '2026-10-12T00:00:00.000Z',
      mode: 'capture',
      capture: { file: 'capture.mp4', width: 1920, height: 1080, scale: 1, fps: 30, duration: 10, t0_wall: 0, frames: 300 },
      scenes: [{ id: 's', index: 0, kind: 'scene', t_start: 0, t_end: 10, status: 'ok', transition: { component: 'studio/transition-tap-open' } }],
      events: [{ scene: 's', scene_index: 0, step: -1, action: 'notification', t_start: 4, t_end: 4, status: 'ok', data: { name: 'n' } }],
      markers: [],
      pages: [],
      cursor: [],
      idle: [],
      warnings: [],
      artefacts: [
        { kind: 'email', name: 'welcome', t: 3, file: 'artefacts/emails/welcome.json', from: 'a@b.c', to: ['d@e.f'], subject: 'Hi', date: '2026-10-12T00:00:00Z', preview: 'Hello', image: { file: 'artefacts/emails/welcome.png', width: 600, height: 900 } },
        { kind: 'document', name: 'quote', t: 5, file: 'artefacts/documents/quote.pdf', mime: 'application/pdf', file_name: 'Quote.pdf', via: 'download', bytes: 1000, pages: [{ file: 'artefacts/documents/quote/page-1.png', width: 1588, height: 2246, width_pt: 595.28, height_pt: 841.89 }] },
        { kind: 'notification', name: 'notification-1', t: 4, file: 'artefacts/notifications/notification-1.json', index: 1, title: 'New', body: 'Body', origin: 'http://localhost:4401', via: 'Notification', time: '2026-10-12T00:00:04Z' },
      ],
    };
    const r = TimelineSchema.safeParse(tl);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(TimelineSchema.safeParse({ ...tl, artefacts: [{ kind: 'video', name: 'x' }] }).success).toBe(false);
  });
});
