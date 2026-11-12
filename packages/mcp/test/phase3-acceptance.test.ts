/**
 * L3.8 phase 3 acceptance through MCP (slow: gated by RETAKE_TEST_SLOW=1 — `pnpm test:slow`, several minutes).
 * One chained story on ONE empty scratch workspace, the fixture product on free ports: an SDK client drives
 * `retake mcp` (spawned from the sources over stdio) the way the skills tell Claude to — deterministically, no model —
 * from a README to a commented, fixed and re-rendered video. One test per requirement, sharing the workspace:
 *   R-ACC3-01  project_create from the README the user hands (environments on the fixture's ports);
 *   R-ACC3-02  scenario_from_script on a timecoded table, each beat rewritten into real steps from page_inspect hints
 *              (validate, save with if_match, inspect until), Send irreversible + wait_for + mark: sent + hold in one
 *              scene, then run_dry — no write reaches the fixture from inspections or the dry run;
 *   R-ACC3-03  template_create_from_brand from invented brand files and the README's colours (they pass the contrast
 *              thresholds unlifted), template_preview (the palette drawn);
 *   R-ACC3-04  the component skill's loop: look first, component_create, the kit example written into index.tsx and
 *              component.yaml, component_validate after each code write, preview in the new theme, one real code
 *              iteration (the still changes), one still in another theme;
 *   R-ACC3-05  run_capture, plan_preview (≥ 60 s, the component as the intro), render with the new theme and the
 *              component, review clean;
 *   R-ACC3-06  a person's comment (`retake comment add --marker sent`, their own terminal) → comments_list →
 *              scenario_get / validate / save → plan_preview on the old run says scenario_changed → run_capture →
 *              render → review → comment_reply → comment_resolve with the reply's hash.
 * The client declares elicitation.form and records every request: none may come (no hook, no URL in this chain).
 * Each phase's calls are checked as an explicit sequence, against the tools its skill sections name (as a set), and
 * against the rules the skills state (validate after each code write, if_match hashes, validate before save, no
 * render after a scenario save until a capture succeeded, the resolve with the reply's hash and the new render).
 * With RETAKE_ACCEPTANCE_KEEP=<folder>, the inspections, stills, sheets, key frames, the comment's still, the
 * diff sheet, the videos and the scenario are copied there to look at.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { flowYaml, parseYaml, scenarioChangedMessage } from '@retake/core';
import { readWorkerLock } from '@retake/engine';
import { REPO } from '@retake/test-support/repo';
import { TEMPLATES } from '@retake/test-support/repo';
import { linkSharedCache } from '@retake/test-support/render';
import { testChildEnv } from '@retake/test-support/child-env';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const TSX = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const tool = (n: string) => spawnSync(n, ['-version'], { stdio: 'ignore' }).status === 0;
const ENABLED = process.env.RETAKE_TEST_SLOW === '1' && tool('ffmpeg') && tool('ffprobe');
const KEEP = process.env.RETAKE_ACCEPTANCE_KEEP;
const STEP = 900_000;
const PROJECT = 'northfield';
const SCENARIO = 'quote-tour';
const THEME = 'roastery';
const COMPONENT = 'northfield/intro-split';
const POLLING = new Set(['run_status', 'render_status', 'job_status', 'review_get']);

/** The colours the README gives: chosen to pass every contrast check as they are (text 7:1, muted 4.5:1, accent 3:1 on the paper and the dark tone). */
const COLORS = { accent: '#b8561f', text: '#2b1d14', paper: '#f6f0e6', muted: '#6a5546', dark: '#24170f' };

/** The README the user hands (invented product, names and hosts). */
const readme = (urls: { shop: string; console: string }) =>
  [
    '# Northfield Roasters',
    '',
    '## Product',
    'A wholesale shop where cafés discover specialty coffee lots and request quotes from the roaster, and a console',
    'where the roaster answers them with priced proposals.',
    '',
    '## Audience',
    'Café owners and head baristas who buy beans every week.',
    '',
    '## Goals',
    '- Show how fast a café requests a quote: the lot, the quantity, the delivery window, sent.',
    '',
    '## Tone',
    'Calm and precise; short captions, no hype.',
    '',
    '## Brand',
    `- Accent ${COLORS.accent}, text ${COLORS.text}, paper ${COLORS.paper}, muted ${COLORS.muted}, dark ${COLORS.dark}.`,
    '- Name: Northfield Roasters; address on the outro: northfield-roasters.test.',
    '- Logo and fonts: in the workspace brand/ folder.',
    '',
    '## Environments & links',
    `- local: shop ${urls.shop}, console ${urls.console} (demo data only).`,
    '',
  ].join('\n');

/** The timecoded script the user hands (English headers). The confirmation text comes from it, not from a replay. */
const SCRIPT = [
  '| Time | Scene | Action | Kicker | Caption | Page | Type |',
  '|---|---|---|---|---|---|---|',
  '| 0:00–0:04 | | | For cafés | Request a quote in a minute | | title |',
  '| 0:04–0:16 | Discover | Hover a lot, scroll to the fresh arrivals, open Selowa Ridge: its tasting notes, its 5 kg price | Discover | Award-winning lots and fresh arrivals, roasted to order. | shop:/ | |',
  '| 0:16–0:28 | Request | Request a quote: three bags of 5 kg, whole bean | Request a quote | Choose the quantity, the bag size and the grind. | | |',
  '| 0:28–0:46 | Delivery | A window from 10 to 24 January, a note for the roaster, a look at the estimate, Send; the confirmation “Quote request sent” | Delivery | Pick your delivery window and leave a note for the roaster. | | |',
  '| 0:46–0:58 | Quotes | The quotes page: every request in one place; open an accepted proposal | Your quotes | Every request and proposal, in one place. | shop:/quotes | |',
  '| 0:58–1:03 | | | | From request to proposal, in one place. | | outro |',
].join('\n');

