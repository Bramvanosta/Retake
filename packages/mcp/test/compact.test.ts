/**
 * Compact results (L5.8, R-FLD-34): run_status, review / review_get and page_inspect answer compactly by default and in
 * full on request; their JSON is one line; job_status waits up to 10 minutes; the server's instructions point to
 * sandboxes, hook steps and the compact results. Pure: synthetic engine views, no worker.
 */
import { describe, expect, it } from 'vitest';
import type { ReviewView, RunStatusWithJob } from '@demo-studio/engine';
import { INSTRUCTIONS, TOOLS, okResult } from '../src/index.js';
import { COMPACT_FINDINGS_MAX, COMPACT_WARNINGS_MAX, compactElements, compactReview, compactRunStatus } from '../src/compact.js';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

const RUN: RunStatusWithJob = {
  id: '20261026-200205-quote',
  scenario: 'quote',
  mode: 'dry',
  status: 'failed',
  env: 'local',
  started_at: '2026-10-26T19:02:05.000Z',
  finished_at: '2026-10-26T19:03:03.200Z',
  duration_ms: 58_200,
  steps_done: 21,
  steps_total: 25,
  project: 'northfield-fixture',
  dir: '/p/runs/r',
  hooks: { setup: 'skipped', teardown: 'none' },
  options: { hooks: 'skip', headed: false },
  environment: { production: false, access: 'read-write' },
  outputs: [
    { ref: 'runs/r/run.json', path: '/p/runs/r/run.json' },
    { ref: 'runs/r/timeline.json', path: '/p/runs/r/timeline.json', sha256: 'a'.repeat(64) },
  ],
  screenshots: Array.from({ length: 20 }, (_, i) => ({ ref: `runs/r/screenshots/s-${i}.png`, path: `/p/runs/r/screenshots/s-${i}.png` })),
  error: { scene: 'proposal', step: 2, action: 'click', screenshot: { ref: 'runs/r/screenshots/error.png', path: '/p/runs/r/screenshots/error.png' } },
  finished: true,
  untrusted: { error_message: 'no visible element matches', warnings: Array.from({ length: 12 }, (_, i) => `warning ${i}`), missing_targets: [] },
} as unknown as RunStatusWithJob;

describe('compact run status', () => {
  it('keeps the status, where it failed and the paths; drops the per-step screenshot list, hashes and options', () => {
    const c = compactRunStatus(RUN);
    expect(c).toMatchObject({
      id: RUN.id,
      status: 'failed',
      steps_done: 21,
      duration_s: 58.2,
      hooks: { setup: 'skipped' },
      error: { scene: 'proposal', step: 2, action: 'click', screenshot: '/p/runs/r/screenshots/error.png' },
      files: { dir: '/p/runs/r', timeline: '/p/runs/r/timeline.json', screenshots: { dir: '/p/runs/r/screenshots', count: 20 } },
    });
    expect(c).not.toHaveProperty('screenshots');
    expect(c).not.toHaveProperty('outputs');
    expect(c).not.toHaveProperty('options');
    const u = c.untrusted as { warnings: string[]; warnings_total: number; error_message: string };
    expect(u.warnings).toHaveLength(COMPACT_WARNINGS_MAX);
    expect(u.warnings_total).toBe(12);
    expect(u.error_message).toBe('no visible element matches');
    expect(JSON.stringify(c).length).toBeLessThan(JSON.stringify(RUN).length / 2);
  });
});

describe('compact review', () => {
  it('keeps every error and the warnings (capped) with their messages; drops notes, durations per segment and per-file key frames', () => {
    const findings = [
      { severity: 'error', code: 'blank-frame', at: { time: 3 } },
      ...Array.from({ length: COMPACT_FINDINGS_MAX + 5 }, (_, i) => ({ severity: 'warning', code: 'caption-too-long', at: { time: i } })),
      { severity: 'info', code: 'slow-transition', at: { time: 9 } },
    ];
    const r = {
      project: 'p',
      render_id: 'quote-v1',
      status: 'succeeded',
      finished: true,
      dir: '/p/review/quote-v1',
      clean: false,
      counts: { error: 1, warning: COMPACT_FINDINGS_MAX + 5, info: 1 },
      findings,
      durations: { total_s: 60.9, segments: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, kind: 'clip', from_s: i, to_s: i + 1, duration_s: 1, component: 'studio/layout-card' })) },
      files: { sheets: ['/p/review/quote-v1/sheet_1fps.jpg'], scene_sheets: { a: ['/x/a.jpg'], b: ['/x/b.jpg'] }, keyframes: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, `/x/k${i}.jpg`])), report_json: '/p/review/quote-v1/report.json', report_md: '/p/review/quote-v1/report.md' },
      images: [],
      untrusted: { messages: findings.map((f, i) => `message ${i} ${'x'.repeat(i === 0 ? 900 : 10)}`), environment: { name: 'local' } },
    } as unknown as ReviewView;
    const c = compactReview(r) as { findings: Array<{ code: string }>; findings_left_out: number; untrusted: { messages: string[] }; files: Record<string, unknown>; duration_s: number };
    expect(c.findings).toHaveLength(1 + COMPACT_FINDINGS_MAX);
    expect(c.findings[0].code).toBe('blank-frame');
    expect(c.findings.some((f) => f.code === 'slow-transition')).toBe(false);
    expect(c.findings_left_out).toBe(5);
    expect(c.untrusted.messages).toHaveLength(c.findings.length);
    expect(c.untrusted.messages[0]).toMatch(/^message 0 x+… \(\d+ more characters\)$/);
    expect(c.files).toEqual({ sheets: ['/p/review/quote-v1/sheet_1fps.jpg'], report_md: '/p/review/quote-v1/report.md', report_json: '/p/review/quote-v1/report.json', keyframes: { dir: '/p/review/quote-v1/keyframes', count: 17 }, scene_sheets: 2 });
    expect(c.duration_s).toBe(60.9);
    expect(c).not.toHaveProperty('durations');
  });
});