/** An invented mark: plain shapes in the accent (no script, link or external file). */
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="240" height="240"><circle cx="60" cy="60" r="56" fill="${COLORS.accent}"/><ellipse cx="60" cy="60" rx="22" ry="34" fill="${COLORS.paper}"/><path d="M60 28 C50 48 70 72 60 92" stroke="${COLORS.accent}" stroke-width="6" fill="none"/></svg>\n`;

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Block[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Json = Record<string, unknown>;
interface Element {
  mark: number;
  in: string;
  action: string | null;
  untrusted: { name: string; role: string; href_path: string | null; target: unknown; target_yaml: string | null; hint: { step: Json; yaml: string } | null };
}
interface Inspection {
  status: string;
  at: string;
  replay: { steps_done: number; steps_total: number; skipped_irreversible: number };
  popups: Array<{ kind: string }>;
  files: { marked: string | null };
  untrusted: { elements: Element[]; targets_checked?: Array<{ count: number }> };
}
type Event = { phase: string; kind: 'call'; name: string; args: Json; data: Json } | { phase: string; kind: 'write'; file: string };

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let root: string;
let client: Client;
let tools: string[] = [];
let stderr = '';
let phase = '';
let projectYamlSha = '';
const asked: string[] = [];
const log: Event[] = [];
const mutations: number[] = [];
const ids: { run1?: string; run2?: string; render1?: string; render2?: string; comment?: string; replyHash?: string; plan1?: Json } = {};
/** The steps of the scenario the agent writes, scene by scene (YAML flow lines), and the draft it starts from. */
const steps: Record<string, string[]> = { discover: [], request: [], delivery: [], quotes: [] };
let draft: Json = {};

const projectDir = () => join(root, 'projects', PROJECT);
const data = <T>(r: Result) => r.structuredContent as T;
const images = (r: Result) => r.content.filter((b) => b.type === 'image');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

async function call(name: string, args: Json): Promise<Result> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as Result;
  expect(r.isError, `${name}: ${r.content[0]?.text} ${JSON.stringify(r.structuredContent ?? {}).slice(0, 2000)}`).toBeFalsy();
  log.push({ phase, kind: 'call', name, args, data: r.structuredContent ?? {} });
  return r;
}

/** What the agent writes with its own file tools (a component's code, once the user agreed). */
async function write(file: string, text: string): Promise<void> {
  await writeFile(file, text);
  log.push({ phase, kind: 'write', file: file.slice(root.length + 1) });
}

/** Call a long-polling status tool until `done` says it finished (25 s per call). */
async function follow(name: string, args: Json, done: (r: Result) => boolean, rounds = 40): Promise<Result> {
  let r = await call(name, { ...args, wait_s: 25 });
  for (let i = 0; i < rounds && !done(r); i++) r = await call(name, { ...args, wait_s: 25 });
  expect(done(r), r.content[0].text).toBe(true);
  return r;
}

const jobDone = (x: Result) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(data<{ job?: { state: string }; state?: string }>(x).job?.state ?? data<{ state?: string }>(x).state ?? '');
/** A job tool's result, followed through job_status when it outlives its wait. */
async function job(r: Result): Promise<Result> {
  return jobDone(r) ? r : follow('job_status', { job_id: data<{ job: { id: string } }>(r).job.id, detail: 'full' }, jobDone);
}
const runDone = (x: Result) => data<{ finished?: boolean }>(x).finished === true;

async function keep(sub: string, files: string[]): Promise<void> {
  if (!KEEP) return;
  const dir = join(KEEP, sub);
  await mkdir(dir, { recursive: true });
  for (const f of files) await cp(f, join(dir, f.split('/').pop()!));
}

async function health(): Promise<number> {
  return ((await (await fetch(`${fixture.urls.console}/api/health`)).json()) as { mutations: number }).mutations;
}

/** page_inspect, followed through job_status when it outlives its wait; the marked screenshot kept. */
async function inspect(args: Json, keepAs: string): Promise<Inspection> {
  // `detail: "full"` (L5.8): the acceptance reads each element's verified target and its hint's step object.
  const r = await job(await call('page_inspect', { project: PROJECT, wait_s: 25, detail: 'full', ...args }));
  const d = r.structuredContent as unknown as Inspection;
  expect(d.status, r.content[0].text).toBe('ok');
  if (KEEP && d.files.marked) {
    await mkdir(join(KEEP, 'inspect'), { recursive: true });
    await cp(d.files.marked, join(KEEP, 'inspect', `${keepAs}.jpg`));
  }
  return d;
}

/** The element the agent wants, by its (untrusted) name — the way a model reads the list. */
function pick(d: Inspection, test: (e: Element) => boolean, what: string): Element {
  const e = d.untrusted.elements.find(test);
  expect(e, `no element for ${what} among ${d.untrusted.elements.map((x) => `${x.in}/${x.untrusted.role}/${x.untrusted.name}`).join(' | ')}`).toBeDefined();
  expect(e!.untrusted.hint?.yaml, `no step hint for ${what}`).toBeTruthy();
  return e!;
}
const hint = (e: Element) => e.untrusted.hint!.step;
/** A hover on an element's verified target. */
const hoverOf = (e: Element, ms: number) => ({ hover: typeof e.untrusted.target === 'string' ? { text: e.untrusted.target, ms } : { ...(e.untrusted.target as Json), ms } });

/** The scenario as the agent writes it: the draft's title, intro, outro and captions; the steps it wrote. */
function scenarioYaml(): string {
  const scenes = (draft.scenes as Json[]).map((s) => s as { id: string; caption?: unknown; page?: string; open?: string });
  const lines = ['version: 1', `video: ${SCENARIO}`, `title: ${flowYaml(draft.title)}`, `intro: ${flowYaml(draft.intro)}`, `outro: ${flowYaml(draft.outro)}`, 'scenes:'];
  for (const s of scenes) {
    if (!steps[s.id].length) continue;
    lines.push(`  - id: ${s.id}`, `    caption: ${flowYaml(s.caption)}`);
    if (s.page) lines.push(`    page: ${s.page}`, `    open: ${s.open}`);
    lines.push('    steps:', ...steps[s.id].map((x) => `      - ${x}`));
  }
  return `${lines.join('\n')}\n`;
}

let hash: string | null = null;
/** Validate (fix nothing: it must be valid), then save with the hash the last get / save returned. */
async function validateAndSave(yaml: string): Promise<void> {
  const v = await call('scenario_validate', { project: PROJECT, yaml, name: SCENARIO });
  expect(v.content[0].text, yaml).toMatch(/^Valid/);
  const s = await call('scenario_save', { project: PROJECT, name: SCENARIO, yaml, if_match: hash });
  hash = data<{ hash: string }>(s).hash;
}

/** The tools a skill's sections name (backticked tool names). */
async function skillTools(skill: string, headings: string[]): Promise<Set<string>> {
  const text = await readFile(join(REPO, 'skills', skill, 'SKILL.md'), 'utf8');
  const out = new Set<string>();
  for (const h of headings) {
    const at = text.indexOf(`\n## ${h}`);
    expect(at, `${skill}: no section "${h}"`).toBeGreaterThan(0);
    const end = text.indexOf('\n## ', at + 4);
    const section = text.slice(at, end < 0 ? undefined : end);
    for (const m of section.matchAll(/`([a-z_]+)[ `]/g)) if (tools.includes(m[1])) out.add(m[1]);
  }
  return out;
}

/**
 * The phase's calls: the rules the skills state hold over the story so far, the exact sequence of non-polling calls
 * (writes as `write:<file>`), and each tool named by the phase's skill sections.
 */
async function checkPhase(p: string, expected: string[], skills: Array<[string, string[]]>): Promise<void> {
  expect(ruleProblems(log), `${p}: the rules the skills state`).toEqual([]);
  const events = log.filter((e) => e.phase === p);
  const seq = events.filter((e) => e.kind === 'write' || !POLLING.has(e.name)).map((e) => (e.kind === 'write' ? `write:${e.file.split('/').pop()}` : e.name));
  expect(seq, `${p}: the calls in order`).toEqual(expected);
  const named = new Set<string>();
  for (const [skill, headings] of skills) for (const t of await skillTools(skill, headings)) named.add(t);
  const used = [...new Set(events.flatMap((e) => (e.kind === 'call' ? [e.name] : [])))];
  expect(
    used.filter((t) => !named.has(t)),
    `${p}: tools its skill sections do not name`,
  ).toEqual([]);
}

/** The rules the skills state, checked over every call of the story. Returns the broken ones. */
function ruleProblems(events: Event[]): string[] {
  const out: string[] = [];
  // 1. Every write to a component's code is followed by component_validate (ok) before the next component_preview of it.
  let unvalidated: string | undefined;
  // 2. if_match: a save of an existing scenario passes the hash the previous get or save returned; a new one passes null.
  let known: string | null = null;
  // 3. A save passes the text last validated (or the draft scenario_from_script returned, which it validated).
  let validated: string | undefined;
  // 4. After a scenario_save, no render until a run_capture made after it succeeded; a render is of the newest capture
  //    (its run_id, from the render tool's data).
  let saved = false;
  const capturesSinceSave = new Set<string>();
  let lastCapture: string | undefined;
  const renderRuns = new Map<string, string>();
  // 5. comment_resolve passes the hash comment_reply returned and a render of the newest capture.
  let replyHash: string | undefined;
  events.forEach((e, i) => {
    const where = `#${i} ${e.phase} ${e.kind === 'call' ? e.name : `write ${e.file}`}`;
    if (e.kind === 'write') {
      if (/^components\//.test(e.file)) unvalidated = e.file;
      return;
    }
    const a = e.args;
    const d = e.data;
    switch (e.name) {
      case 'component_validate':
        if (d.ok === true) unvalidated = undefined;
        break;
      case 'component_preview':
        if (unvalidated && a.component === COMPONENT) out.push(`${where}: ${unvalidated} written and not validated before this preview`);
        break;
      case 'scenario_validate':
        if (d.ok === true) validated = a.yaml as string;
        break;
      case 'scenario_from_script':
        validated = d.yaml as string;
        break;
      case 'scenario_get':
        known = d.hash as string;
        break;
      case 'scenario_save':
        if ((a.if_match ?? null) !== known) out.push(`${where}: if_match ${String(a.if_match)} is not the last hash ${String(known)}`);
        if (a.yaml !== validated) out.push(`${where}: saves a text that was not validated`);
        known = d.hash as string;
        saved = true;
        capturesSinceSave.clear();
        break;
      case 'run_capture':
        capturesSinceSave.add(d.id as string);
        break;
      case 'run_status':
        if (d.mode === 'capture' && d.status === 'succeeded') {
          lastCapture = d.id as string;
          if (capturesSinceSave.has(d.id as string)) saved = false;
        }
        break;
      case 'render': {
        const run = typeof d.run_id === 'string' ? d.run_id : undefined;
        if (saved) out.push(`${where}: a render after a scenario_save before a new capture succeeded`);
        else if (run !== lastCapture) out.push(`${where}: renders run ${String(run)}, not the newest capture ${String(lastCapture)}`);
        renderRuns.set(d.render_id as string, run ?? '');
        break;
      }
      case 'comment_reply':
        replyHash = d.hash as string;
        break;
      case 'comment_resolve':
        if (a.if_match !== replyHash) out.push(`${where}: if_match is not the hash comment_reply returned`);
        if (renderRuns.get(a.render_id as string) !== lastCapture) out.push(`${where}: render ${String(a.render_id)} is not a render of the newest capture ${String(lastCapture)}`);
        break;
    }
  });
  return out;
}

/** The hold after the `sent` mark in a run's timeline (s). */
async function sentHold(run: string): Promise<number> {
  const t = JSON.parse(await readFile(join(projectDir(), 'runs', run, 'timeline.json'), 'utf8')) as { events: Array<{ mark?: string; hold?: { t_start: number; t_end: number } }> };
  const e = t.events.find((x) => x.mark === 'sent');
  expect(e?.hold, 'the sent beat has a hold').toBeDefined();
  return e!.hold!.t_end - e!.hold!.t_start;
}

/** A hold measured on a run's timeline: within ±0.25 s of what the scenario asks (a capture's timing jitters). */
function expectAbout(seconds: number, wanted: number): void {
  expect(seconds, `hold ${seconds} s, wanted ${wanted} s ± 0.25`).toBeGreaterThanOrEqual(wanted - 0.25);
  expect(seconds, `hold ${seconds} s, wanted ${wanted} s ± 0.25`).toBeLessThanOrEqual(wanted + 0.25);
}

/** The colour of a still at (40, height / 2), read with ffmpeg. */
function pixel(file: string): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'crop=w=2:h=2:x=40:y=ih/2,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 });
  return [...out.stdout];
}
const near = (a: number[], hex: string, tol: number) => [1, 3, 5].every((o, i) => Math.abs(a[i] - parseInt(hex.slice(o, o + 2), 16)) <= tol);