describe('compact inspection', () => {
  const el = (mark: number, o: Record<string, unknown> = {}) => ({
    mark,
    bbox: { x: 1, y: 2, w: 3, h: 4 },
    in_view: true,
    in: 'page',
    where: 'document',
    state: { disabled: false, expanded: false, checked: false, selected: false, popup_expected: false, covered: false },
    verified: true,
    matches: 1,
    fragile: [],
    action: 'click',
    action_verified: true,
    untrusted: { role: 'button', tag: 'button', input_type: null, name: `Button ${mark}`, text: `Button ${mark}`, label: null, placeholder: null, testid: null, href_path: null, target: `Button ${mark}`, target_yaml: `Button ${mark}`, hint: { step: { click: `Button ${mark}` }, yaml: `{ click: Button ${mark} }` } },
    ...o,
  });

  it('lists the elements in view or in a dialog, menu or popover, each with its hint and only the flags that are set', () => {
    const { elements, left_out } = compactElements([
      el(1),
      el(2, { in_view: false }),
      el(3, { in_view: false, in: 'dialog', state: { disabled: true, expanded: false, checked: false, selected: false, popup_expected: false, covered: true }, matches: 2, fragile: ['nth'] }),
      el(4, { in_view: false, in: 'row' }),
      el(5, { untrusted: { role: 'link', tag: 'a', name: 'Coffees', href_path: '/products', target: null, target_yaml: null, hint: null } }),
    ]);
    expect(left_out).toBe(2);
    expect(elements).toEqual([
      { mark: 1, in: 'page', action: 'click', untrusted: { role: 'button', name: 'Button 1', hint: '{ click: Button 1 }' } },
      { mark: 3, in: 'dialog', action: 'click', matches: 2, fragile: ['nth'], state: ['disabled', 'covered'], out_of_view: true, untrusted: { role: 'button', name: 'Button 3', hint: '{ click: Button 3 }' } },
      { mark: 5, in: 'page', action: 'click', untrusted: { role: 'link', name: 'Coffees', target: null, href_path: '/products' } },
    ]);
  });
});

describe('the tools', () => {
  it('run_status, review, review_get, page_inspect and job_status take `detail` (compact by default); job_status waits up to 600 s, the others 25', () => {
    for (const name of ['run_status', 'review', 'review_get', 'page_inspect', 'job_status']) {
      const input = tool(name).input;
      expect(input.parse({ ...required(name) }).detail, name).toBe('compact');
      expect(input.parse({ ...required(name), detail: 'full' }).detail, name).toBe('full');
    }
    expect(tool('job_status').input.safeParse({ job_id: JOB, wait_s: 600 }).success).toBe(true);
    expect(tool('job_status').input.safeParse({ job_id: JOB, wait_s: 601 }).success).toBe(false);
    expect(tool('run_status').input.safeParse({ project: 'p', run_id: '20261026-200205-quote', wait_s: 26 }).success).toBe(false);
  });

  it('results carry their JSON on one line', () => {
    const r = okResult({ summary: 's', data: { a: { b: [1, 2] } } });
    expect(r.content[1]).toEqual({ type: 'text', text: '{"a":{"b":[1,2]}}' });
  });

  it('the instructions point to sandboxes, hook steps, offscreen scenes and the compact results', () => {
    expect(INSTRUCTIONS).toContain('Never reset data by hand between takes');
    expect(INSTRUCTIONS).toContain('run_capture {sandbox: true}');
    expect(INSTRUCTIONS).toContain('`hook: <name>` step');
    expect(INSTRUCTIONS).toContain('`offscreen: true`');
    expect(INSTRUCTIONS).toContain('detail: "full"');
    expect(INSTRUCTIONS).toContain('job_status {wait_s: up to 600}');
  });
});

const JOB = 'j_01M5WSQ8ZNWMJ5RWQ4AVGC3VHH';

function required(name: string): Record<string, unknown> {
  switch (name) {
    case 'run_status':
      return { project: 'p', run_id: '20261026-200205-quote' };
    case 'review':
    case 'review_get':
      return { project: 'p', render_id: 'latest' };
    case 'page_inspect':
      return { project: 'p', page: 'console' };
    default:
      return { job_id: JOB };
  }
}