/** The rule checker bites on each broken rule, on synthetic call logs (runs without the slow gate). */
describe('phase 3 acceptance: the rule checker (L3.8 review L8)', () => {
  const C = (name: string, args: Json = {}, d: Json = {}): Event => ({ phase: 'p', kind: 'call', name, args, data: d });
  const W = (file: string): Event => ({ phase: 'p', kind: 'write', file });
  const captured = (id: string) => [C('run_capture', {}, { id }), C('run_status', {}, { id, mode: 'capture', status: 'succeeded' })];
  const base = [
    C('scenario_validate', { yaml: 'A' }, { ok: true }),
    C('scenario_save', { yaml: 'A', if_match: null }, { hash: 'h1' }),
    ...captured('r1'),
    C('render', {}, { render_id: 'v1', run_id: 'r1' }),
  ];
  const edit = [C('scenario_get', {}, { hash: 'h1' }), C('scenario_validate', { yaml: 'B' }, { ok: true }), C('scenario_save', { yaml: 'B', if_match: 'h1' }, { hash: 'h2' })];
  const reply = C('comment_reply', {}, { hash: 'rh' });
  const cases: Array<[string, Event[], string | null]> = [
    [
      'the story as the skills write it',
      [...base, reply, ...edit, ...captured('r2'), C('render', {}, { render_id: 'v2', run_id: 'r2' }), C('comment_resolve', { if_match: 'rh', render_id: 'v2' })],
      null,
    ],
    ['a render after a save, before any capture', [...base, ...edit, C('render', { run_id: 'r1' }, { render_id: 'v2', run_id: 'r1' })], 'before a new capture succeeded'],
    [
      'a render after a capture started, not succeeded',
      [...base, ...edit, C('run_capture', {}, { id: 'r2' }), C('render', { run_id: 'r2' }, { render_id: 'v2', run_id: 'r2' })],
      'before a new capture succeeded',
    ],
    [
      'a render of the OLD run after a successful re-capture',
      [...base, ...edit, ...captured('r2'), C('render', { run_id: 'r1' }, { render_id: 'v2', run_id: 'r1' })],
      'renders run r1, not the newest capture r2',
    ],
    [
      'a dry run instead of a capture',
      [...base, ...edit, C('run_dry', {}, { id: 'd2' }), C('run_status', {}, { id: 'd2', mode: 'dry', status: 'succeeded' }), C('render', {}, { render_id: 'v2', run_id: 'r1' })],
      'before a new capture succeeded',
    ],
    ['a render whose data names no run', [...captured('r1'), C('render', { run_id: 'r1' }, { render_id: 'v1' })], 'renders run undefined'],
    ['a stale if_match', [...base, C('scenario_validate', { yaml: 'B' }, { ok: true }), C('scenario_save', { yaml: 'B', if_match: 'stale' }, { hash: 'h2' })], 'is not the last hash h1'],
    ['a save of a text never validated', [...base, C('scenario_get', {}, { hash: 'h1' }), C('scenario_save', { yaml: 'C', if_match: 'h1' }, { hash: 'h2' })], 'saves a text that was not validated'],
    [
      'a save after a failed validation',
      [C('scenario_validate', { yaml: 'A' }, { ok: false }), C('scenario_save', { yaml: 'A', if_match: null }, { hash: 'h1' })],
      'saves a text that was not validated',
    ],
    ['a component preview after a code write, not validated', [W('components/x/index.tsx'), C('component_preview', { component: COMPONENT })], 'not validated before this preview'],
    [
      'a component preview after a failed validation',
      [W('components/x/index.tsx'), C('component_validate', {}, { ok: false }), C('component_preview', { component: COMPONENT })],
      'not validated before this preview',
    ],
    ['a resolve naming the render of the old run', [...base, reply, ...edit, ...captured('r2'), C('comment_resolve', { if_match: 'rh', render_id: 'v1' })], 'is not a render of the newest capture r2'],
    ["a resolve with the thread's hash, not the reply's", [...base, reply, C('comment_resolve', { if_match: 'threadhash', render_id: 'v1' })], 'if_match is not the hash comment_reply returned'],
  ];
  it.each(cases)('%s', (_name, events, problem) => {
    const found = ruleProblems(events);
    if (problem === null) expect(found).toEqual([]);
    else expect(found.join('\n')).toContain(problem);
  });

  it('a hold measured on the timeline passes within ±0.25 s, not beyond (review L10: ±0.05 s was brittle)', () => {
    for (const s of [0.76, 1, 1.06, 1.24]) expectAbout(s, 1);
    for (const s of [0.74, 1.26]) expect(() => expectAbout(s, 1)).toThrow();
  });
});

describe.skipIf(!ENABLED)(
  'phase 3 acceptance through MCP: README → project → script → scenario → theme → component → capture → render → review → comment → re-capture → resolve (RETAKE_TEST_SLOW=1)',
  () => {
    beforeAll(async () => {
      const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
      fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
      // An empty workspace: retake.yaml, an empty templates/ (the starters still resolve), the user's brand/ files.
      root = await mkdtemp(join(tmpdir(), 'studio-mcp-phase3-'));
      await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
      await mkdir(join(root, 'templates'), { recursive: true });
      await mkdir(join(root, 'brand'), { recursive: true });
      await writeFile(join(root, 'brand', 'roastery-mark.svg'), LOGO);
      // The user's font files (the starters' OFL fonts under other names): a display face, a text family.
      await cp(join(TEMPLATES, 'motion', 'fonts', 'SpaceGrotesk-Bold.ttf'), join(root, 'brand', 'Roastery-Display-Bold.ttf'));
      for (const w of ['Regular', 'SemiBold', 'Bold']) await cp(join(TEMPLATES, 'default', 'fonts', `Inter-${w}.ttf`), join(root, 'brand', `Roastery-Text-${w}.ttf`));
      await linkSharedCache(root);
      // The session's folder is the workspace (engine_info checks it), tsx loaded by its path.
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--conditions=source', '--import', TSX, BIN, '--root', root, 'mcp'],
        cwd: root,
        env: testChildEnv({ RETAKE_HOME: join(root, '.home'), RETAKE_WORKER_IDLE_MS: '5000' }),
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      // A client that can show approval forms: every request is recorded and declined — none may come in this chain.
      client = new Client({ name: 'retake-phase3-acceptance', version: '0' }, { capabilities: { elicitation: { form: {} } } });
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        asked.push((req.params as { message: string }).message);
        return { action: 'decline' };
      });
      await client.connect(transport);
      tools = (await client.listTools()).tools.map((t) => t.name);
      mutations.push(await health());
    }, 120_000);

    afterAll(async () => {
      await client?.close().catch(() => undefined);
      const w = root ? readWorkerLock(root) : null;
      if (w) {
        try {
          process.kill(w.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      await fixture?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });

    it(
      'R-ACC3-01: a project created from the README the user hands (project_create on an empty workspace)',
      async () => {
        phase = 'project';
        const info = data<{ root: string; started_outside_workspace: boolean; projects: number }>(await call('engine_info', {}));
        expect(info).toMatchObject({ started_outside_workspace: false, projects: 0 });
        expect(await call('project_list', {}).then((r) => r.content[0].text)).toMatch(/^No project yet/);
        const text = readme(fixture.urls);
        const env = { local: { shop: fixture.urls.shop.replace(/\/$/, ''), console: fixture.urls.console.replace(/\/$/, '') } };
        const made = data<{ slug: string; dir: string }>(await call('project_create', { name: 'Northfield Roasters', slug: PROJECT, readme: text, environments: env }));
        expect(made).toMatchObject({ slug: PROJECT, dir: projectDir() });
        const got = data<{ readme: string; readme_hash: string; scenarios: string[]; environments: Array<{ name: string; access: string; production?: boolean; pages: Record<string, unknown> }> }>(
          await call('project_get', { project: PROJECT }),
        );
        expect(got.readme).toBe(text);
        expect(got.readme_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(got.scenarios).toEqual([]);
        expect(got.environments).toEqual([expect.objectContaining({ name: 'local', access: 'read-write' })]);
        expect(Object.keys(got.environments[0].pages).sort()).toEqual(['console', 'shop']);
        expect(readdirSync(projectDir()).sort()).toEqual(['.gitignore', 'README.md', 'assets', 'hooks', 'project.yaml', 'scenarios']);
        projectYamlSha = sha(await readFile(join(projectDir(), 'project.yaml')));
        await checkPhase('project', ['engine_info', 'project_list', 'project_create', 'project_get'], [['retake-scenario', ['Before you start']]]);
      },
      STEP,
    );

    it('R-ACC3-02: a scenario from the timecoded script, its beats rewritten from page_inspect hints; run_dry; nothing written to the product', async () => {
      phase = 'scenario';
      // The aid: an outline and a skeleton that validates (one hold per beat, the action as its note).
      const r = await call('scenario_from_script', { project: PROJECT, script_markdown: SCRIPT, name: SCENARIO });
      const d = data<{ yaml: string; validation: { ok: boolean }; outline: { scenes: Array<{ id?: string; page?: string; path?: string }> } }>(r);
      expect(d.validation.ok, r.content[0].text).toBe(true);
      expect(d.outline.scenes.map((s) => [s.id, s.page ?? null, s.path ?? null])).toEqual([
        ['discover', 'shop', '/'],
        ['request', null, null],
        ['delivery', null, null],
        ['quotes', 'shop', '/quotes'],
      ]);
      draft = parseYaml(d.yaml).value as Json;
      expect(draft).toMatchObject({ title: { kicker: 'For cafés', text: 'Request a quote in a minute' }, outro: { tagline: 'From request to proposal, in one place.' } });

      // Discover: the shop's home — a lot to hover, the lot to open (their hints), a scroll target checked first.
      const home = await inspect({ page: 'shop', path: '/' }, '1-home');
      const geisha = pick(home, (e) => e.untrusted.name.includes('Finca Lirandel'), 'the Finca Lirandel card');
      const lot = pick(home, (e) => e.untrusted.name.includes('Selowa Ridge'), 'the Selowa Ridge card');
      const checked = await inspect({ page: 'shop', path: '/', targets: ['Fresh arrivals'] }, '1-home-targets');
      expect(checked.untrusted.targets_checked?.[0]?.count, 'Fresh arrivals resolves to one element').toBe(1);
      steps.discover.push(flowYaml(hoverOf(geisha, 700)), flowYaml({ scroll: { to: { text: 'Fresh arrivals' }, offset: -100, duration: 1.6 } }), flowYaml(hint(lot)));
      await validateAndSave(scenarioYaml());

      // The product page the click opens: wait for its "Request a quote" button, hold; the request scene starts on it.
      // Two targets the agent writes itself from the script (a tasting note, the 5 kg price), checked on that page.
      const product = await inspect({ scenario: SCENARIO, until: 'discover.2', targets: ['Bergamot', '5 kg bags'] }, '2-product');
      expect(product.at).toBe('until');
      expect(
        product.untrusted.targets_checked?.map((t) => t.count),
        'each target resolves to one element',
      ).toEqual([1, 1]);
      const raq = pick(product, (e) => e.untrusted.role === 'button' && e.untrusted.name === 'Request a quote', 'Request a quote');
      steps.discover.push(
        flowYaml({ wait_for: { target: raq.untrusted.target } }),
        flowYaml({ hover: { text: 'Bergamot', ms: 900 } }),
        flowYaml({ hover: { text: '5 kg bags', ms: 900 } }),
        flowYaml({ hold: 2.5 }),
      );
      steps.request.push(flowYaml(hint(raq)));
      await validateAndSave(scenarioYaml());

      // The quote dialog: its fields first, with label targets.
      const dialog = await inspect({ scenario: SCENARIO, until: 'request.0' }, '3-dialog');
      expect(dialog.popups[0]?.kind).toBe('dialog');
      const inDialog = (name: string) => (e: Element) => e.in === 'dialog' && e.untrusted.name === name;
      const increase = pick(dialog, inDialog('Increase'), 'Increase');
      const select = (field: string) => pick(dialog, (e) => e.in === 'dialog' && e.action === 'select' && JSON.stringify(e.untrusted.hint?.step ?? {}).includes(field), field);
      const fill = (e: Element, option: string) => ({ select: { ...(hint(e).select as Json), option } });
      steps.request.push(flowYaml(hint(increase)), flowYaml(hint(increase)), flowYaml(fill(select('Bag size'), '5 kg')), flowYaml(fill(select('Grind'), 'Whole bean')), flowYaml({ hold: 3 }));
      const window = pick(dialog, inDialog('Delivery window'), 'Delivery window');
      const message = pick(dialog, (e) => e.in === 'dialog' && e.action === 'type' && e.untrusted.target_yaml === '{ label: Message }', 'Message');
      const send = pick(dialog, (e) => e.in === 'dialog' && e.untrusted.role === 'button' && e.untrusted.name === 'Send request', 'Send request');
      steps.delivery.push(flowYaml(hint(window)));
      await validateAndSave(scenarioYaml());

      // The calendar the field opens: the next month, then the window's two days.
      const calendar = await inspect({ scenario: SCENARIO, until: 'delivery.0' }, '4-calendar');
      steps.delivery.push(flowYaml(hint(pick(calendar, (e) => e.untrusted.name === 'Next month', 'Next month'))));
      await validateAndSave(scenarioYaml());
      // The days of January, and the estimate the viewer reads before sending (a target the agent writes, checked).
      const january = await inspect({ scenario: SCENARIO, until: 'delivery.1', targets: ['Estimated'] }, '5-january');
      expect(january.untrusted.targets_checked?.[0]?.count, 'the estimate resolves to one element').toBe(1);
      const day = (n: number) => pick(january, (e) => e.untrusted.role === 'button' && new RegExp(`^(\\w+, )?${n} January 2027$`).test(e.untrusted.name), `${n} January`);
      steps.delivery.push(flowYaml(hint(day(10))), flowYaml(hint(day(24))));
      // The note (its hint, text filled in), Send — irreversible, as the skill says —, then its confirmation from the
      // script (a replay never sends), marked and held in the same scene.
      const typed = hint(message) as { type: Json };
      steps.delivery.push(
        flowYaml({ type: { ...typed.type, text: 'Light roast for filter, please. Deliveries before 9 am, at the back door; we are closed on Mondays.', cps: 18 } }),
        flowYaml({ hover: { text: 'Estimated', ms: 1500 } }),
        flowYaml({ ...hint(send), irreversible: true }),
        flowYaml({ wait_for: { text: 'Quote request sent' }, mark: 'sent', hold: 1 }),
      );
      await validateAndSave(scenarioYaml());
      // A replay up to Send shows it without sending it.
      const sendAt = steps.delivery.length - 2;
      const atSend = await inspect({ scenario: SCENARIO, until: `delivery.${sendAt}` }, '6-send');
      expect(atSend.replay.skipped_irreversible).toBe(1);

      // The quotes page (read-only): the list held where the viewer reads, then an accepted proposal opened.
      const quotes = await inspect({ page: 'shop', path: '/quotes' }, '7-quotes');
      const row = pick(quotes, (e) => e.untrusted.role === 'link' && /Mountfern AA/.test(e.untrusted.name) && /Accepted/.test(e.untrusted.name), 'the accepted Mountfern AA quote');
      steps.quotes.push(
        flowYaml({ wait_for: { target: row.untrusted.target } }),
        flowYaml({ hold: 3 }),
        flowYaml(hint(row)),
        flowYaml({ wait_for: { url: row.untrusted.href_path } }),
        flowYaml({ hold: 5.5 }),
      );
      await validateAndSave(scenarioYaml());

      // The saved file: real steps only (no note hold left), the script's captions, Send irreversible.
      const saved = await readFile(join(projectDir(), 'scenarios', `${SCENARIO}.yaml`), 'utf8');
      expect(saved).toBe(scenarioYaml());
      expect(saved).not.toMatch(/note:/);
      const value = parseYaml(saved).value as { scenes: Array<{ id: string; caption: { text: string }; steps: Json[] }> };
      expect(value.scenes.map((s) => s.caption.text)).toEqual([
        'Award-winning lots and fresh arrivals, roasted to order.',
        'Choose the quantity, the bag size and the grind.',
        'Pick your delivery window and leave a note for the roaster.',
        'Every request and proposal, in one place.',
      ]);
      const sendStep = value.scenes.find((s) => s.id === 'delivery')!.steps[sendAt] as { click: unknown; irreversible: boolean };
      expect(JSON.stringify(sendStep.click)).toContain('Send request');
      expect(sendStep.irreversible).toBe(true);
      if (KEEP) await writeFile(join(KEEP, `${SCENARIO}-1.yaml`), saved);

      // The dry run: every step resolves; Send is shown, not executed, the scene stops there and the next one continues.
      const dry = await follow('run_status', { project: PROJECT, run_id: data<{ id: string }>(await call('run_dry', { project: PROJECT, scenario: SCENARIO, wait_s: 25 })).id }, runDone);
      const run = data<{ status: string; steps_done: number; steps_total: number; stopped_at: Json }>(dry);
      expect(run.status, dry.content[0].text).toBe('succeeded');
      expect(run.stopped_at).toEqual({ scene: 'delivery', step: sendAt, reason: 'irreversible' });
      expect(run.steps_done).toBe(run.steps_total - 1);
      mutations.push(await health());
      expect(mutations[1], 'no write from the inspections or the dry run').toBe(mutations[0]);
      await checkPhase(
        'scenario',
        [
          'scenario_from_script',
          'page_inspect',
          'page_inspect',
          'scenario_validate',
          'scenario_save',
          'page_inspect',
          'scenario_validate',
          'scenario_save',
          'page_inspect',
          'scenario_validate',
          'scenario_save',
          'page_inspect',
          'scenario_validate',
          'scenario_save',
          'page_inspect',
          'scenario_validate',
          'scenario_save',
          'page_inspect',
          'page_inspect',
          'scenario_validate',
          'scenario_save',
          'run_dry',
        ],
        [['retake-scenario', ['The user hands a timecoded script', 'The loop']]],
      );
    }, 1_200_000);

    it(
      'R-ACC3-03: a theme from the brand files and the README colours (unlifted), previewed',
      async () => {
        phase = 'theme';
        const list = await call('template_list', { project: PROJECT });
        expect(data<{ templates: Array<{ name: string }> }>(list).templates.map((t) => t.name)).toEqual(['default', 'editorial', 'motion']);
        const r = await call('template_create_from_brand', {
          name: THEME,
          colors: COLORS,
          logo: 'brand/roastery-mark.svg',
          fonts: { display: 'brand/Roastery-Display-Bold.ttf', body: ['brand/Roastery-Text-Regular.ttf', 'brand/Roastery-Text-SemiBold.ttf', 'brand/Roastery-Text-Bold.ttf'] },
          brand: { name: 'Northfield Roasters', url: 'northfield-roasters.test' },
        });
        const made = data<{
          name: string;
          base: string;
          files: string[];
          palette: { colors: Record<string, string>; adjusted: unknown[]; checks: Array<{ check: string; ok: boolean }> };
          warnings: string[];
        }>(r);
        expect(made).toMatchObject({ name: THEME, base: 'editorial' });
        expect(made.files).toEqual(expect.arrayContaining(['template.yaml', 'logo.svg', 'LICENSES.md']));
        // The README's colours pass the thresholds as they are: nothing lifted, every check ok.
        expect(made.palette.adjusted, r.content[0].text).toEqual([]);
        expect(
          made.palette.checks.filter((c) => !c.ok),
          r.content[0].text,
        ).toEqual([]);
        expect(made.palette.colors).toMatchObject(COLORS);
        expect((await call('template_list', {})).content[0].text).toMatch(new RegExp(`- ${THEME} \\(workspace, real\\)`));
        const pv = await job(await call('template_preview', { project: PROJECT, template: THEME, wait_s: 25 }));
        const stills = data<{ stills: Array<{ kind: string; file: string; bytes: number }> }>(pv).stills;
        expect(stills.map((s) => s.kind)).toEqual(['intro', 'layout', 'card', 'interstitial', 'outro']);
        expect(images(pv).length).toBeGreaterThanOrEqual(1);
        // The palette drawn: the interstitial on the README's dark tone, the outro on (a tint of) its paper.
        expect(near(pixel(stills.find((s) => s.kind === 'interstitial')!.file), COLORS.dark, 6)).toBe(true);
        expect(near(pixel(stills.find((s) => s.kind === 'outro')!.file), COLORS.paper, 14)).toBe(true);
        await keep(
          'theme',
          stills.map((s) => s.file),
        );
        await checkPhase(
          'theme',
          ['template_list', 'template_create_from_brand', 'template_list', 'template_preview'],
          [['retake-theme', ['Before you start', 'Entry A: brand files (preferred)', 'Then, for both entries']]],
        );
      },
      STEP,
    );

    it(
      'R-ACC3-04: a component through the skill — look first, scaffold, the kit example, validate after each code write, preview in the new theme, iterate',
      async () => {
        phase = 'component';
        // Look first.
        expect((await call('component_list', { kind: 'intro' })).content[0].text).toContain('studio/intro-stack');
        expect((await call('component_get', { component: 'studio/intro-stack' })).content[0].text).toContain('slots:');
        const existing = await job(await call('component_preview', { project: PROJECT, component: 'studio/intro-stack', template: THEME, wait_s: 25 }));
        expect(images(existing)).toHaveLength(1);
        // Create: the scaffold, then the kit reference's example (what the skill hands Claude) as the user agreed.
        const made = data<{ id: string; dir: string }>(await call('component_create', { id: COMPONENT, kind: 'intro', description: 'Logo on the left, title on the right.' }));
        expect(made).toMatchObject({ id: COMPONENT, dir: join(root, 'components', 'northfield', 'intro-split') });
        const kit = await readFile(join(REPO, 'skills', 'retake-component', 'reference', 'kit.md'), 'utf8');
        const blocks = [...kit.matchAll(/```(yaml|tsx)\n([\s\S]*?)```/g)];
        const manifest = blocks.find((b) => b[1] === 'yaml')![2].replace('acme/intro-split', COMPONENT);
        const code = blocks.find((b) => b[1] === 'tsx')![2];
        await write(join(made.dir, 'component.yaml'), manifest);
        await write(join(made.dir, 'index.tsx'), code);
        expect(data<{ ok: boolean }>(await call('component_validate', { component: COMPONENT })).ok).toBe(true);
        // Previews in the user's new theme (the project's own is still the default one: template names it).
        const a = await job(await call('component_preview', { project: PROJECT, component: COMPONENT, template: THEME, wait_s: 25 }));
        expect(images(a)).toHaveLength(1);
        const stillsOf = (x: Result) => data<{ stills?: Array<{ file: string }> }>(x).stills?.map((s) => s.file) ?? [];
        expect(near(pixel(stillsOf(a)[0]), COLORS.paper, 14), "the still is on the theme's paper").toBe(true);
        // Iterate on the code: the logo larger.
        const v2 = code.replace('size={96}', 'size={150}');
        expect(v2).not.toBe(code);
        await write(join(made.dir, 'index.tsx'), v2);
        expect(data<{ ok: boolean }>(await call('component_validate', { component: COMPONENT })).ok).toBe(true);
        const b = await job(await call('component_preview', { project: PROJECT, component: COMPONENT, template: THEME, wait_s: 25 }));
        expect(images(b)).toHaveLength(1);
        expect(sha(images(b)[0].data!), 'the code change shows in the still').not.toBe(sha(images(a)[0].data!));
        // One still in another theme: it adapts.
        const other = await job(await call('component_preview', { project: PROJECT, component: COMPONENT, template: 'editorial', wait_s: 25 }));
        expect(images(other)).toHaveLength(1);
        await keep('component/intro-stack', stillsOf(existing));
        await keep('component/a', stillsOf(a));
        await keep('component/b', stillsOf(b));
        await keep('component/editorial', stillsOf(other));
        await checkPhase(
          'component',
          [
            'component_list',
            'component_get',
            'component_preview',
            'component_create',
            'write:component.yaml',
            'write:index.tsx',
            'component_validate',
            'component_preview',
            'write:index.tsx',
            'component_validate',
            'component_preview',
            'component_preview',
          ],
          [['retake-component', ['Look first: an existing component may already do it', 'Create one']]],
        );
      },
      STEP,
    );

    it(
      'R-ACC3-05: capture, plan (≥ 60 s, the component as the intro), render with the new theme and the component, review clean',
      async () => {
        phase = 'film';
        const cap = await call('run_capture', { project: PROJECT, scenario: SCENARIO });
        ids.run1 = data<{ id: string }>(cap).id;
        const st = await follow('run_status', { project: PROJECT, run_id: ids.run1 }, runDone);
        expect(data<{ status: string }>(st).status, st.content[0].text).toBe('succeeded');
        mutations.push(await health());
        expect(mutations[2] - mutations[1], 'the capture sent the request').toBeGreaterThanOrEqual(1);
        expectAbout(await sentHold(ids.run1), 1);
        const args = { project: PROJECT, scenario: SCENARIO, run_id: ids.run1, template: THEME, overrides: { components: { intro: COMPONENT } } };
        const plan = await call('plan_preview', args);
        const p = data<{ duration_s: number; theme: string; scenario_changed?: boolean; segments: Array<{ kind: string; component: string; scene?: string; duration_s: number }> }>(plan);
        expect(
          p.duration_s,
          `the video is too short for a clean review: ${plan.content[0].text}\n${p.segments.map((g) => `${g.kind} ${g.scene ?? ''} ${g.duration_s} s`).join(', ')}`,
        ).toBeGreaterThanOrEqual(60);
        expect(p.theme).toBe(THEME);
        expect(p.scenario_changed).toBe(false);
        expect(plan.content[0].text).not.toContain('changed since');
        expect(p.segments[0]).toMatchObject({ kind: 'intro', component: COMPONENT });
        ids.plan1 = p as unknown as Json;
        const r = await call('render', args);
        ids.render1 = data<{ render_id: string }>(r).render_id;
        const rs = await follow('render_status', { project: PROJECT, render_id: ids.render1 }, runDone);
        const view = data<{ status: string; file: string; record: { template: string; run_id: string }; untrusted: { warnings: string[] } }>(rs);
        expect(view.status, rs.content[0].text).toBe('succeeded');
        expect(view.record).toMatchObject({ template: THEME, run_id: ids.run1 });
        expect(view.untrusted.warnings.filter((w) => w.startsWith('the render blocked'))).toEqual([]);
        const rv = await call('review', { project: PROJECT, render_id: ids.render1, wait_s: 25, detail: 'full' });
        const done = data<{ finished: boolean }>(rv).finished ? rv : await follow('review_get', { project: PROJECT, render_id: ids.render1, detail: 'full' }, runDone);
        const v = data<{ clean: boolean; counts: Record<string, number>; files: { sheets: string[]; keyframes: Record<string, string> } }>(done);
        expect(v.clean, done.content[0].text).toBe(true);
        expect(images(done).length).toBeGreaterThanOrEqual(1);
        expect(Object.keys(v.files.keyframes)).toEqual(expect.arrayContaining(['intro-hold', 'sent', 'outro-hold']));
        expect(near(pixel(v.files.keyframes['intro-hold']), COLORS.paper, 14), "the intro on the theme's paper").toBe(true);
        await keep('render1', [...v.files.sheets, ...Object.values(v.files.keyframes), view.file]);
        await checkPhase(
          'film',
          ['run_capture', 'plan_preview', 'render', 'review'],
          [
            ['retake-scenario', ['The loop']],
            ['retake-component', ['Create one']],
            ['retake-theme', ['Then, for both entries']],
          ],
        );
      },
      STEP,
    );

    it(
      'R-ACC3-06: a person comments a frame → the scenario adapted → re-captured → rendered → reviewed → replied → resolved; no approval asked',
      async () => {
        phase = 'comment';
        // The person, in their own terminal.
        const out = execFileSync(
          process.execPath,
          [
            '--conditions=source',
            '--import',
            TSX,
            BIN,
            '--root',
            root,
            'comment',
            'add',
            PROJECT,
            ids.render1!,
            '--marker',
            'sent',
            '--region',
            '0.72,0.73,0.18,0.11',
            '--json',
            'Keep the confirmation on screen longer',
          ],
          { cwd: root, env: testChildEnv({ RETAKE_HOME: join(root, '.home'), RETAKE_AUTHOR: 'Reviewer' }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const added = JSON.parse(out) as { thread: { id: string }; warnings: string[] };
        expect(added.warnings).toEqual([]);
        ids.comment = added.thread.id;

        // The agent reads it: the anchor (the marked wait_for of delivery), the still; the text only under untrusted.
        const listed = await call('comments_list', { project: PROJECT, scenario: SCENARIO });
        const t = data<{ threads: Array<{ id: string; still: string; anchor: { step_ref: string; action: string; marker: string; scene: string }; untrusted: { text: string } }> }>(listed).threads;
        expect(t).toHaveLength(1);
        expect(t[0]).toMatchObject({
          id: ids.comment,
          anchor: { scene: 'delivery', step_ref: `delivery.${steps.delivery.length - 1}`, action: 'wait_for', marker: 'sent' },
          untrusted: { text: 'Keep the confirmation on screen longer' },
        });
        expect(listed.content[0].text).not.toContain('confirmation on screen');
        expect(listed.content[0].text).toContain('shows only in a new capture: run_capture');
        expect(images(listed)).toHaveLength(1);
        await keep('comment', [t[0].still]);

        // The change: the hold of the anchored step, 1 s → 3 s (scenario_get first, validate, save with its hash).
        const got = await call('scenario_get', { project: PROJECT, name: SCENARIO });
        hash = data<{ hash: string }>(got).hash;
        const before = data<{ yaml: string }>(got).yaml;
        const at = Number(t[0].anchor.step_ref.split('.')[1]);
        expect(steps.delivery[at]).toBe('{ wait_for: { text: Quote request sent }, mark: sent, hold: 1 }');
        steps.delivery[at] = steps.delivery[at].replace('hold: 1 }', 'hold: 3 }');
        const after = scenarioYaml();
        expect(after).toBe(before.replace('mark: sent, hold: 1 }', 'mark: sent, hold: 3 }'));
        await validateAndSave(after);
        if (KEEP) await writeFile(join(KEEP, `${SCENARIO}-2.yaml`), after);

        // A plan of the old run says the render would show the run as captured (the trusted line, the flag).
        const args = { project: PROJECT, scenario: SCENARIO, template: THEME, overrides: { components: { intro: COMPONENT } } };
        const stale = await call('plan_preview', { ...args, run_id: ids.run1 });
        expect(stale.structuredContent).toMatchObject({ scenario_changed: true });
        expect((stale.content[0].text ?? '').split('\n')[1]).toBe(
          scenarioChangedMessage(SCENARIO, ids.run1!, `run_capture {project: "${PROJECT}", scenario: "${SCENARIO}"}`, [`scene delivery: step delivery.${at} changed`]),
        );
        expect((stale.content[0].text ?? '').split('\n').at(-1)).toMatch(/^capture first: run_capture \{/); // never "render it" on the old run (review M1)

        // So: a new capture, then the render.
        ids.run2 = data<{ id: string }>(await call('run_capture', { project: PROJECT, scenario: SCENARIO })).id;
        const st = await follow('run_status', { project: PROJECT, run_id: ids.run2 }, runDone);
        expect(data<{ status: string }>(st).status, st.content[0].text).toBe('succeeded');
        mutations.push(await health());
        expect(mutations[3] - mutations[2], 'each capture writes the same').toBe(mutations[2] - mutations[1]);
        expectAbout(await sentHold(ids.run2), 3);
        const plan = await call('plan_preview', { ...args, run_id: ids.run2 });
        const p2 = data<{ duration_s: number; scenario_changed?: boolean; segments: Array<{ scene?: string; kind: string; duration_s: number }> }>(plan);
        expect(p2.scenario_changed).toBe(false);
        const clip = (p: { segments: Array<{ scene?: string; kind: string; duration_s: number }> }) => p.segments.find((s) => s.kind === 'clip' && s.scene === 'delivery')!.duration_s;
        // The longer confirmation is in the edit whole, at 1×: no cut or speed-up of the plan touches the 3 s hold of the new
        // take. (Comparing the two takes' clip lengths depended on everything else each take did: idle gaps around the
        // threshold, and since L5.7 the freezes a loaded machine adds, which the edit cuts.)
        const tl2 = JSON.parse(await readFile(join(projectDir(), 'runs', ids.run2, 'timeline.json'), 'utf8')) as { events: Array<{ mark?: string; hold?: { t_start: number; t_end: number } }> };
        const hold = tl2.events.find((x) => x.mark === 'sent')!.hold!;
        const summary = data<{ untrusted: { summary: string } }>(plan).untrusted.summary;
        const touched = summary
          .split('\n')
          .filter((l) => l.includes('"delivery"'))
          .flatMap((l) => {
            const span = /(\d+\.\d+) s–(\d+\.\d+) s/.exec(l);
            if (span) return [[Number(span[1]), Number(span[2]), l] as const];
            const at = /(\d+\.\d+) s at (\d+\.\d+) s/.exec(l);
            return at ? [[Number(at[2]), Number(at[2]) + Number(at[1]), l] as const] : [];
          })
          .filter(([a, b]) => a < hold.t_end - 0.05 && b > hold.t_start + 0.05)
          .map(([, , l]) => l);
        expect(touched, 'the delivery clip holds the confirmation longer: nothing of the 3 s hold is cut or sped up').toEqual([]);
        expect(clip(p2), 'the delivery clip holds the confirmation longer').toBeGreaterThan(hold.t_end - hold.t_start);
        const r = await call('render', { ...args, run_id: ids.run2 });
        ids.render2 = data<{ render_id: string }>(r).render_id;
        expect(ids.render2).not.toBe(ids.render1);
        const rs = await follow('render_status', { project: PROJECT, render_id: ids.render2 }, runDone);
        const view = data<{ status: string; file: string; record: { template: string; run_id: string }; untrusted: { warnings: string[] } }>(rs);
        expect(view.status, rs.content[0].text).toBe('succeeded');
        expect(view.record).toMatchObject({ template: THEME, run_id: ids.run2 });
        expect(view.untrusted.warnings.filter((w) => w.startsWith('the render blocked'))).toEqual([]);
        await call('review', { project: PROJECT, render_id: ids.render2, wait_s: 0 });
        const done = await follow('review_get', { project: PROJECT, render_id: ids.render2, detail: 'full' }, runDone);
        const v = data<{ clean: boolean; diff?: { previous: string }; files: { sheets: string[]; keyframes: Record<string, string>; diff_sheet?: string } }>(done);
        expect(v.clean, done.content[0].text).toBe(true);
        expect(v.diff?.previous).toBe(ids.render1);
        await keep('render2', [...v.files.sheets, ...Object.values(v.files.keyframes), ...(v.files.diff_sheet ? [v.files.diff_sheet] : []), view.file]);

        // Reply, then resolve with the new render and the hash the reply returned.
        const reply = await call('comment_reply', { project: PROJECT, comment_id: ids.comment, text: 'Held the confirmation for 3 s instead of 1 s, re-captured and re-rendered.' });
        ids.replyHash = data<{ hash: string }>(reply).hash;
        const res = await call('comment_resolve', { project: PROJECT, comment_id: ids.comment, note: 'The confirmation stays 3 s on screen.', render_id: ids.render2, if_match: ids.replyHash });
        expect(data<{ thread: Json }>(res).thread).toMatchObject({ status: 'resolved', resolution: { via: 'mcp', render_id: ids.render2 } });
        expect(data<{ threads: unknown[] }>(await call('comments_list', { project: PROJECT })).threads).toEqual([]);

        await checkPhase(
          'comment',
          [
            'comments_list',
            'scenario_get',
            'scenario_validate',
            'scenario_save',
            'plan_preview',
            'run_capture',
            'plan_preview',
            'render',
            'review',
            'comment_reply',
            'comment_resolve',
            'comments_list',
          ],
          [['retake-scenario', ['Frame comments on a render', 'The loop']]],
        );
        // No approval was asked; nothing else changed.
        expect(asked).toEqual([]);
        expect(sha(await readFile(join(projectDir(), 'project.yaml')))).toBe(projectYamlSha);
        expect(readdirSync(join(root, 'templates'))).toEqual([THEME]);
        expect(readdirSync(join(root, 'components'))).toEqual(['northfield']);
        expect(readdirSync(join(root, 'components', 'northfield'))).toEqual(['intro-split']);
        expect(existsSync(join(REPO, 'components'))).toBe(false);
        expect(stderr).not.toMatch(/Unhandled|TypeError|cancelRender/i);
      },
      STEP,
    );
  },
);
